import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopTaskReceipts } from './desktop-task-receipts.mjs';
import { discoverClaudeConfigDirs } from './claude-config-dirs.mjs';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];

export function claudeExecutable(env = process.env) {
  const explicit = env.CLAUDE_BIN;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit) || !fs.statSync(explicit).isFile()) throw new Error('CLAUDE_BIN must point to an existing Claude executable.');
    return explicit;
  }
  const standard = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  try { if (fs.statSync(standard).isFile()) return standard; } catch {}
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function canonicalDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('An existing absolute project directory is required.');
  const directory = fs.realpathSync.native(value);
  if (!fs.statSync(directory).isDirectory()) throw new Error('Project path must be a directory.');
  return directory;
}

export function resolveClaudeProfile(profile = 'default', discovery = discoverClaudeConfigDirs()) {
  const label = ['default', 'CLAUDE_CONFIG_DIR', 'CCS_HOME'].includes(profile) || profile.startsWith('CCS:') ? profile : `CCS:${profile}`;
  const matches = discovery.directories.filter(row => row.sources.includes(label));
  if (matches.length !== 1) throw new Error('Claude profile is missing or ambiguous. Select an installed profile reported by bridge_status.');
  return canonicalDirectory(matches[0].path);
}

export function claudeLaunchArgs(spec) {
  const args = ['--background', '--name', spec.name, '--permission-mode', spec.permissionMode];
  if (spec.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.mcpMode === 'none') args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  // The separator prevents a prompt beginning with '--' from becoming a CLI flag.
  args.push('--', spec.message);
  return args;
}

export function claudeEnvironment(configDir, env = process.env) {
  const clean = { ...env };
  let defaultDir = path.join(os.homedir(), '.claude');
  try { defaultDir = fs.realpathSync.native(defaultDir); } catch { /* default directory may not exist in tests */ }
  // Explicit CLAUDE_CONFIG_DIR=~/.claude changes Claude's config-file location
  // from ~/.claude.json to ~/.claude/.claude.json, losing default workspace trust.
  if (configDir === defaultDir) delete clean.CLAUDE_CONFIG_DIR;
  else clean.CLAUDE_CONFIG_DIR = configDir;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CLAUDE_BRIDGE_PERMISSION_MODE']) delete clean[key];
  return clean;
}

