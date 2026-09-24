import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { activeFullAccessRunner, launchFullAccessTurn, runnerLogPath } from '../src/full-access-runner.mjs';

const FAKE_APP_SERVER = `#!${process.execPath}
const fs = require('node:fs');
const record = (message) => fs.appendFileSync(process.env.FAKE_APP_SERVER_LOG, JSON.stringify(message) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    record(message);
    if (message.id === undefined) continue;
    if (message.method === 'thread/start' && process.env.FAKE_APP_SERVER_FAIL) send({ id: message.id, error: { code: -32600, message: 'thread start refused' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }), Number(process.env.FAKE_TURN_MS ?? 50));
    } else if (message.method === 'thread/unsubscribe') send({ id: message.id, result: { status: 'unsubscribed' } });
    else send({ id: message.id, result: {} });
  }
});
process.stdin.on('end', () => { record({ closed: true }); process.exit(0); });
`;

function fixture(t, env = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'full-access-runner-')));
  const bin = path.join(directory, 'codex');
  const log = path.join(directory, 'app-server.jsonl');
  fs.writeFileSync(bin, FAKE_APP_SERVER, { mode: 0o755 });
  const saved = Object.fromEntries(['CODEX_BIN', 'CODEX_HOME', 'FAKE_APP_SERVER_LOG', 'FAKE_APP_SERVER_FAIL', 'FAKE_TURN_MS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { CODEX_BIN: bin, CODEX_HOME: directory, FAKE_APP_SERVER_LOG: log, ...env });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const messages = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { directory, messages };
}

async function until(check, timeoutMs = 10000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('full-access runner', () => {
  it('starts the thread and first turn with never approval and a danger-full-access sandbox, then releases the thread', async (t) => {
    const f = fixture(t, { FAKE_TURN_MS: '1500' });
    let guarded = 0;
    const response = await launchFullAccessTurn({ cwd: f.directory, prompt: 'Probe', title: 'Probe title', model: 'gpt-6-luna', thinking: 'low' }, { timeoutMs: 10000, beforeSend: () => { guarded++; } });
    assert.equal(guarded, 1);
    assert.deepEqual(response, { ok: true, operation: 'create_thread', result: { threadId: 'thread-1', hostId: 'local', backend: 'codex-app-server-full-access', firstTurn: { status: 'accepted', turnId: 'turn-1' } } });
    assert.equal(typeof activeFullAccessRunner('thread-1'), 'number', 'the running turn is marked as owned by the runner');
    await until(() => f.messages().some((message) => message.closed));
    await until(() => activeFullAccessRunner('thread-1') === null);
    const byMethod = Object.fromEntries(f.messages().filter((message) => message.method).map((message) => [message.method, message.params]));
    assert.equal(byMethod.initialize.clientInfo.name, 'Codex Desktop');
    assert.deepEqual(byMethod['thread/start'], { cwd: f.directory, approvalPolicy: 'never', sandbox: 'danger-full-access', threadSource: 'agent_created_thread', model: 'gpt-6-luna' });
    assert.deepEqual(byMethod['thread/name/set'], { threadId: 'thread-1', name: 'Probe title' });
    assert.deepEqual(byMethod['turn/start'], { threadId: 'thread-1', input: [{ type: 'text', text: 'Probe', text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, model: 'gpt-6-luna', effort: 'low' });
    assert.deepEqual(byMethod['thread/unsubscribe'], { threadId: 'thread-1' });
    await until(() => fs.readFileSync(runnerLogPath(), 'utf8').includes('finished: completed'));
  });

  it('reports a refused thread start as unconfirmed creation without a thread id', async (t) => {
    const f = fixture(t, { FAKE_APP_SERVER_FAIL: '1' });
    await assert.rejects(launchFullAccessTurn({ cwd: f.directory, prompt: 'Probe' }, { timeoutMs: 10000 }), /did not confirm creation: thread start refused/);
  });
});
