import fs from 'node:fs';

const lifecycleTypes = new Set(['task_started', 'task_complete', 'task_completed', 'turn_started', 'turn_complete', 'turn_completed', 'turn_aborted', 'task_aborted']);

// Large conversations must not fall back to older rollout files. Read identity
// from the beginning and current context/lifecycle from a bounded suffix.
export function readRolloutState(file, { tailBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 1 || tailBytes > 64 * 1024 * 1024) throw new Error('Invalid rollout tail bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !before.size) throw new Error('Sender rollout is not a nonempty regular file');
    const read = (offset, length) => {
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = fs.readSync(fd, buffer, got, length - got, offset + got);
        if (!n) throw new Error('Sender rollout changed while reading');
        got += n;
      }
      return buffer;
    };
    const head = read(0, Math.min(before.size, 1024 * 1024));
    const firstEnd = head.indexOf(10);
    if (firstEnd < 0) throw new Error('Sender session identity exceeds bounded header');
    const first = JSON.parse(head.subarray(0, firstEnd).toString('utf8'));
    if (first.type !== 'session_meta' || !first.payload) throw new Error('Missing sender session identity');
    const offset = Math.max(0, before.size - tailBytes);
    const tail = read(offset, before.size - offset);
    if (tail[tail.length - 1] !== 10) throw new Error('Sender rollout has an incomplete final record');
    // Drop the potentially partial first line, including partial UTF-8 bytes.
    const start = offset ? tail.indexOf(10) + 1 : 0;
    let context, lifecycle;
    for (const line of tail.subarray(start).toString('utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.type === 'turn_context') context = record.payload;
      if (record.type === 'event_msg' && lifecycleTypes.has(record.payload?.type)) lifecycle = record.payload;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink()) throw new Error('Sender rollout changed while reading');
    if (!context || !lifecycle) throw new Error('Current sender context/lifecycle not found in bounded rollout tail; no older rollout used');
    return { session: first.payload, context, lifecycle };
  } finally {
    fs.closeSync(fd);
  }
}
