import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCodexAvailable, assertCodexBudget, codexWeeklyPercent } from '../src/codex-usage-guard.mjs';

const limitsFile = percent => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-guard-'));
  const file = path.join(dir, 'limits.json');
  fs.writeFileSync(file, JSON.stringify({ rateLimits: { primary: { usedPercent: percent, windowDurationMins: 10080 } } }));
  return file;
};

test('blocks Codex critics above the weekly threshold', () => {
  const file = limitsFile(99);
  assert.equal(codexWeeklyPercent(file), 99);
  assert.throws(() => assertCodexBudget({ model: 'gpt-6-sol', file }), /Codex 99 %/);
});

test('allows explicit override and computer use', () => {
  const file = limitsFile(99);
  assert.equal(assertCodexBudget({ model: 'gpt-6-sol', allowHighCodexUsage: true, file }), 99);
  assert.equal(assertCodexBudget({ model: 'gpt-6-astra', file }), 99);
});

test('allows normal creation at the threshold', () => {
  assert.equal(assertCodexBudget({ model: 'gpt-6-sol', file: limitsFile(85) }), 85);
});

test('at 100 % Desktop tasks are unavailable whatever the model or flags, with the critic and Devora hint', () => {
  const file = limitsFile(100);
  for (const args of [{ model: 'gpt-6-sol' }, { model: 'gpt-6-astra' }, { model: 'gpt-6-sol', allowHighCodexUsage: true }]) {
    assert.throws(() => assertCodexBudget({ ...args, file }), /недоступен до сброса.*Claude-сабагент.*codex-peer/s);
  }
  assert.throws(() => assertCodexAvailable(file), /сброс 14\.10/);
  assert.equal(assertCodexAvailable(limitsFile(99)), 99);
});
