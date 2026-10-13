#!/usr/bin/env node
// One cross-session-bridge for every Claude session and every Codex thread (Mac memory, owner #39883; P0 Mac memory,
// harry 10.10.2026): each session and each loaded thread ran its own supervisor + worker pair (~65–120 MB apiece).
// Claude sessions run scripts/bridge-shim.py, which connects to daemon.sock and first sends one line
// {"bridge_caller":{"ppid":<its parent, the Claude process>,"configDir":<CLAUDE_CONFIG_DIR or null>}}; claudeSource()
// verifies that pid against the session registry exactly as a per-session worker verified its own parent.
// Codex threads run scripts/bridge-shim.py cross-session-bridge, which connects to codex-daemon.sock and first sends
// {"bridge_caller":{"codex":{"pid":<the shim's pid>,"server":"cross-session-bridge"}}}.
// The caller's task and turn still come from the _meta of every tool call and are verified against its rollout exactly
// as before; the shim's pid only names the thread's peer entry in Claude's registry (it lives and dies with the thread).
// The native relay companion is not served here: Codex Desktop accepts a peer on its tools pipe only when the peer, its
// parent and grandparent carry OpenAI's signature (dynamic_app_tools_peer_rejected reason=untrusted-process-ancestry),
// so it stays a child of the Desktop app-server (cua_node src/mcp-supervisor.mjs native-relay-companion.mjs).
// When the source on disk changes, the daemon exits as soon as nothing is in flight, after saving each bound thread's
// reply address; launchd starts the new code, the shims reconnect and the threads get their addresses back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

process.env.CROSS_SESSION_BRIDGE_DAEMON = '1';
const { serveClaudeConnection, serveCodexConnection, codexBridgeIdle, suspendCodexCallers, bridgeRuntime } = await import('./cross-session-bridge.mjs');
const { readProcessStart } = await import('./peer-protocol.mjs');

const HOME = path.join(os.homedir(), '.local', 'share', 'cross-session-bridge');
const CLAUDE_SOCKET = process.env.CROSS_SESSION_BRIDGE_SOCKET || path.join(HOME, 'daemon.sock');
const CODEX_SOCKET = process.env.CROSS_SESSION_BRIDGE_CODEX_SOCKET || path.join(HOME, 'codex-daemon.sock');
const STATE = process.env.CROSS_SESSION_BRIDGE_CODEX_STATE || path.join(HOME, 'codex-callers.json');
const log = message => process.stderr.write(`${new Date().toISOString()} ${message}\n`);

function readClaudeCaller(line) {
  const { ppid, configDir } = JSON.parse(line).bridge_caller ?? {};
  if (!Number.isInteger(ppid) || ppid <= 1) throw new Error('bridge_caller.ppid must be a process id');
  if (configDir !== null && typeof configDir !== 'string') throw new Error('bridge_caller.configDir must be a path or null');
  return { ppid, configDir };
}

const codexShims = new Set();
function readCodexCaller(line) {
  const { pid, server } = JSON.parse(line).bridge_caller?.codex ?? {};
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('bridge_caller.codex.pid must be a process id');
  if (server !== 'cross-session-bridge') throw new Error('bridge_caller.codex.server must be cross-session-bridge');
  if (codexShims.has(pid)) throw new Error(`process ${pid} is already connected`);
  // The socket is private to this user; the pid must still be a running shim for the server it names, so a stale or
  // mistyped hello cannot take another thread's peer address.
  const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim().split(/\s+/);
  if (!command.some(word => word.endsWith('/bridge-shim.py') || word.endsWith('/codex-bridge-shim.py')) || command.at(-1) !== server) throw new Error(`process ${pid} is not a ${server} shim`);
  return { pid };
}

function savedCallers() {
  try { return new Map(JSON.parse(fs.readFileSync(STATE, 'utf8')).map(entry => [entry.pid, entry])); }
  catch { return new Map(); }
}
const saved = savedCallers();
const writeSaved = () => fs.writeFileSync(STATE, JSON.stringify([...saved.values()]), { mode: 0o600 });

async function serveCodex(socket, { pid }) {
  codexShims.add(pid);
  socket.once('close', () => codexShims.delete(pid));
  const previous = saved.get(pid);
  const restore = previous && previous.procStart === readProcessStart(pid) ? previous.state : null;
  await serveCodexConnection(socket, { pid, restore });
  if (saved.delete(pid)) writeSaved();
}

function listen(socketPath, readCaller, serve) {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    const hello = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end === -1) { if (buffer.length > 65536) socket.destroy(); return; }
      socket.off('data', hello);
      socket.pause();
      try {
        const caller = readCaller(buffer.subarray(0, end).toString('utf8'));
        if (end + 1 < buffer.length) socket.unshift(buffer.subarray(end + 1));
        socket.write('{"bridge_ready":true}\n');
        serve(socket, caller).catch(error => { log(`serve failed: ${error.message}`); socket.destroy(); });
      } catch (error) { log(`rejected hello: ${error.message}`); socket.destroy(); }
    };
    socket.on('data', hello);
    socket.on('error', () => {});
  });
  fs.rmSync(socketPath, { force: true });
  server.listen(socketPath, () => log(`listening on ${socketPath}, pid ${process.pid}`));
  return server;
}

let exiting = false;
let waiting = null;
async function exitForNewCode(reason) {
  const busy = codexBridgeIdle() ? null : 'a Claude delivery or tool call is still open';
  if (busy && waiting !== busy) log(`new code waits: ${(waiting = busy)}`);
  if (exiting || busy) return;
  exiting = true;
  try {
    const callers = await suspendCodexCallers();
    for (const caller of callers) saved.set(caller.pid, caller);
    writeSaved();
    log(`exit to load new code (${reason}); ${callers.length} bound thread(s) saved`);
    process.exit(0);
  } catch (error) {
    exiting = false;
    log(`reload deferred: ${error.message}`);
  }
}

process.umask(0o077);
fs.mkdirSync(HOME, { recursive: true });
const claudeServer = listen(CLAUDE_SOCKET, readClaudeCaller, serveClaudeConnection);
const codexServer = listen(CODEX_SOCKET, readCodexCaller, serveCodex);
setInterval(() => {
  const state = bridgeRuntime.status();
  if (!state.current) void exitForNewCode(state.reason);
}, 5000).unref();
setInterval(() => claudeServer.getConnections((error, claude) =>
  codexServer.getConnections((error, codex) => log(`connections: claude ${claude}, codex ${codex}`))), 600000).unref();
