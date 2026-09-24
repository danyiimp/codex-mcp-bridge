import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NativeDesktopRelay, resolveRelayThreadId } from './native-relay.mjs';
import { PeerEndpoint, listClaudeSessions, assertClaudeSessionProcess } from './peer-protocol.mjs';
import { ReplyForwarder } from './reply-forwarder.mjs';
import { createRuntimeState } from './runtime-state.mjs';
import { createReloadControl } from './reload-control.mjs';
import { createCrossSessionTasks, buildOaiMessage } from './cross-session-tasks.mjs';
import { readRolloutState } from './rollout-state.mjs';
import { isDesktopRootThreadSource } from './desktop-thread-source.mjs';
import { activeFullAccessRunner } from './full-access-runner.mjs';
import { createClaudeSessions, resolveClaudeProfile, canonicalDirectory, listClaudeAgents } from './claude-session-create.mjs';
import { readClaudeSession } from './claude-session-read.mjs';
import { readProcessAncestry } from './claude-sender-context.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const relay = new NativeDesktopRelay({ timeoutMs: 20000 });
const peer = new PeerEndpoint({ name: `oai-bridge-${process.pid}`, cwd: process.cwd() });
const runtime = createRuntimeState();
let boundSource = null;
const forwarder = new ReplyForwarder({
  minIntervalMs: 5000, maxPerSession: 50,
  deliver: (threadId, record) => relay.sendMessage(threadId,
    `[Сообщение от Claude Code; источник ${record.fromSocket}; ответ на ${record.inReplyTo ?? 'предыдущий обмен'}]\n\n${record.text}`),
});
peer.onMessage(record => {
  const destination = record.replyThreadId ?? boundSource?.threadId;
  if (destination) forwarder.enqueue(record, destination);
});
const reload = createReloadControl({
  entry: 'cross-session-bridge.mjs',
  inspect: () => peer.reloadReason() ?? forwarder.reloadReason(),
  quiesce: () => peer.quiesce(),
  exportState: () => ({ boundSource, peer: peer.exportReloadState(), forwarding: forwarder.exportReloadState() }),
  restore: state => {
    if (state.boundSource !== null && (!uuid.test(state.boundSource?.threadId ?? '') || typeof state.boundSource?.cwd !== 'string')) throw new Error('Invalid bridge sender reload state');
    boundSource = state.boundSource;
    peer.restoreReloadState(state.peer);
    forwarder.restoreReloadState(state.forwarding);
    if (boundSource) peer.cwd = boundSource.cwd;
  },
  activate: () => boundSource ? peer.start() : undefined,
  resume: () => boundSource ? peer.resume() : (peer.reloadPaused = false),
});

