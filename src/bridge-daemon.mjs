#!/usr/bin/env node
// One cross-session-bridge and one native relay for every Codex thread (Mac memory, owner #39883): Codex starts its MCP
// servers once per loaded thread, and each thread ran a supervisor + worker pair for both servers (~120 MB a thread).
// Threads now run scripts/codex-bridge-shim.py, which connects here and first sends one line
// {"bridge_caller":{"codex":{"pid":<the shim's pid>,"server":"cross-session-bridge"|"codex-native-relay"}}}.
// The caller's task and turn still come from the _meta of every tool call and are verified against its rollout exactly
// as before; the shim's pid only names the thread's peer entry in Claude's registry (it lives and dies with the thread),
// and the shim's parent is the app-server whose Desktop tools pipe the relay dispatches through.
// When the source on disk changes, the daemon exits as soon as nothing is in flight, after saving each bound thread's
// reply address; launchd starts the new code, the shims reconnect and get their addresses back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.CROSS_SESSION_BRIDGE_DAEMON = '1';
const { serveCodexConnection, codexBridgeIdle, suspendCodexCallers, bridgeRuntime } = await import('./cross-session-bridge.mjs');
const { createNativeRelayCompanion } = await import('./native-relay-companion.mjs');
const { NativeToolsClient, resolveNativeToolsPipePath } = await import('./native-relay.mjs');
const { readProcessStart } = await import('./peer-protocol.mjs');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

const HOME = path.join(os.homedir(), '.local', 'share', 'cross-session-bridge');
const SOCKET = process.env.CROSS_SESSION_BRIDGE_CODEX_SOCKET || path.join(HOME, 'codex-daemon.sock');
const STATE = process.env.CROSS_SESSION_BRIDGE_CODEX_STATE || path.join(HOME, 'codex-callers.json');
const SERVERS = new Set(['cross-session-bridge', 'codex-native-relay']);
const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

function readCodexCaller(line) {
  const { pid, server } = JSON.parse(line).bridge_caller?.codex ?? {};
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('bridge_caller.codex.pid must be a process id');
  if (!SERVERS.has(server)) throw new Error(`bridge_caller.codex.server must be one of ${[...SERVERS].join(', ')}`);
  if (appServers.has(pid)) throw new Error(`process ${pid} is already connected`);
  // The socket is private to this user; the pid must still be a running shim for the server it names, so a stale or
  // mistyped hello cannot take another thread's peer address.
  const [parent, ...command] = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=,command='], { encoding: 'utf8' }).trim().split(/\s+/);
  if (!command.some(word => word.endsWith('/codex-bridge-shim.py')) || command.at(-1) !== server) throw new Error(`process ${pid} is not a ${server} shim`);
  if (!(Number(parent) > 1)) throw new Error(`process ${pid} has no app-server parent`);
  return { pid, server, appServer: Number(parent) };
}

// The relay dispatches through the Desktop app-server's tools pipe. Only the Desktop app-server carries one, so the
// connected shims' parents are tried newest first and resolveNativeToolsPipePath applies the same checks it applies
// to the stdio companion's own parent.
const appServers = new Map();
const nativeTools = new NativeToolsClient({
  resolveSocketPath: async () => {
    for (const appServer of [...new Set([...appServers.values()].reverse())]) {
      const pipe = await resolveNativeToolsPipePath({ parentPid: appServer });
      if (pipe) return pipe;
    }
    return null;
  },
});
const companion = createNativeRelayCompanion({ nativeTools });

function savedCallers() {
  try { return new Map(JSON.parse(fs.readFileSync(STATE, 'utf8')).map(entry => [entry.pid, entry])); }
  catch { return new Map(); }
}
const saved = savedCallers();
const writeSaved = () => fs.writeFileSync(STATE, JSON.stringify([...saved.values()]), { mode: 0o600 });

async function serve(socket, caller) {
  appServers.delete(caller.pid);
  appServers.set(caller.pid, caller.appServer);
  socket.once('close', () => appServers.delete(caller.pid));
  if (caller.server === 'codex-native-relay') {
    const mcp = companion.createServer();
    socket.once('close', () => void mcp.close());
    await mcp.connect(new StdioServerTransport(socket, socket));
    socket.resume();
    return;
  }
  const previous = saved.get(caller.pid);
  const restore = previous && previous.procStart === readProcessStart(caller.pid) ? previous.state : null;
  await serveCodexConnection(socket, { pid: caller.pid, restore });
  if (saved.delete(caller.pid)) writeSaved();
}

const server = net.createServer(socket => {
  let buffer = Buffer.alloc(0);
  const hello = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end === -1) { if (buffer.length > 65536) socket.destroy(); return; }
    socket.off('data', hello);
    socket.pause();
    try {
      const caller = readCodexCaller(buffer.subarray(0, end).toString('utf8'));
      if (end + 1 < buffer.length) socket.unshift(buffer.subarray(end + 1));
      socket.write('{"bridge_ready":true}\n');
      serve(socket, caller).catch(error => { log(`serve failed: ${error.message}`); socket.destroy(); });
    } catch (error) { log(`rejected hello: ${error.message}`); socket.destroy(); }
  };
  socket.on('data', hello);
  socket.on('error', () => {});
});

let exiting = false;
let waiting = null;
async function exitForNewCode(reason) {
  const busy = codexBridgeIdle() ? companion.lifecycle.inspect() : 'a Claude delivery or tool call is still open';
  if (busy && waiting !== busy) log(`new code waits: ${(waiting = busy)}`);
  if (exiting || busy) return;
  exiting = true;
  try {
    const callers = await suspendCodexCallers();
    for (const caller of callers) saved.set(caller.pid, caller);
    writeSaved();
    await companion.lifecycle.stop();
    log(`exit to load new code (${reason}); ${callers.length} bound thread(s) saved`);
    process.exit(0);
  } catch (error) {
    exiting = false;
    log(`reload deferred: ${error.message}`);
  }
}

process.umask(0o077);
fs.mkdirSync(HOME, { recursive: true });
fs.rmSync(SOCKET, { force: true });
server.listen(SOCKET, () => log(`listening on ${SOCKET}, pid ${process.pid}`));
void companion.lifecycle.activate().catch(error => log(`native relay startup failed: ${error.message}`));
setInterval(() => {
  const state = bridgeRuntime.status();
  if (!state.current) void exitForNewCode(state.reason);
}, 5000).unref();
setInterval(() => server.getConnections((error, count) => log(`connections ${count}, app-servers ${new Set(appServers.values()).size}`)), 600000).unref();