// execFile uses no shell. End stdin explicitly: otherwise CLI pipe detection can
// append the caller's source script or unrelated input to the requested prompt.
export async function runClaude(args, { cwd, configDir, timeout = 20000 } = {}) {
  const pending = exec(claudeExecutable(), args, { cwd, env: claudeEnvironment(configDir), timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  pending.child.stdin.end();
  return pending;
}

export async function listClaudeAgents({ cwd, configDir }, run = runClaude) {
  const { stdout } = await run(['agents', '--json', '--all'], { cwd, configDir, timeout: 10000 });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error('Claude did not return its native session catalog.');
  return rows.filter(row => row && typeof row === 'object');
}

export function createClaudeSessions({ getSource, assertCurrent, receipts = new DesktopTaskReceipts({ directory: path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'bridge-claude-receipts') }), run = runClaude, resolveProfile = resolveClaudeProfile } = {}) {
  async function sourceNow() {
    await assertCurrent();
    const source = await getSource();
    if (!UUID.test(source?.threadId ?? '') || !UUID.test(source?.turnId ?? '') || !['bypass', 'prompting'].includes(source?.permissionMode)) throw new Error('A verified active Codex caller is required.');
    return { ...source, cwd: canonicalDirectory(source.cwd) };
  }
  async function guard(original) {
    const current = await sourceNow();
    if (['threadId', 'turnId', 'cwd', 'permissionMode'].some(key => current[key] !== original[key])) throw new Error('Codex caller changed before launch; no session was started.');
  }
  function identity(source, cwd, requestId, payload = '') {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new Error('A stable request_id is required.');
    const name = `codex:${source.threadId}:${requestId}`;
    return { name, ...receipts.key({ cwd, name, prompt: payload }) };
  }
  function result(record, reused = false, native = null) {
    return { requestState: record.state, sessionId: record.threadId ?? null, cwd: record.cwd,
      profileDirectory: record.claude.configDir, name: record.claude.name, model: record.claude.model ?? 'native default', effort: record.claude.effort ?? 'native default', permissionMode: record.claude.permissionMode,
      reused, nativeStatus: native?.status ?? null, nativeState: native?.state ?? null, waitingFor: native?.waitingFor ?? null,
      attach: record.threadId ? ['claude', 'attach', record.threadId.slice(0, 8)] : null,
      attachEnvironment: { CLAUDE_CONFIG_DIR: claudeEnvironment(record.claude.configDir, {}).CLAUDE_CONFIG_DIR ?? null },
      note: 'Creation is workspace-scoped and is not task completion. Read the same session; never repeat an unknown launch with a new request_id. Native workspace trust and permission prompts require user action through claude attach.' };
  }
  async function recover(record) {
    let candidates;
    try {
      const rows = await listClaudeAgents({ cwd: record.cwd, configDir: record.claude.configDir }, run);
      candidates = rows.filter(row => {
        if (record.threadId && row.sessionId !== record.threadId) return false;
        if (row.kind !== 'background' || !UUID.test(row.sessionId ?? '') || row.name !== record.claude.name || !Number.isFinite(row.startedAt) || row.startedAt < record.startedAt - 2000) return false;
        try { return canonicalDirectory(row.cwd) === record.cwd; } catch { return false; }
      });
    } catch { return { record, native: null }; }
    if (candidates.length !== 1) return { record, native: null };
    const native = candidates[0];
    const known = { ...record, state: 'known', threadId: native.sessionId };
    return { record: known, native };
  }
  async function reconcile(record) {
    const recovered = await recover(record);
    if (recovered.record.state === 'known' && record.state !== 'known') {
      try {
        await receipts.withLock(record.key, async () => {
          const current = await receipts.read(record.key);
          if (!current || current.promptHash !== record.promptHash) throw new Error('Receipt changed during recovery.');
          if (current.threadId && current.threadId !== recovered.record.threadId) throw new Error('Receipt session identity changed during recovery.');
          await receipts.write(record.key, { ...current, state: 'known', threadId: recovered.record.threadId });
        });
      } catch (error) {
        // A creator may still be reconciling the same launch. Do not steal its
        // lock or turn this read into a second launch.
        if (!/already in progress/.test(error.message)) throw error;
      }
    }
    return recovered;
  }
  return {
    async create({ cwd, title, message, request_id, model, effort, permission_mode = 'manual', profile = 'default', mcp_mode = 'inherit' } = {}) {
      const source = await sourceNow();
      cwd = canonicalDirectory(cwd ?? source.cwd);
      if (typeof message !== 'string' || !message.trim() || message.length > 100000 || message.includes('\0')) throw new Error('A nonempty message of at most 100000 characters is required.');
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\x00-\x1f]/.test(title))) throw new Error('Invalid session title.');
      if (model !== undefined && !MODELS.includes(model) || effort !== undefined && !EFFORTS.includes(effort) || !MODES.includes(permission_mode) || !['inherit', 'none'].includes(mcp_mode)) throw new Error('Unsupported Claude model, effort, permissions, or MCP mode.');
      if (permission_mode === 'bypassPermissions' && source.permissionMode !== 'bypass') throw new Error('A prompting caller cannot create a bypass-permissions session.');
      const configDir = resolveProfile(profile);
      const payload = JSON.stringify({ cwd, title: title ?? null, message, model: model ?? null, effort: effort ?? null, permission_mode, configDir, mcp_mode });
      const id = identity(source, cwd, request_id, payload);
      const check = record => {
        if (record && (record.promptHash !== id.promptHash || !record.claude)) throw new Error('request_id was already used with different launch parameters. Nothing was launched.');
        return record;
      };
      let previous = check(await receipts.read(id.key));
      if (previous) {
        const recovered = await reconcile(previous);
        return result(recovered.record, true, recovered.native);
      }
      return receipts.withLock(id.key, async () => {
        previous = check(await receipts.read(id.key));
        if (previous) return result(previous, true);
        await guard(source);
        const label = (title ?? message.split('\n').find(line => line.trim())).replace(/[\x00-\x20\x7f]+/g, ' ').trim();
        const name = `${label.slice(0, 120)} [bridge ${id.key.slice(0, 16)}]`;
        const launch = { configDir, name, permissionMode: permission_mode, mcpMode: mcp_mode, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
        let record = { version: 1, key: id.key, cwd, promptHash: id.promptHash, state: 'pending', startedAt: Date.now(), name: id.name, claude: launch };
        await receipts.write(id.key, record);
        await guard(source);
        let launchError = null;
        try {
          // Do not pass --session-id: native --background allocates its own ID.
          await run(claudeLaunchArgs({ ...launch, message }), { cwd, configDir });
        } catch (error) {
          const output = String(error.stderr ?? '');
          launchError = /Workspace not trusted/.test(output) ? 'Workspace is not trusted in this Claude profile. Open claude in that directory and approve trust, then use a new request_id; this request is never relaunched.'
            : /unknown option.*background/.test(output) ? 'Installed Claude Code does not support --background. Update Claude before creating sessions.'
            : 'Claude launch was not confirmed. Inspect this receipt and native claude agents; no automatic retry was made.';
        }
        record = { ...record, state: 'unknown' };
        await receipts.write(id.key, record);
        const recovered = await recover(record);
        await receipts.write(id.key, recovered.record);
        return { ...result(recovered.record, false, recovered.native), ...(launchError ? { launchError } : {}) };
      });
    },
    async receipt({ cwd, request_id } = {}) {
      const source = await sourceNow();
      cwd = canonicalDirectory(cwd ?? source.cwd);
      const { key } = identity(source, cwd, request_id);
      const record = await receipts.read(key);
      if (!record) return { requestState: 'missing', sessionId: null };
      if (!record.claude) throw new Error('Receipt does not describe a Claude session.');
      const recovered = await reconcile(record);
      return result(recovered.record, true, recovered.native);
    },
  };
}
