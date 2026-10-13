import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { buildFrame } from '../src/peer-protocol.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function eventually(read, predicate, details = () => '') {
  const deadline = Date.now() + 60000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (Date.now() < deadline);
  assert.fail(`Did not settle: ${JSON.stringify(value)} ${details()}`);
}

function listen(server, address) {
  return new Promise(resolve => server.listen(address, resolve));
}

async function fixture(t) {
  // All identities, registries and Desktop dispatches below belong to this isolated fixture.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-daemon-'));
  fs.cpSync(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repository, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(fs.realpathSync.native(path.join(repository, 'node_modules')), path.join(root, 'node_modules'));
  const prefix = `/tmp/bridge-daemon-${randomUUID()}`;
  const claudeSocket = `${prefix}.sock`, relayPath = `${prefix}-relay.sock`, daemonSocket = `${prefix}-daemon.sock`;
  const threads = [randomUUID(), randomUUID()].map(threadId => ({ threadId, turnId: randomUUID() }));
  const claudeId = randomUUID();
  const relayMessages = [], received = [];
  const relay = net.createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]);
      if (request.targetThreadId) relayMessages.push(request);
      const result = request.operation === 'read_thread'
        ? { thread: { id: request.arguments.threadId, title: `task-${request.arguments.threadId.slice(0, 4)}`, kind: 'codex', hostId: 'local' } }
        : { pinnedThreads: [], threads: [] };
      socket.end(JSON.stringify({ ok: true, v: request.v, operation: request.operation, result }) + '\n');
    });
  });
  const receiver = net.createServer(socket => {
    let buffer = '';
    socket.on('data', data => { buffer += data; });
    socket.on('end', () => {
      for (const line of buffer.trim().split('\n')) {
        const frame = JSON.parse(line);
        if (frame.type === 'user') received.push(frame);
      }
    });
  });
  await Promise.all([listen(receiver, claudeSocket), listen(relay, relayPath)]);
  const registry = path.join(root, '.claude/sessions');
  fs.mkdirSync(registry, { recursive: true });
  const procStart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
  fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: claudeId, procStart, name: 'fixture-claude', cwd: root, entrypoint: 'cli', messagingSocketPath: claudeSocket }));
  const sessions = path.join(root, '.codex/sessions/2026/10/13');
  fs.mkdirSync(sessions, { recursive: true });
  for (const { threadId, turnId } of threads) fs.writeFileSync(path.join(sessions, `rollout-${threadId}.jsonl`), [
    { type: 'session_meta', payload: { id: threadId, originator: 'Codex Desktop', source: 'vscode', cwd: root } },
    { type: 'turn_context', payload: { turn_id: turnId, cwd: root, approval_policy: 'never', approvals_reviewer: 'user', permission_profile: { type: 'disabled' }, sandbox_policy: { type: 'danger-full-access' } } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  ].map(JSON.stringify).join('\n') + '\n');

  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, '.codex'), CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    CODEX_NATIVE_RELAY_SOCKET: relayPath, CROSS_SESSION_BRIDGE_CODEX_SOCKET: daemonSocket, CROSS_SESSION_BRIDGE_SOCKET: `${prefix}-claude-daemon.sock`,
    CROSS_SESSION_BRIDGE_SHIM_CACHE: path.join(root, 'claude-shim-cache.json'),
    CROSS_SESSION_BRIDGE_CODEX_STATE: path.join(root, 'codex-callers.json'), CROSS_SESSION_BRIDGE_CODEX_SHIM_CACHE: path.join(root, 'shim-cache.json') };
  let daemonLog = '';
  const startDaemon = () => {
    const daemon = spawn(process.execPath, [path.join(root, 'src/bridge-daemon.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr.on('data', data => { daemonLog += data; });
    return daemon;
  };
  let daemon = startDaemon();
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    daemon.kill();
    await Promise.all([new Promise(resolve => receiver.close(resolve)), new Promise(resolve => relay.close(resolve))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await eventually(() => fs.existsSync(daemonSocket), Boolean, () => daemonLog);
  const connectShim = async server => {
    const client = new Client({ name: 'codex-thread', version: '1' });
    const transport = new StdioClientTransport({ command: 'python3', args: [path.join(repository, 'scripts/bridge-shim.py'), server], env, stderr: 'pipe' });
    await client.connect(transport);
    clients.push(client);
    return { client, pid: transport.pid };
  };
  const forged = await new Promise(resolve => {
    const socket = net.connect(daemonSocket, () => socket.write(JSON.stringify({ bridge_caller: { codex: { pid: process.pid, server: 'cross-session-bridge' } } }) + '\n'));
    let reply = '';
    socket.on('data', data => { reply += data; });
    socket.on('close', () => resolve(reply));
  });
  assert.equal(forged, '', 'a process that is not a shim gets no bridge');
  const shims = [await connectShim('cross-session-bridge'), await connectShim('cross-session-bridge')];
  const call = (shim, name, args, thread) => shim.client.callTool({ name, arguments: args, ...(thread ? { _meta: { 'x-codex-turn-metadata': { thread_id: thread.threadId, turn_id: thread.turnId, thread_source: 'user' } } } : {}) });

  const answer = async (address, text) => new Promise((resolve, reject) => {
    const connection = net.connect(address, () => connection.end(JSON.stringify(buildFrame({ text, fromSocket: claudeSocket })) + '\n', resolve));
    connection.on('error', reject);
  });
  return { root, env, threads, claudeId, registry, relayMessages, received, shims, call, answer, connectShim, daemonSocket,
    get daemon() { return daemon; }, restart: () => { daemon = startDaemon(); }, log: () => daemonLog };
}

it('serves every Codex thread from one daemon and routes each Claude reply back to its own thread across a daemon restart', { timeout: 90000, skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const { root, env, threads, claudeId, registry, relayMessages, received, shims, call, answer, connectShim, restart, log } = fx;
  const { tools } = await shims[0].client.listTools();
  assert.ok(['bridge_status', 'send_to_claude_session', 'get_delivery', 'create_claude_session'].every(name => tools.some(tool => tool.name === name)));

  const statuses = await Promise.all(shims.map((shim, index) => call(shim, 'bridge_status', {}, threads[index])));
  assert.deepEqual(statuses.map(status => status.structuredContent.caller.threadId), threads.map(thread => thread.threadId));
  assert.equal(new Set(statuses.map(status => status.structuredContent.runtime.pid)).size, 1, 'both threads are served by one daemon process');

  const refused = await call(shims[0], 'send_to_claude_session', { target: claudeId, message: 'MUST_NOT_SEND without host identity', wait_seconds: 0 });
  assert.equal(refused.isError, true);
  const sent = [];
  for (const [index, shim] of shims.entries()) {
    const result = await call(shim, 'send_to_claude_session', { target: claudeId, message: `from thread ${index}`, wait_seconds: 0 }, threads[index]);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    sent.push(result.structuredContent.messageId);
  }
  await eventually(async () => received, value => value.length === 2);
  const addresses = received.map(frame => decodeURIComponent(frame.from.slice(4)));
  assert.deepEqual(addresses, shims.map(shim => `/tmp/cc-socks/${shim.pid}.sock`), 'each thread answers from a peer under its own shim pid');
  for (const shim of shims) assert.equal(JSON.parse(fs.readFileSync(path.join(registry, `${shim.pid}.json`), 'utf8')).pid, shim.pid);
  await answer(addresses[1], 'reply to thread 1');
  await answer(addresses[0], 'reply to thread 0');
  await eventually(async () => relayMessages, value => value.length === 2, log);
  assert.deepEqual(relayMessages.map(message => message.targetThreadId).sort(), threads.map(thread => thread.threadId).sort());
  assert.match(relayMessages.find(message => message.targetThreadId === threads[0].threadId).message, /reply to thread 0/);
  assert.match(relayMessages.find(message => message.targetThreadId === threads[1].threadId).message, /reply to thread 1/);
  assert.equal((await call(shims[0], 'get_delivery', { message_id: sent[1] })).structuredContent.receipt, null, 'a thread does not see another thread\'s deliveries');

  // New code on disk: the idle daemon saves each bound thread's reply address and exits; launchd (here: the test) starts it again.
  const exited = new Promise(resolve => fx.daemon.once('exit', resolve));
  fs.appendFileSync(path.join(root, 'src/cross-session-bridge.mjs'), '\n');
  assert.equal(await exited, 0, log());
  assert.equal(JSON.parse(fs.readFileSync(env.CROSS_SESSION_BRIDGE_CODEX_STATE, 'utf8')).length, 2);
  restart();
  const after = await eventually(() => call(shims[0], 'bridge_status', {}, threads[0]), value => value.structuredContent?.source?.threadId === threads[0].threadId, log);
  assert.notEqual(after.structuredContent.runtime.pid, statuses[0].structuredContent.runtime.pid);
  assert.equal((await call(shims[0], 'get_delivery', { message_id: sent[0] })).structuredContent.receipt.reply, 'reply to thread 0');
  await eventually(() => fs.existsSync(addresses[1]), Boolean, log);
  await answer(addresses[1], 'later message to thread 1');
  await eventually(async () => relayMessages, value => value.length === 3, log);
  assert.equal(relayMessages[2].targetThreadId, threads[1].threadId);
  const cache = JSON.parse(fs.readFileSync(env.CROSS_SESSION_BRIDGE_CODEX_SHIM_CACHE, 'utf8'));
  assert.ok(cache['cross-session-bridge'].tools.tools.some(tool => tool.name === 'send_to_claude_session'));
});

it('keeps serving every thread while one thread waits for a Claude reply after new code lands, and restarts once that thread unloads', { timeout: 90000, skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const { root, env, threads, claudeId, received, shims, call, log } = fx;
  const unanswered = await call(shims[0], 'send_to_claude_session', { target: claudeId, message: 'never answered', wait_seconds: 0 }, threads[0]);
  assert.notEqual(unanswered.isError, true, JSON.stringify(unanswered));
  await eventually(async () => received, value => value.length === 1);
  const exited = new Promise(resolve => fx.daemon.once('exit', resolve));
  fs.appendFileSync(path.join(root, 'src/cross-session-bridge.mjs'), '\n');
  await eventually(async () => log(), value => value.includes('new code waits'));
  const other = await call(shims[1], 'send_to_claude_session', { target: claudeId, message: 'another thread still sends', wait_seconds: 0 }, threads[1]);
  assert.notEqual(other.isError, true, JSON.stringify(other));
  await eventually(async () => received, value => value.length === 2);
  await fx.answer(decodeURIComponent(received[1].from.slice(4)), 'reply to thread 1');
  await shims[0].client.close();
  assert.equal(await exited, 0, log());
  assert.deepEqual(JSON.parse(fs.readFileSync(env.CROSS_SESSION_BRIDGE_CODEX_STATE, 'utf8')).map(entry => entry.pid), [shims[1].pid]);
});

it('serves Claude sessions on their own socket and identifies each caller by its shim parent and its own profile', { timeout: 90000, skip: process.platform === 'win32' }, async t => {
  const fx = await fixture(t);
  const { root, env, claudeId, registry, log } = fx;
  await eventually(() => fs.existsSync(env.CROSS_SESSION_BRIDGE_SOCKET), Boolean, log);
  // The same Claude process is registered in two profiles; only the profile the shim reports may name the caller.
  const profile = path.join(root, '.ccs/instances/second');
  const otherId = randomUUID();
  fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
  const entry = JSON.parse(fs.readFileSync(path.join(registry, `${process.pid}.json`), 'utf8'));
  fs.writeFileSync(path.join(profile, 'sessions', `${process.pid}.json`), JSON.stringify({ ...entry, sessionId: otherId, name: 'second-profile' }));
  const connect = async configDir => {
    const client = new Client({ name: 'claude-session', version: '1' });
    await client.connect(new StdioClientTransport({ command: 'python3', args: [path.join(repository, 'scripts/bridge-shim.py')], env: { ...env, CLAUDE_CONFIG_DIR: configDir }, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  const status = async client => (await client.callTool({ name: 'bridge_status', arguments: {} })).structuredContent;
  const [first, second] = await Promise.all([connect(path.join(root, '.claude')), connect(profile)]);
  const [one, two] = await Promise.all([status(first), status(second)]);
  assert.deepEqual([one.caller, two.caller], [{ verified: true, harness: 'claude', sessionId: claudeId }, { verified: true, harness: 'claude', sessionId: otherId }]);
  assert.equal(one.runtime.pid, two.runtime.pid, 'both sessions are served by one daemon process');
  fs.writeFileSync(path.join(env.CODEX_HOME, 'native-relay.json'), JSON.stringify({ relayThreadId: randomUUID() }));
  const listed = await first.callTool({ name: 'list_oai_sessions', arguments: {} });
  assert.deepEqual(listed.structuredContent?.sessions, [], JSON.stringify(listed));
  assert.match(log(), new RegExp(`call bridge_status caller ${process.pid} `));
});
