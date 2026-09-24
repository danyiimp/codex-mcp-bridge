import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createCrossSessionTasks, buildOaiMessage, normalizeImages, formatImages, compactThreadRead } from '../src/cross-session-tasks.mjs';
import { DesktopTaskReceipts } from '../src/desktop-task-receipts.mjs';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t, { dispatch, beforeWrite } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cross-session-tasks-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'workspace');
  fs.mkdirSync(cwd);
  let source = { sessionId: SOURCE, cwd, name: 'Original Claude', pid: 100, dir: directory };
  const calls = [];
  const observed = new Set();
  let creates = 0;
  let sourceChecks = 0;
  let runtimeChecks = 0;
  const receipts = new DesktopTaskReceipts({ directory: path.join(directory, 'receipts') });
  const relay = { async requestDesktop(operation, args, options) {
    await beforeWrite?.({ operation, setSource: (value) => { source = { ...source, ...value }; } });
    await options.beforeSend?.();
    calls.push({ operation, args });
    const override = await dispatch?.({ operation, args, cwd, calls, setSource: (value) => { source = { ...source, ...value }; } });
    if (override !== undefined) return override;
    if (operation === 'list_projects') return { ok: true, result: { projects: [{ projectId: 'saved-project', projectKind: 'local', hostId: 'local', path: cwd, label: 'Saved workspace' }] } };
    if (operation === 'create_thread') return { ok: true, result: { threadId: ++creates === 1 ? TASK : SECOND_TASK, hostId: 'local', firstTurn: { status: 'accepted' } } };
    if (operation === 'read_thread') {
      observed.add(args.threadId);
      return { ok: true, result: { thread: { id: args.threadId, kind: 'codex', hostId: 'local', cwd, title: 'Existing task' }, turns: [{ id: 'turn', summary: 'Task progress' }] } };
    }
    if (operation === 'list_threads') return { ok: true, result: { pinnedThreads: [], threads: [...observed].map((id) => ({ id, kind: 'codex', hostId: 'local', cwd, projectId: 'saved-project' })) } };
    throw new Error(`Unexpected operation ${operation}`);
  } };
  const launches = [];
  const launchTurn = ({ cwd: launchCwd, ...args }, options) => { launches.push({ cwd: launchCwd, args }); return relay.requestDesktop('create_thread', args, options); };
  const make = () => createCrossSessionTasks({ relay, launchTurn, receipts: new DesktopTaskReceipts({ directory: receipts.directory }), getSource: () => { sourceChecks++; return { ...source }; }, assertCurrent: () => { runtimeChecks++; } });
  return { directory, cwd, calls, launches, relay, receipts, make, tasks: make(), setSource(value) { source = { ...source, ...value }; }, checks: () => ({ sourceChecks, runtimeChecks }) };
}

function pngAt(f, name = 'input.png') {
  const file = path.join(f.directory, name);
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  fs.writeFileSync(file, png);
  return file;
}