function textResult(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function choose(rows, target, idKey, nameKey) {
  const byId = rows.filter(row => row[idKey] === target);
  const matches = byId.length ? byId : rows.filter(row => (row[nameKey] ?? '').normalize('NFC') === target.normalize('NFC'));
  if (matches.length !== 1) throw new Error(matches.length ? 'Несколько сессий имеют это имя. Выберите точный ID из списка.' : 'Сессия не найдена. Сначала получите список; не создавайте замену автоматически.');
  return matches[0];
}
async function native(operation, args) {
  const result = await relay.requestDesktop(operation, args);
  if (!result.ok || result.result?.isError) throw new Error(JSON.stringify(result));
  return result.result;
}
// Codex model choice. The Desktop relay accepts model/thinking on create_thread and
// send_message_to_thread; without them a task runs on the Desktop default model.
// The catalog Codex itself fetched (~/.codex/models_cache.json) is the allowlist, so
// a typo or an account-unavailable slug fails before anything is sent.
// The cache is rewritten by whichever Codex client fetched last (CLI and Desktop see
// different lists), so it is merged with the models this Desktop build is known to serve.
const KNOWN_CODEX_MODELS = new Map([
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
]);
function codexModelCatalog() {
  const catalog = new Map(KNOWN_CODEX_MODELS);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    for (const m of data.models ?? []) catalog.set(m.slug, (m.supported_reasoning_levels ?? []).map(l => l.effort));
  } catch { /* known models only */ }
  return catalog;
}
function assertCodexModel(model, effort) {
  if (model === undefined && effort === undefined) return;
  const catalog = codexModelCatalog();
  if (model !== undefined && !catalog.has(model)) throw new Error(`Unknown Codex model "${model}". Available: ${[...catalog.keys()].join(', ')}. Nothing was sent.`);
  const levels = model !== undefined ? catalog.get(model) : null;
  if (effort !== undefined && levels?.length && !levels.includes(effort)) throw new Error(`Model ${model} does not support effort "${effort}" (supported: ${levels.join(', ')}). Nothing was sent.`);
}
async function oaiList() {
  const response = await native('list_threads', { limit: 50 });
  if (!Array.isArray(response.threads)) throw new Error('Desktop не вернул список задач.');
  const executorId = resolveRelayThreadId().threadId;
  const rows = [...(response.pinnedThreads ?? []), ...response.threads].filter(row => row.kind === 'codex' && row.hostId === 'local' && row.id !== executorId);
  return [...new Map(rows.map(row => [row.id, row])).values()];
}
function claudeList(diagnostics) {
  return listClaudeSessions({ diagnostics }).filter(row => row.pid !== process.pid && row.entrypoint === 'cli');
}
async function claudeSource() {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let ownRegistry;
  try { ownRegistry = fs.realpathSync.native(path.join(config, 'sessions')); }
  catch { throw new Error('Не найден registry вызывающего Claude-профиля.'); }
  const rows = claudeList().filter(row => row.dir === ownRegistry);
  let expectedPid = process.ppid;
  for (const processInfo of await readProcessAncestry({ parentPid: process.ppid, maxDepth: 10 })) {
    if (processInfo.pid !== expectedPid) throw new Error('Не удалось подтвердить цепочку процессов вызывающей Claude Code-сессии.');
    const candidates = rows.filter(row => row.pid === processInfo.pid && row.processStart === processInfo.processStart);
    if (candidates.length > 1) throw new Error('Registry содержит несколько идентичностей вызывающего Claude process.');
    const source = candidates[0];
    if (source) { assertClaudeSessionProcess(source); return source; }
    expectedPid = processInfo.parentPid;
  }
  throw new Error('Не удалось подтвердить вызывающую Claude Code-сессию по родительскому процессу.');
}
function rolloutFiles(threadId) {
  const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const found = [];
  function visit(directory, depth) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (depth < 3 && entry.isDirectory() && (depth ? /^\d{2}$/ : /^\d{4}$/).test(entry.name)) visit(file, depth + 1);
      if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) found.push(file);
    }
  }
  visit(base, 0);
  return found;
}
function codexSource(extra = {}) {
  const metadata = extra._meta?.['x-codex-turn-metadata'];
  const threadId = metadata?.thread_id ?? (process.argv[2] === '--cli' ? process.env.CODEX_THREAD_ID : null);
  if (!uuid.test(threadId ?? '')) throw new Error('Нет подтверждённого ID вызывающей Codex-задачи. Переподключите MCP server в этой задаче.');
  if (process.argv[2] !== '--cli' && (!uuid.test(metadata?.turn_id ?? '') || !isDesktopRootThreadSource(metadata?.thread_source))) throw new Error('Host не подтвердил текущий turn корневой Desktop-задачи (user или agent_created_thread).');
  const files = rolloutFiles(threadId).map(file => ({ file, mtime: fs.statSync(file).mtimeMs }));
  files.sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('Не найден rollout отправителя. Сообщение не отправлено.');
  const { session, context, lifecycle } = readRolloutState(files[0].file);
  if (session?.id !== threadId || !['Codex Desktop', 'codex_work_desktop'].includes(session.originator) || session.source !== 'vscode') throw new Error('Rollout не подтверждает Desktop identity отправителя.');
  if (!context || lifecycle?.turn_id !== context.turn_id || !['task_started', 'turn_started'].includes(lifecycle?.type) || metadata?.turn_id && context.turn_id !== metadata.turn_id) throw new Error('Не найден актуальный активный turn отправителя. Сообщение не отправлено.');
  let permissionMode;
  if (context.approval_policy === 'never' && context.approvals_reviewer === 'user' && context.permission_profile?.type === 'disabled' && context.sandbox_policy?.type === 'danger-full-access') permissionMode = 'bypass';
  else if (['on-request', 'on-failure', 'untrusted'].includes(context.approval_policy)) permissionMode = 'prompting';
  else throw new Error('Permission mode отправителя пока не поддерживается; настройки адресата не изменялись.');
  return { threadId, turnId: context.turn_id, cwd: context.cwd, permissionMode };
}
async function bind(source) {
  if (boundSource && boundSource.threadId !== source.threadId) throw new Error('Этот MCP process уже связан с другой задачей. Переподключите server отдельно для текущей задачи.');
  const response = await native('read_thread', { threadId: source.threadId, turnLimit: 1 });
  if (response.thread?.id !== source.threadId) throw new Error('Desktop не подтвердил задачу отправителя.');
  boundSource = { ...source, title: response.thread.title };
  peer.cwd = source.cwd;
  await peer.start();
  peer.rename(`oai ${response.thread.title} ${source.threadId.slice(0, 8)}`);
}

