import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, it } from 'node:test';
import { discoverClaudeConfigDirs, discoverClaudeDataDirs } from '../src/claude-config-dirs.mjs';
import { listClaudeSessions, assertClaudeSessionProcess, PeerEndpoint, peerKeyPath, readTranscript } from '../src/peer-protocol.mjs';

let root, saved;
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'CCS_HOME', 'CCS_DIR'];
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-regression-'));
  for (const key of envKeys) delete process.env[key];
  process.env.HOME = root;
});
afterEach(() => {
  for (const key of envKeys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(root, { recursive: true, force: true });
});
function registry(config, id = 'current-session', name = 'sample-peer', pid = process.pid) {
  const directory = path.join(config, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const socket = path.join(root, `${id}.sock`);
  fs.writeFileSync(socket, '');
  const procStart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();
  const file = path.join(directory, `${pid}.json`);
  const entry = { pid, sessionId: id, name, entrypoint: 'cli', procStart, cwd: root, messagingSocketPath: socket };
  fs.writeFileSync(file, JSON.stringify(entry));
  return { file, entry, directory, socket };
}

it('finds CCS profiles when the default Claude registry is empty', () => {
  fs.mkdirSync(path.join(root, '.claude/sessions'), { recursive: true });
  const config = path.join(root, '.ccs/instances/work');
  registry(config);
  const diagnostic = {};
  const [session] = listClaudeSessions({ diagnostics: diagnostic });
  assert.equal(session.sessionId, 'current-session');
  assert.equal(session.dir, fs.realpathSync(path.join(config, 'sessions')));
  assert.deepEqual(session.profileSources, ['CCS:work']);
  assert(diagnostic.directories.some(row => row.sources.includes('CCS:work')));
  assertClaudeSessionProcess(session);
});
it('discovers a newly created profile without reimporting the module', () => {
  assert.equal(listClaudeSessions().length, 0);
  registry(path.join(root, '.ccs/instances/new-profile'));
  assert.equal(listClaudeSessions()[0].name, 'sample-peer');
});
it('honors explicit Claude config, CCS_DIR and legacy CCS_HOME semantics', () => {
  const explicit = path.join(root, 'explicit');
  process.env.CLAUDE_CONFIG_DIR = explicit;
  registry(explicit, 'explicit');
  process.env.CCS_HOME = path.join(root, 'legacy-home');
  registry(path.join(process.env.CCS_HOME, '.claude'), 'legacy-default');
  registry(path.join(process.env.CCS_HOME, '.ccs/instances/legacy'), 'legacy-profile');
  assert.deepEqual(new Set(listClaudeSessions().map(row => row.sessionId)), new Set(['explicit', 'legacy-default', 'legacy-profile']));
  process.env.CCS_DIR = path.join(root, 'custom-ccs');
  registry(path.join(process.env.CCS_DIR, 'instances/custom'), 'custom-profile');
  assert.deepEqual(new Set(listClaudeSessions().map(row => row.sessionId)), new Set(['explicit', 'legacy-default', 'custom-profile']));
});
it('deduplicates shared registry symlinks while retaining profile provenance', () => {
  const shared = path.join(root, 'shared');
  registry(shared);
  for (const name of ['a', 'b']) {
    const instance = path.join(root, '.ccs/instances', name);
    fs.mkdirSync(instance, { recursive: true });
    fs.symlinkSync(path.join(shared, 'sessions'), path.join(instance, 'sessions'));
  }
  const dirs = discoverClaudeDataDirs('sessions');
  assert.equal(dirs.directories.length, 1);
  assert.deepEqual(dirs.directories[0].sources, ['CCS:a', 'CCS:b']);
  assert.equal(listClaudeSessions().length, 1);
});
it('ignores .locks, non-directory metadata and broken profile links', () => {
  const instances = path.join(root, '.ccs/instances');
  registry(path.join(instances, 'work'));
  registry(path.join(instances, '.locks'), 'should-not-be-seen');
  fs.writeFileSync(path.join(instances, 'notes'), 'not a profile');
  fs.symlinkSync(path.join(root, 'missing'), path.join(instances, 'broken'));
  assert.deepEqual(listClaudeSessions().map(row => row.sessionId), ['current-session']);
});
it('keeps other profiles available if one registry cannot be read', () => {
  const a = registry(path.join(root, '.ccs/instances/a'), 'a');
  registry(path.join(root, '.ccs/instances/b'), 'b');
  const original = fs.readdirSync;
  fs.readdirSync = function(directory, ...args) {
    if (String(directory) === fs.realpathSync(a.directory)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original.call(this, directory, ...args);
  };
  try {
    const diagnostic = {};
    assert.deepEqual(listClaudeSessions({ diagnostics: diagnostic }).map(row => row.sessionId), ['b']);
    assert(diagnostic.warnings.some(row => row.code === 'EACCES'));
  } finally { fs.readdirSync = original; }
});
it('does not hide a different session UUID just because its PID matches a stale profile entry', () => {
  registry(path.join(root, '.ccs/instances/a'), 'old-session');
  registry(path.join(root, '.ccs/instances/b'), 'new-session');
  assert.equal(listClaudeSessions().length, 2);
});
it('refuses an identity that changed between discovery and send', () => {
  const r = registry(path.join(root, '.ccs/instances/work'));
  const session = listClaudeSessions()[0];
  fs.writeFileSync(r.file, JSON.stringify({ ...r.entry, sessionId: 'restarted-session' }));
  assert.throws(() => assertClaudeSessionProcess(session), /registry changed/);
});
it('reads transcript history from the selected CCS profile', () => {
  const config = path.join(root, '.ccs/instances/work');
  const directory = path.join(config, 'projects', '-workspace');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'CCS transcript' }] } }) + '\n');
  assert.equal(readTranscript('session', '/workspace').messages[0].text, 'CCS transcript');
});
it('loads the receiver auth key from its CCS registry before sending', async () => {
  const r = registry(path.join(root, '.ccs/instances/work'));
  fs.unlinkSync(r.socket);
  const token = 'a'.repeat(32);
  fs.writeFileSync(peerKeyPath(process.pid, r.socket, r.directory), JSON.stringify({ peerToken: token, procStart: r.entry.procStart }));
  let resolveFrame;
  const frame = new Promise(resolve => { resolveFrame = resolve; });
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', data => { buffer += data; });
    socket.on('end', () => resolveFrame(buffer.trim().split('\n').map(JSON.parse)));
  });
  await new Promise(resolve => server.listen(r.socket, resolve));
  const peer = new PeerEndpoint();
  try {
    await peer.send(r.socket, 'CCS auth test', { permissionMode: 'prompting' });
    const frames = await frame;
    assert.deepEqual(frames[0], { type: 'auth', token });
    assert.match(frames[1].message.content, /from-mode="prompting"/);
  } finally { peer.stop(); await new Promise(resolve => server.close(resolve)); }
});