describe('cross-session native task creation', () => {
  it('creates in the verified source workspace with callback identity and unchanged permissions', async (t) => {
    const f = fixture(t);
    const result = await f.tasks.create({ request_id: 'draft-1', title: 'A visible task', message: 'Implement the requested helper.' });
    assert.equal(result.threadId, TASK);
    assert.equal(result.sourceSessionId, SOURCE);
    assert.equal(result.cwd, f.cwd);
    assert.deepEqual(f.calls.map(({ operation }) => operation), ['list_projects', 'create_thread']);
    const { args } = f.calls[1];
    assert.deepEqual(args.target, { type: 'project', projectId: 'saved-project', environment: { type: 'local' } });
    assert.equal(args.title, 'A visible task');
    assert.match(args.prompt, /read_oai_session/);
    assert.match(args.prompt, /do not send a cross-session callback/);
    assert.doesNotMatch(args.prompt, /send_to_claude_session/);
    assert.match(args.prompt, /request_id="draft-1"/);
    assert.match(args.prompt, /действуют текущие разрешения получателя/);
    assert.doesNotMatch(args.prompt, /image_gen|view_image/);
    assert.deepEqual(Object.keys(args).sort(), ['prompt', 'target', 'title']);
    assert.ok(f.checks().sourceChecks >= 3, 'source is rechecked at dispatch');
    assert.deepEqual(f.launches.map(({ cwd }) => cwd), [f.cwd]);
    assert.equal(result.permission, 'full-access');
    assert.equal(result.backend, 'codex-app-server-full-access');
  });

  it('creates every task through the full-access launcher, never through Desktop create_thread', async (t) => {
    const f = fixture(t);
    const launched = [];
    const tasks = createCrossSessionTasks({
      relay: { async requestDesktop(operation, args, options) {
        if (operation === 'create_thread') assert.fail('Desktop create_thread must not be used');
        const response = await f.relay.requestDesktop(operation, args, options);
        if (operation === 'list_threads') response.result.threads = response.result.threads.map((thread) => ({ ...thread, projectId: null }));
        return response;
      } },
      launchTurn: async (args, options) => { await options.beforeSend(); launched.push(args); return { ok: true, operation: 'create_thread', result: { threadId: TASK, hostId: 'local', firstTurn: { status: 'accepted', turnId: 'turn-1' } } }; },
      receipts: new DesktopTaskReceipts({ directory: path.join(f.directory, 'launcher-receipts') }), getSource: () => ({ sessionId: SOURCE, cwd: f.cwd, name: 'Original Claude', pid: 100, dir: f.directory }), assertCurrent: () => {},
    });
    const result = await tasks.create({ request_id: 'full-access-1', message: '\n  Run   the probe\nsecond line', model: 'gpt-6-luna', effort: 'low' });
    assert.equal(result.threadId, TASK);
    assert.equal(result.permission, 'full-access');
    assert.equal(launched.length, 1);
    assert.equal(launched[0].cwd, f.cwd);
    assert.equal(launched[0].title, 'Run the probe');
    assert.equal(launched[0].model, 'gpt-6-luna');
    assert.equal(launched[0].thinking, 'low');
    assert.match(launched[0].prompt, /request_id=full-access-1/);
    const reused = await tasks.create({ request_id: 'full-access-1', message: '\n  Run   the probe\nsecond line', model: 'gpt-6-luna', effort: 'low' });
    assert.equal(reused.reused, true);
    assert.equal(reused.threadId, TASK);
    assert.equal(reused.projectAssignmentStatus, 'unverified', 'Desktop lists full-access tasks without a project assignment');
    assert.equal(launched.length, 1);
  });

  it('keeps explicit callback mode and rejects invalid reply modes without creating a task', async (t) => {
    const f = fixture(t);
    await f.tasks.create({ request_id: 'callback', message: 'Report back.', reply_mode: 'callback' });
    assert.match(f.calls[1].args.prompt, new RegExp(`send_to_claude_session with target="${SOURCE}"|send_to_claude_session с target="${SOURCE}"`));
    assert.doesNotMatch(f.calls[1].args.prompt, /do not send a cross-session callback/);
    await assert.rejects(f.tasks.create({ request_id: 'invalid-mode', message: 'Do work.', reply_mode: 'unsafe' }), /replyMode must be/);
    assert.equal(f.calls.length, 2);
  });

  it('does not substitute a parent saved project for an unmatched directory', async (t) => {
    const f = fixture(t);
    const child = path.join(f.cwd, 'child');
    fs.mkdirSync(child);
    await assert.rejects(f.tasks.create({ cwd: child, request_id: 'unmatched', message: 'Work here.' }), /No saved local Codex Desktop project exactly matches/);
    assert.equal(f.calls.some(({ operation }) => operation === 'create_thread'), false);
  });

  it('rejects missing or unsafe request IDs, nonabsolute cwd and non-directory cwd before dispatch', async (t) => {
    const f = fixture(t);
    const file = pngAt(f);
    for (const args of [
      { message: 'Work' }, { message: 'Work', request_id: '../escape' },
      { message: 'Work', request_id: 'safe', cwd: '.' }, { message: 'Work', request_id: 'safe', cwd: file },
    ]) await assert.rejects(f.tasks.create(args));
    assert.equal(f.calls.length, 0);
  });

  it('returns the original task after restart without resending its prompt', async (t) => {
    const f = fixture(t);
    const args = { request_id: 'persistent-1', message: 'Keep this conversation.' };
    await f.tasks.create(args);
    const resumed = await f.make().create(args);
    assert.equal(resumed.threadId, TASK);
    assert.equal(resumed.reused, true);
    assert.equal(f.calls.filter(({ operation }) => operation === 'create_thread').length, 1);
    assert.equal(f.calls.some(({ operation }) => /send|resume/.test(operation)), false);
  });

  it('fails a changed message or title with the known task ID and no native call', async (t) => {
    const f = fixture(t);
    const args = { request_id: 'immutable-1', title: 'Original', message: 'First request.' };
    await f.tasks.create(args);
    for (const changed of [{ message: 'Different request.' }, { title: 'New title' }]) {
      await assert.rejects(f.make().create({ ...args, ...changed }), (error) => /different payload/.test(error.message) && error.message.includes(TASK));
    }
    assert.equal(f.calls.length, 2);
  });

  it('prevents duplicate creation when two independent helpers race on the same request', async (t) => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    let reachedCreate;
    const creating = new Promise((resolve) => { reachedCreate = resolve; });
    const f = fixture(t, { async dispatch({ operation }) {
      if (operation === 'create_thread') { reachedCreate(); await barrier; }
    } });
    const args = { request_id: 'concurrent', message: 'Create only once.' };
    const first = f.tasks.create(args);
    await creating;
    await assert.rejects(f.make().create(args), /earlier Desktop creation is pending|already in progress/);
    release();
    assert.equal((await first).threadId, TASK);
    assert.equal(f.calls.filter(({ operation }) => operation === 'create_thread').length, 1);
  });

  it('keeps uncertain creation blocked after timeout and exposes its receipt without resending', async (t) => {
    const f = fixture(t, { dispatch({ operation }) { if (operation === 'create_thread') throw new Error('Native response timeout'); } });
    const args = { request_id: 'uncertain-1', message: 'Work once.' };
    await assert.rejects(f.tasks.create(args), /creation receipt blocks duplicate/);
    const receipt = await f.make().receipt({ request_id: args.request_id });
    assert.equal(receipt.state, 'unknown');
    assert.equal(receipt.threadId, null);
    await assert.rejects(f.make().create(args), /earlier Desktop creation is unknown/);
    assert.equal(f.calls.filter(({ operation }) => operation === 'create_thread').length, 1);
    assert.equal(f.calls.length, 2);
  });

  it('fails native ok=false and isError without exposing returned error contents', async (t) => {
    for (const rejected of [{ ok: false, result: { secret: 'DO-NOT-ECHO' } }, { ok: true, result: { isError: true, content: 'DO-NOT-ECHO' } }]) {
      const f = fixture(t, { dispatch({ operation }) { if (operation === 'create_thread') return rejected; } });
      await assert.rejects(f.tasks.create({ request_id: 'native-rejected', message: 'Work once.' }), (error) => /did not confirm/.test(error.message) && !error.message.includes('DO-NOT-ECHO'));
      assert.equal((await f.tasks.receipt({ request_id: 'native-rejected' })).state, 'unknown');
    }
  });

  it('rechecks the source after project lookup and refuses creation when it changed', async (t) => {
    const f = fixture(t, { dispatch({ operation, setSource }) { if (operation === 'list_projects') setSource({ sessionId: OTHER_SOURCE }); } });
    await assert.rejects(f.tasks.create({ request_id: 'source-changed', message: 'Do work.' }), /calling Claude session changed/);
    assert.deepEqual(f.calls.map(({ operation }) => operation), ['list_projects']);
    f.setSource({ sessionId: SOURCE });
    assert.equal((await f.tasks.receipt({ request_id: 'source-changed' })).state, 'unknown');
  });

  it('checks the verified source immediately before the native transport writes creation', async (t) => {
    const f = fixture(t, { beforeWrite({ operation, setSource }) {
      if (operation === 'create_thread') setSource({ pid: 101 });
    } });
    await assert.rejects(f.tasks.create({ request_id: 'changed-at-write', message: 'Do work.' }), /calling Claude session changed/);
    assert.deepEqual(f.calls.map(({ operation }) => operation), ['list_projects']);
    f.setSource({ pid: 100 });
    assert.equal((await f.tasks.receipt({ request_id: 'changed-at-write' })).state, 'unknown');
  });

  it('scopes receipts to the original Claude session', async (t) => {
    const f = fixture(t);
    const args = { request_id: 'same-user-key', message: 'Do work.' };
    await f.tasks.create(args);
    const original = await f.tasks.receipt({ request_id: args.request_id });
    assert.equal(original.threadId, TASK);
    const count = f.calls.length;
    f.setSource({ sessionId: OTHER_SOURCE });
    assert.equal((await f.tasks.receipt({ request_id: args.request_id })).state, 'absent');
    assert.equal(f.calls.length, count);
    assert.equal((await f.tasks.create(args)).threadId, SECOND_TASK);
    f.setSource({ sessionId: SOURCE });
    assert.equal((await f.tasks.receipt({ request_id: args.request_id })).threadId, TASK);
  });
});