const tasks = createCrossSessionTasks({ relay, getSource: claudeSource, assertCurrent: () => runtime.assertCurrent() });

function claudeTasks(extra) {
  return createClaudeSessions({
    getSource: () => {
      // Creation grants a new process access to a project. Require host-provided
      // active-turn metadata rather than trusting a supplied environment ID.
      if (!extra?._meta?.['x-codex-turn-metadata']) throw new Error('Claude session creation requires the native Codex MCP caller context.');
      return codexSource(extra);
    },
    assertCurrent: () => runtime.assertCurrent(),
  });
}

const handlers = {
  create_claude_session: (args, extra) => claudeTasks(extra).create(args),
  get_claude_request: (args, extra) => claudeTasks(extra).receipt(args),
  async read_claude_session({ target, cwd, profile = 'default', turn_limit = 3 }, extra) {
    const source = codexSource(extra);
    cwd = canonicalDirectory(cwd ?? source.cwd);
    const configDir = resolveClaudeProfile(profile);
    const transcript = readClaudeSession({ target, cwd, configDir, turnLimit: turn_limit });
    let native = null;
    let nativeStatusError = null;
    try {
      const rows = await listClaudeAgents({ cwd, configDir });
      const matches = rows.filter(row => row.sessionId === target);
      if (matches.length > 1) throw new Error('Ambiguous native session');
      if (matches.length && canonicalDirectory(matches[0].cwd) !== cwd) throw new Error('Native session cwd mismatch');
      if (matches.length) {
        const { id, sessionId, status, state, waitingFor, kind } = matches[0];
        native = { id, sessionId, status, state, waitingFor, kind };
      }
    } catch { nativeStatusError = 'Native status could not be verified; transcript state does not prove process liveness.'; }
    return { ...transcript, native, ...(nativeStatusError ? { nativeStatusError } : {}) };
  },
  create_oai_session: args => { assertCodexModel(args.model, args.effort); return tasks.create(args); },
  read_oai_session: args => tasks.read(args),
  get_oai_request: args => tasks.receipt(args),
  async list_oai_sessions({ query = '' } = {}) {
    const rows = (await oaiList()).filter(row => !query || row.title?.toLowerCase().includes(query.toLowerCase()));
    return { sessions: rows.map(({ id, title, cwd, status }) => ({ id, title, cwd, status })), coverage: 'Последние 50 задач и закреплённые задачи. Для более старой задачи используйте известный точный ID.' };
  },
  async send_to_oai_session({ target, message, images, request_id, reply_mode, model, effort }) {
    runtime.assertCurrent();
    assertCodexModel(model, effort);
    const source = await claudeSource();
    let destination;
    try {
      destination = uuid.test(target) ? (await native('read_thread', { threadId: target, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1000 })).thread : choose(await oaiList(), target, 'id', 'title');
    } catch (error) {
      throw new Error(`Destination lookup failed before send; no follow-up was dispatched: ${error.message}`);
    }
    if (!destination || destination.kind !== 'codex' || destination.hostId !== 'local' || uuid.test(target) && destination.id !== target) throw new Error('Desktop должен подтвердить точную существующую локальную Codex-задачу.');
    const runner = activeFullAccessRunner(destination.id);
    if (runner) throw new Error(`The first full-access turn of task ${destination.id} is still running in the bridge runner (pid ${runner}); Codex Desktop cannot write to the task until it finishes. Nothing was sent: check read_oai_session and send again after that turn completes.`);
    const prompt = await buildOaiMessage({ source, message, requestId: request_id, images, replyMode: reply_mode });
    const beforeSend = async () => {
      runtime.assertCurrent();
      if ((await claudeSource()).sessionId !== source.sessionId) throw new Error('Контекст Claude отправителя изменился; отправка отменена.');
    };
    // model/effort ride the native send_message_to_thread operation; the plain relay path has no fields for them.
    const result = model || effort
      ? await relay.requestDesktop('send_message_to_thread', { threadId: destination.id, prompt, ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) }, { beforeSend })
      : await relay.sendMessage(destination.id, prompt, { beforeSend });
    return { accepted: result.ok === true, targetId: destination.id, targetTitle: destination.title, sourceSessionId: source.sessionId, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(request_id ? { request_id } : {}), note: 'Принято Desktop. Это подтверждает передачу, а не завершение работы. Не повторяйте отправку после timeout: прочитайте ту же задачу.' };
  },
  async list_claude_sessions({ query = '' } = {}) {
    const discovery = {};
    const sessions = claudeList(discovery).filter(row => !query || row.name?.toLowerCase().includes(query.toLowerCase()))
      .map(({ sessionId, name, cwd, pid, dir, profileSources }) => ({ sessionId, name, cwd, pid, registryDirectory: dir, profileSources }));
    return { sessions, discovery, runtime: runtime.status() };
  },
  async send_to_claude_session({ target, message, wait_seconds = 0, model, effort }, extra) {
    runtime.assertCurrent();
    const source = codexSource(extra);
    const destination = choose(claudeList(), target, 'sessionId', 'name');
    assertClaudeSessionProcess(destination);
    await bind(source);
    const result = await peer.sendAndWait(destination.socket,
      `[От OAI-задачи "${boundSource.title}"; threadId=${source.threadId}]${model || effort ? `\n[Запрошено исполнение: model=${model ?? 'как у сессии'}, effort=${effort ?? 'как у сессии'} — если это не твоя текущая модель/effort, выполни задачу субагентом Agent(model=…) с этим effort и верни его результат]` : ''}\n${message}\n\nОтветь через native SendMessage по reply address этого сообщения. Сохраняй разрешения своей сессии.`, {
        timeoutMs: wait_seconds * 1000, permissionMode: source.permissionMode, replyThreadId: source.threadId,
        beforeSend: () => {
          const now = codexSource(extra);
          if (now.threadId !== source.threadId || now.turnId !== source.turnId || now.permissionMode !== source.permissionMode) throw new Error('Контекст отправителя изменился; отправка отменена.');
          assertClaudeSessionProcess(destination);
        },
      });
    return { messageId: result.msgId, status: result.reply ? 'reply_received' : result.delivery?.status ?? 'sent_unconfirmed', reply: result.reply?.text ?? null, targetSessionId: destination.sessionId, note: 'Не повторяйте отправку из-за timeout; проверяйте get_delivery.' };
  },
  async get_delivery({ message_id }) {
    return { receipt: peer.readDelivery(message_id), forwarding: forwarder.read(message_id) };
  },
  async bridge_status(_args, extra = {}) {
    await native('list_threads', { limit: 1 });
    let caller;
    try {
      caller = extra._meta?.['x-codex-turn-metadata'] || process.argv[2] === '--cli' && process.env.CODEX_THREAD_ID
        ? { verified: true, harness: 'codex', ...codexSource(extra) }
        : { verified: true, harness: 'claude', sessionId: (await claudeSource()).sessionId };
    } catch (error) { caller = { verified: false, reason: error.message }; }
    const discovery = {};
    const liveSessions = claudeList(discovery);
    const turnMetadata = extra._meta?.['x-codex-turn-metadata'];
    const hostContext = turnMetadata ? { threadId: turnMetadata.thread_id ?? null, turnId: turnMetadata.turn_id ?? null, threadSource: turnMetadata.thread_source ?? null } : null;
    return { hostContext, ready: true, apiVersion: '1.4.0', capabilities: { create_claude_session: true, read_claude_session: true, get_claude_request: true, claude_background_sessions: true, full_access_tasks: true, create_oai_session: true, read_oai_session: true, get_oai_request: true, image_references: true, persistent_tasks: true, compact_image_history: true, read_reply_mode: true }, transport: 'native Desktop relay + Claude Code inbox socket', caller, source: boundSource, forwarding: forwarder.status(), runtime: runtime.status(), discovery: { ...discovery, liveSessionCount: liveSessions.length } };
  },
};

