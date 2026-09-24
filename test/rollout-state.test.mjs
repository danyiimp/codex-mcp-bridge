import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRolloutState } from '../src/rollout-state.mjs';

const line = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const header = line('session_meta', { id: 'thread', originator: 'Codex Desktop', source: 'vscode' });
const active = line('event_msg', { type: 'task_started', turn_id: 'current' }) + line('turn_context', { turn_id: 'current', approval_policy: 'never' });
function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, text);
  return file;
}
test('reads active context from a rollout larger than the previous whole-file limit', t => {
  const file = fixture(t, header);
  const fd = fs.openSync(file, 'r+');
  // Sparse historical line lies outside the bounded suffix; no large allocation.
  fs.writeSync(fd, Buffer.from('\n' + active), 0, Buffer.byteLength('\n' + active), 70 * 1024 * 1024);
  fs.closeSync(fd);
  const state = readRolloutState(file);
  assert.equal(state.session.id, 'thread');
  assert.equal(state.context.turn_id, 'current');
  assert.equal(state.lifecycle.type, 'task_started');
});
test('preserves terminal lifecycle so caller still rejects completed/aborted turns', t => {
  for (const type of ['task_complete', 'turn_aborted']) {
    const state = readRolloutState(fixture(t, header + active + line('event_msg', { type, turn_id: 'current' })));
    assert.equal(state.lifecycle.type, type);
  }
});
test('preserves context/lifecycle mismatch for caller verification', t => {
  const state = readRolloutState(fixture(t, header + active + line('event_msg', { type: 'task_started', turn_id: 'new' })));
  assert.notEqual(state.context.turn_id, state.lifecycle.turn_id);
});
test('rejects partial records and missing bounded context', t => {
  assert.throws(() => readRolloutState(fixture(t, header + active + '{')), /incomplete/);
  assert.throws(() => readRolloutState(fixture(t, header + active), { tailBytes: 10 }), /bounded/);
});