describe('cross-session image inputs and bounded read', () => {
  it('validates and canonicalizes images and supplies explicit pixel-loading instructions', async (t) => {
    const f = fixture(t);
    const file = pngAt(f);
    const link = path.join(f.directory, 'input-link.png');
    fs.symlinkSync(file, link);
    const images = await normalizeImages([{ path: link, role: 'edit_target', note: 'Keep the shape.' }]);
    assert.deepEqual(images, [{ path: file, role: 'edit_target', note: 'Keep the shape.' }]);
    assert.match(formatImages(images), /not attached pixels/);
    assert.match(formatImages(images), /view_image/);
    const created = await f.tasks.create({ request_id: 'image-round-1', message: 'Describe the attached cup.', images });
    assert.equal(created.threadId, TASK);
    const prompt = f.calls[1].args.prompt;
    assert.match(prompt, /Describe the attached cup/);
    assert.match(prompt, /"role":"edit_target"/);
    assert.doesNotMatch(prompt, /imagegen|image_gen|referenced_image_paths|num_last_images_to_include/);
    assert.ok(prompt.includes(file));
    assert.doesNotMatch(prompt, /data:image/);
  });

  it('supports a callback prompt for follow-up images without a creation request_id', async (t) => {
    const f = fixture(t);
    const message = await buildOaiMessage({ source: { sessionId: SOURCE, cwd: f.cwd, name: 'Claude' }, message: 'Now use this reference.', images: [{ path: pngAt(f), role: 'reference' }] });
    assert.match(message, new RegExp(`target="${SOURCE}"`));
    assert.match(message, /"role":"reference"/);
    assert.doesNotMatch(message, /request_id=/);
  });

  it('rejects nonimages, missing files, relative paths, invalid roles and excess inputs', async (t) => {
    const f = fixture(t);
    const file = pngAt(f);
    const text = path.join(f.directory, 'not-an-image.png');
    fs.writeFileSync(text, 'PRIVATE_CONTENT_SHOULD_NOT_LEAK');
    const bad = [
      [{ path: text, role: 'reference' }], [{ path: f.directory, role: 'reference' }],
      [{ path: path.join(f.directory, 'missing.png'), role: 'reference' }], [{ path: 'relative.png', role: 'reference' }],
      [{ path: file, role: 'unknown' }], Array.from({ length: 6 }, () => ({ path: file, role: 'reference' })),
    ];
    for (const images of bad) await assert.rejects(normalizeImages(images), (error) => !error.message.includes('PRIVATE_CONTENT'));
  });

  it('reads the exact local task with bounded summaries without creating, sending or resuming', async (t) => {
    const f = fixture(t);
    const result = await f.tasks.read({ target: TASK, turn_limit: 2 });
    assert.equal(result.thread.id, TASK);
    assert.deepEqual(f.calls, [{ operation: 'read_thread', args: { threadId: TASK, hostId: 'local', turnLimit: 2, includeOutputs: false, maxOutputCharsPerItem: 4000 } }]);
    await assert.rejects(f.tasks.read({ target: 'by-name' }), /exact UUID/);
    await assert.rejects(f.tasks.read({ target: TASK, turn_limit: 11 }), /turn_limit/);
    assert.equal(f.calls.length, 1);
  });

  it('removes inline image bytes and bounds summaries while retaining output paths and pagination', async (t) => {
    const blob = 'A'.repeat(2400000);
    let original;
    let finalText;
    const f = fixture(t, { dispatch({ operation, cwd }) {
      if (operation !== 'read_thread') return;
      finalText = JSON.stringify({ status: 'completed', files: [path.join(cwd, 'output', 'green-cup.png')] });
      original = {
        thread: { id: TASK, hostId: 'local', kind: 'codex', cwd, title: 'Images' },
        turns: [{ id: 'turn', status: 'completed', items: [
          { type: 'imageGeneration', id: 'generated', status: 'completed', result: blob, savedPath: path.join(cwd, 'output', 'green-cup.png'), revisedPrompt: 'Keep the shape. '.repeat(1000) },
          { type: 'image', mimeType: 'image/png', data: blob },
          { type: 'toolResult', metadata: { b64_json: blob, imageBase64: blob, preview: `data:image/png;base64,${blob}`, text: `Preview: data:image/png;base64,${blob} end.`, nested: { note: 'n'.repeat(20000) } } },
          { type: 'assistantMessage', text: finalText },
        ] }],
        nextCursor: 'next-page-token', hasMore: true,
      };
      return { ok: true, result: original };
    } });
    const result = await f.tasks.read({ target: TASK });
    const [generated, image, tool, final] = result.turns[0].items;
    assert.equal(Object.hasOwn(generated, 'result'), false);
    assert.equal(generated.status, 'completed');
    assert.equal(generated.savedPath, path.join(f.cwd, 'output', 'green-cup.png'));
    assert.ok(generated.revisedPrompt.length <= 4000);
    assert.match(generated.revisedPrompt, /\[truncated\]$/);
    assert.equal(Object.hasOwn(image, 'data'), false);
    assert.equal(Object.hasOwn(tool.metadata, 'b64_json'), false);
    assert.equal(Object.hasOwn(tool.metadata, 'imageBase64'), false);
    assert.equal(Object.hasOwn(tool.metadata, 'preview'), false);
    assert.equal(tool.metadata.text, 'Preview: [inline data omitted] end.');
    assert.ok(tool.metadata.nested.note.length <= 4000);
    assert.equal(final.text, finalText);
    assert.equal(result.nextCursor, 'next-page-token');
    assert.equal(result.hasMore, true);
    assert.ok(JSON.stringify(result).length < 10000);
    assert.equal(original.turns[0].items[0].result, blob);
    assert.equal(original.turns[0].items[0].revisedPrompt, 'Keep the shape. '.repeat(1000));
    assert.equal(original.turns[0].items[1].data, blob);
    assert.equal(original.turns[0].items[2].metadata.preview, `data:image/png;base64,${blob}`);
    assert.equal(f.calls[0].args.includeOutputs, false);
  });

  it('enforces a total frame budget across many items and retains final JSON and image paths', () => {
    const files = ['/absolute/output/green-cup.png'];
    const final = { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ request_id: 'multi-turn', status: 'completed', files }) };
    const input = {
      thread: { id: TASK, kind: 'codex', hostId: 'local', cwd: '/absolute/project', status: { type: 'idle' } },
      turns: Array.from({ length: 10 }, (_, index) => ({ id: `turn-${index}`, status: 'completed', items: [
        ...Array.from({ length: 80 }, (_, item) => ({ type: 'commandExecution', id: `command-${item}`, output: 'Большой вывод '.repeat(1000) })),
        { type: 'imageGeneration', status: 'completed', savedPath: files[0], revisedPrompt: 'Preserve the handle.'.repeat(100) },
        final,
      ] })),
      page: { nextCursor: 'older-page', hasMore: true }, nextCursor: 'older-page', hasMore: true,
    };
    const compact = compactThreadRead(input);
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 96 * 1024);
    assert.equal(compact.bridgeReadTruncated, true);
    assert.deepEqual(compact.thread, input.thread);
    assert.deepEqual(compact.page, input.page);
    assert.equal(compact.nextCursor, 'older-page');
    assert.equal(compact.turns.length, 10);
    for (const turn of compact.turns) {
      assert.deepEqual(turn.items.find((item) => item.phase === 'final_answer'), final);
      assert.equal(turn.items.find((item) => item.type === 'imageGeneration').savedPath, files[0]);
    }
    assert.equal(input.turns[0].items.length, 82);
    assert.ok(input.turns[0].items[0].output.length > 4000);
  });

  it('fails closed when essential metadata cannot fit within the read frame budget', () => {
    const input = { thread: { id: TASK }, turns: [{ id: 'turn', items: [
      { type: 'agentMessage', phase: 'final_answer', text: 'done', files: Array.from({ length: 50000 }, (_, index) => `/output/${index}.png`) },
    ] }] };
    assert.throws(() => compactThreadRead(input), /exceed the bounded read budget/);
  });

  it('rejects a foreign host, wrong task ID or non-Codex task in native read responses', async (t) => {
    for (const changed of [{ id: SECOND_TASK }, { hostId: 'remote' }, { kind: 'chatgpt' }]) {
      const f = fixture(t, { dispatch({ operation, cwd }) { if (operation === 'read_thread') return { ok: true, result: { thread: { id: TASK, hostId: 'local', kind: 'codex', cwd, ...changed } } }; } });
      await assert.rejects(f.tasks.read({ target: TASK }), /exact requested local Codex task/);
      assert.equal(f.calls.length, 1);
    }
  });
});