const imageInput = z.object({ path: z.string().min(1).max(8192), role: z.enum(['reference', 'edit_target', 'supporting']), note: z.string().max(2000).optional() }).strict();
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const replyMode = z.enum(['read', 'callback']).optional();
const codexModel = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional();
const codexEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional();
const claudeModel = z.enum(['fable', 'opus', 'sonnet', 'haiku']).optional();
const claudeEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional();
const schemas = {
  create_claude_session: { cwd: z.string().min(1).max(8192).optional(), title: z.string().min(1).max(200).optional(), message: z.string().min(1).max(100000), request_id: requestId, model: claudeModel, effort: claudeEffort, permission_mode: z.enum(['manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']).optional(), profile: z.string().min(1).max(100).optional(), mcp_mode: z.enum(['inherit', 'none']).optional() },
  read_claude_session: { target: z.string().uuid(), cwd: z.string().min(1).max(8192).optional(), profile: z.string().min(1).max(100).optional(), turn_limit: z.number().int().min(1).max(10).optional() },
  get_claude_request: { cwd: z.string().min(1).max(8192).optional(), request_id: requestId },
  list_oai_sessions: { query: z.string().optional() }, list_claude_sessions: { query: z.string().optional() },
  create_oai_session: { cwd: z.string().min(1).max(8192).optional(), title: z.string().min(1).max(200).optional(), message: z.string().min(1).max(100000), request_id: requestId, images: z.array(imageInput).max(5).optional(), reply_mode: replyMode, model: codexModel, effort: codexEffort },
  read_oai_session: { target: z.string().uuid(), turn_limit: z.number().int().min(1).max(10).optional() },
  get_oai_request: { cwd: z.string().min(1).max(8192).optional(), request_id: requestId },
  send_to_oai_session: { target: z.string(), message: z.string().min(1).max(100000), request_id: requestId.optional(), images: z.array(imageInput).max(5).optional(), reply_mode: replyMode, model: codexModel, effort: codexEffort },
  send_to_claude_session: { target: z.string(), message: z.string(), wait_seconds: z.number().int().min(0).max(45).optional(), model: claudeModel, effort: claudeEffort },
  get_delivery: { message_id: z.string() }, bridge_status: {},
};
const descriptions = {
  create_claude_session: 'Create a persistent local Claude Code session using native --background, in an existing absolute cwd (defaults to caller project). Codex native MCP callers only. Requires workspace trust in Claude. Pin model (fable/opus/sonnet/haiku) and effort (low/medium/high/xhigh/max) as needed. permission_mode defaults to manual; explicit bypassPermissions disables tool approvals and requires a verified full-access caller. profile selects default Claude, CLAUDE_CONFIG_DIR when configured, or an optional CCS profile. mcp_mode defaults to inherit; none skips external MCP servers for lightweight tasks. request_id is scoped to caller thread and cwd: reuse identical arguments to recover the same launch; changed launch parameters are rejected. Unknown outcomes are never relaunched. Session name includes a recovery marker. Read its result with read_claude_session using returned sessionId and cwd/profile; continue through send_to_claude_session. Native background CLI support required. Acceptance is not completion; permission prompts may need claude attach.',
  read_claude_session: 'Read bounded recent text from a persistent local Claude Code conversation by exact session UUID and project cwd. profile defaults to default; use the same profile as creation. Returns native status when available, explicitly separate from transcript status. Does not create, resume, or send. Omits thinking, tool payloads, images and inline data.',
  get_claude_request: 'Recover the creation outcome scoped to the calling Codex thread, cwd, and request_id. Reads the durable receipt and native background session catalog. Never launches again, including after timeout or worker restart.',
  create_oai_session: 'Create and initialize one persistent Codex Desktop task in an exact saved local project. The task always runs with FULL ACCESS (approval_policy never, danger-full-access sandbox, network on): it can modify any file and use the network without an approval click. Its first turn starts through a local Codex app-server; the task appears in Codex Desktop and continues there. Requires a stable request_id; reuse it to recover the same creation without sending twice. Returns a thread ID for subsequent send_to_oai_session calls. Default reply_mode=read: recipient finishes with a final result for read_oai_session. Callback is opt-in and supported for user and agent-created Desktop tasks with verified active turns and supported permissions. Optional images are validated local files; the recipient loads them with view_image. Claude Code callers only. Optional model + effort pin this task (omitted = the Desktop default model). The slug must exist in the Codex catalog and the effort must be supported by that model, otherwise the call fails before sending; which model fits a task is decided by the calling skill or workflow.',
  read_oai_session: 'Read recent turns and status of an existing local Codex Desktop task by exact ID. Does not send, resume, fork, or create. Use after acceptance or an uncertain delivery to recover results. Claude Code callers only.',
  get_oai_request: 'Read the durable creation receipt scoped to the calling Claude session, cwd and request_id. Never retries a creation. Retains known task IDs and pending/unknown outcomes.',
  send_to_oai_session: 'Send a follow-up into an existing local Codex Desktop task, preserving its conversation and its permissions (tasks created by create_oai_session keep full access; wait until the first turn finished before following up). Resolve an exact target first. Optional images specify local reference/edit_target/supporting files. Use reply_mode=read for delegated tasks, then read_oai_session to recover final output; legacy default is callback. request_id correlates replies; it is not a resend guarantee. Claude Code callers only. model/effort apply to this turn and later turns of the task. Optional model + effort pin this task (omitted = the Desktop default model). The slug must exist in the Codex catalog and the effort must be supported by that model, otherwise the call fails before sending; which model fits a task is decided by the calling skill or workflow.',
  send_to_claude_session: 'Send a message into a live Claude Code session (Codex callers). Optional model (fable|opus|sonnet|haiku) and effort (low…max) ask the recipient to run the task on that Claude model: the recipient keeps its own session model and delegates to a subagent with the requested model when it differs. Which model fits is decided by the calling workflow.',
};
const mutatingTools = new Set(['create_claude_session', 'create_oai_session', 'send_to_oai_session', 'send_to_claude_session']);

if (process.argv[2] === '--cli') {
  try {
    const input = JSON.parse(process.argv[3]);
    if (!Object.hasOwn(handlers, input.tool)) throw new Error('Unknown cross-session-bridge tool');
    const args = z.object(schemas[input.tool]).strict().parse(input.arguments ?? {});
    console.log(JSON.stringify(await handlers[input.tool](args, {})));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  peer.stop();
} else {
  const mcp = new McpServer({ name: 'cross-session-bridge', version: '1.4.0' }, { instructions: 'From Claude Code, create_oai_session starts a persistent native Codex Desktop task, send_to_oai_session continues its exact ID, and read_oai_session/get_oai_request recover results without resending. Use reply_mode=read for delegated tasks; this is the creation default. Local references carry task context; the caller specifies the requested workflow. From Codex, create_claude_session starts a persistent native Claude Code background session with explicit project/model/effort/permissions; read_claude_session/get_claude_request recover results. list_claude_sessions/send_to_claude_session reach live Claude terminals where the sender context supports callbacks. Resolve exact names to IDs; never replace an existing task. Tasks created by create_oai_session run with full access (approval never, danger-full-access sandbox, network on) and keep it on continuation. Acceptance is not completion. Never resend an uncertain delivery or forward acknowledgements endlessly. Pin the model explicitly: model+effort on create_oai_session/send_to_oai_session (otherwise the Desktop default model runs) and on send_to_claude_session; which model fits a task is decided by the calling skill or workflow.' });
  for (const [name, handler] of Object.entries(handlers)) mcp.registerTool(name, { description: descriptions[name] ?? name.replaceAll('_', ' '), inputSchema: schemas[name], annotations: { readOnlyHint: !mutatingTools.has(name), destructiveHint: false, openWorldHint: true } }, async (args, extra) => {
    try { return await reload.run(async () => textResult(await handler(args, extra))); }
    catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  });
  await mcp.connect(new StdioServerTransport());
  mcp.server.onclose = () => { forwarder.close(); peer.stop(); };
  reload.listen();
}
