import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalDirectory, claudeEnvironment, claudeLaunchArgs, createClaudeSessions, resolveClaudeProfile } from '../src/claude-session-create.mjs';
import { DesktopTaskReceipts } from '../src/desktop-task-receipts.mjs';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-create-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'workspace');
  const configDir = path.join(directory, 'profile-default');
  const otherConfig = path.join(directory, 'profile-other');
  for (const entry of [cwd, configDir, otherConfig]) fs.mkdirSync(entry);
  const store = new DesktopTaskReceipts({ directory: path.join(directory, 'receipts') });
  const profiles = new Map([['default', configDir], ['other', otherConfig]]);
  const f = {
    directory, cwd, configDir, otherConfig, store, profiles,
    source: { threadId: SOURCE, turnId: TURN, cwd, permissionMode: 'bypass' },
    calls: [], launches: [], catalogs: [], rows: new Map(), writes: [], sourceChecks: 0, runtimeChecks: 0,
    key(requestId, source = SOURCE, targetCwd = cwd) { return store.key({ cwd: targetCwd, name: `codex:${source}:${requestId}`, prompt: '' }).key; },
    read(requestId) { return store.read(f.key(requestId)); },
    candidate(record, patch = {}) { return { kind: 'background', sessionId: SESSION, name: record.claude.name, cwd: record.cwd, startedAt: record.startedAt, state: 'running', status: 'working', ...patch }; },
  };
  const run = async (args, options) => {
    const call = { args, options };
    f.calls.push(call);
    if (args[0] === 'agents') {
      f.catalogs.push(call);
      if (f.onCatalog) return f.onCatalog(call);
      return { stdout: JSON.stringify(f.rows.get(options.configDir) ?? []), stderr: '' };
    }
    f.launches.push(call);
    const record = f.writes.at(-1);
    const result = await f.onLaunch?.({ ...call, record });
    if (result !== undefined) return result;
    f.rows.set(options.configDir, [f.candidate(record)]);
    return { stdout: 'Native background agent started', stderr: '' };
  };
  f.make = (overrides = {}) => {
    const independentStore = new DesktopTaskReceipts({ directory: store.directory });
    return createClaudeSessions({
      run,
      getSource: async () => { f.sourceChecks++; await f.onSource?.(f.sourceChecks); return { ...f.source }; },
      assertCurrent: async () => { f.runtimeChecks++; await f.onCurrent?.(f.runtimeChecks); },
      resolveProfile: profile => { if (!profiles.has(profile)) throw new Error('Unknown profile'); return profiles.get(profile); },
      receipts: {
        key: args => independentStore.key(args),
        read: key => independentStore.read(key),
        withLock: (key, callback) => independentStore.withLock(key, callback),
        async write(key, record) {
          await f.beforeWrite?.(record);
          await independentStore.write(key, record);
          f.writes.push(record);
          await f.afterWrite?.(record);
        },
      },
      ...overrides,
    });
  };
  f.tasks = f.make();
  return f;
}

describe('native Claude session creation', () => {
  it('persists pending before launch and uses the requested profile, cwd, model and effort', async t => {
    const f = fixture(t);
    const args = { request_id: 'configured', title: 'Visible title', message: 'Private request body that is not a title.', profile: 'other', model: 'sonnet', effort: 'high', permission_mode: 'bypassPermissions', mcp_mode: 'none' };
    f.onLaunch = async ({ record, options, args: cli }) => {
      const saved = await f.read(args.request_id);
      assert.equal(saved.state, 'pending');
      assert.equal(saved.threadId, undefined, 'Claude allocates the native session ID');
      assert.deepEqual(options, { cwd: f.cwd, configDir: f.otherConfig });
      assert.equal(cli.at(-1), args.message);
      assert.equal(cli.at(-2), '--');
      assert.ok(cli.includes('--dangerously-skip-permissions'));
      assert.equal(cli[cli.indexOf('--model') + 1], 'sonnet');
      assert.equal(cli[cli.indexOf('--effort') + 1], 'high');
      assert.ok(cli.includes('--strict-mcp-config'));
      assert.ok(!JSON.stringify(saved).includes(args.message));
      assert.equal(record.claude.configDir, f.otherConfig);
    };
    const result = await f.tasks.create(args);
    assert.equal(result.requestState, 'known');
    assert.equal(result.sessionId, SESSION);
    assert.equal(result.reused, false);
    assert.equal(result.permissionMode, 'bypassPermissions');
    assert.deepEqual(result.attach, ['claude', 'attach', SESSION.slice(0, 8)]);
    assert.deepEqual(result.attachEnvironment, { CLAUDE_CONFIG_DIR: f.otherConfig });
    assert.deepEqual(f.writes.map(record => record.state), ['pending', 'unknown', 'known']);
    assert.ok(f.sourceChecks >= 3, 'caller is checked before preparation, before receipt, and before launch');
    assert.ok(f.runtimeChecks >= 3);
    assert.equal((await f.read(args.request_id)).threadId, SESSION);
    assert.ok(f.catalogs.every(call => call.options.configDir === f.otherConfig));
  });

  it('rejects every changed launch parameter before another native call', async t => {
    const f = fixture(t);
    const args = { request_id: 'immutable', title: 'Original', message: 'Original request', model: 'sonnet', effort: 'high' };
    await f.tasks.create(args);
    const calls = f.calls.length;
    for (const changed of [{ title: 'Other' }, { message: 'Other' }, { model: 'opus' }, { effort: 'max' }, { permission_mode: 'acceptEdits' }, { profile: 'other' }, { mcp_mode: 'none' }]) {
      await assert.rejects(f.make().create({ ...args, ...changed }), /different launch parameters/);
    }
    assert.equal(f.calls.length, calls);
    assert.equal(f.launches.length, 1);
  });

  it('returns the original session after restart without launching it again', async t => {
    const f = fixture(t);
    const args = { request_id: 'restart', message: 'Run once.' };
    const original = await f.tasks.create(args);
    const repeated = await f.make().create(args);
    assert.equal(repeated.sessionId, original.sessionId);
    assert.equal(repeated.reused, true);
    assert.equal(f.launches.length, 1);
    assert.equal((await f.make().receipt({ request_id: args.request_id })).sessionId, SESSION);
  });

  it('uses an exclusive durable lock when separate helpers race before the pending write', async t => {
    const f = fixture(t);
    const reachedWrite = deferred();
    const releaseWrite = deferred();
    f.beforeWrite = async record => { if (record.state === 'pending') { reachedWrite.resolve(); await releaseWrite.promise; } };
    const args = { request_id: 'concurrent', message: 'One background session.' };
    const first = f.tasks.create(args);
    await reachedWrite.promise;
    try {
      await assert.rejects(f.make().create(args), /already in progress/);
      assert.equal(f.launches.length, 0);
    } finally { releaseWrite.resolve(); }
    assert.equal((await first).sessionId, SESSION);
    assert.equal(f.launches.length, 1);
  });

  it('does not launch again while an earlier native launch is still pending', async t => {
    const f = fixture(t);
    const started = deferred();
    const release = deferred();
    f.onLaunch = async () => { started.resolve(); await release.promise; };
    const args = { request_id: 'in-flight', message: 'One background session.' };
    const first = f.tasks.create(args);
    await started.promise;
    try {
      const repeated = await f.make().create(args);
      assert.equal(repeated.requestState, 'pending');
      assert.equal(repeated.sessionId, null);
      assert.equal(repeated.reused, true);
      assert.equal(f.launches.length, 1);
    } finally { release.resolve(); }
    assert.equal((await first).sessionId, SESSION);
  });

  it('rejects a stale source before writing a receipt', async t => {
    const f = fixture(t);
    f.onSource = count => { if (count === 2) f.source.turnId = OTHER_SESSION; };
    await assert.rejects(f.tasks.create({ request_id: 'stale-before', message: 'Do not launch.' }), /caller changed/);
    assert.equal(await f.read('stale-before'), null);
    assert.equal(f.calls.length, 0);
  });

  it('rechecks thread, turn, cwd, permissions and runtime after the durable receipt', async t => {
    for (const changed of [{ threadId: OTHER_SESSION }, { turnId: OTHER_SESSION }, { cwd: null }, { permissionMode: 'prompting' }, { runtime: true }]) {
      const f = fixture(t);
      const alternateCwd = path.join(f.directory, 'alternate');
      fs.mkdirSync(alternateCwd);
      f.afterWrite = record => {
        if (record.state !== 'pending') return;
        if (changed.runtime) f.onCurrent = () => { throw new Error('Runtime source changed'); };
        else f.source = { ...f.source, ...changed, ...(changed.cwd === null ? { cwd: alternateCwd } : {}) };
      };
      await assert.rejects(f.tasks.create({ request_id: 'stale-at-launch', message: 'Do not launch.' }), /caller changed|Runtime source changed/);
      assert.equal(f.calls.length, 0);
      assert.equal((await f.read('stale-at-launch')).state, 'pending');
    }
  });

  it('rejects unverified sources and prompting-to-bypass launch before native calls', async t => {
    const f = fixture(t);
    const args = { request_id: 'permissions', message: 'Do work.' };
    for (const invalid of [{ threadId: 'unverified' }, { turnId: null }, { permissionMode: 'unknown' }]) {
      const original = f.source;
      f.source = { ...original, ...invalid };
      await assert.rejects(f.tasks.create(args), /verified active Codex caller/);
      f.source = original;
    }
    f.source.permissionMode = 'prompting';
    await assert.rejects(f.tasks.create({ ...args, permission_mode: 'bypassPermissions' }), /prompting caller cannot/);
    assert.equal(f.calls.length, 0);
    const created = await f.tasks.create(args);
    assert.equal(created.permissionMode, 'manual');
    assert.ok(!f.launches[0].args.includes('--dangerously-skip-permissions'));
  });

  it('rejects invalid payloads and unknown profiles before writing or launching', async t => {
    const f = fixture(t);
    const regularFile = path.join(f.directory, 'file');
    fs.writeFileSync(regularFile, 'content');
    const args = { request_id: 'valid', message: 'Do work.' };
    for (const invalid of [{ request_id: undefined }, { request_id: '../escape' }, { cwd: '.' }, { cwd: regularFile }, { message: '' }, { message: 'bad\0prompt' }, { message: 'x'.repeat(100001) }, { title: 'bad\ntitle' }, { model: '--help' }, { effort: 'unbounded' }, { permission_mode: 'unknown' }, { mcp_mode: 'unknown' }, { profile: 'missing' }]) {
      await assert.rejects(f.tasks.create({ ...args, ...invalid }));
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  });

  it('canonicalizes workspace aliases and scopes request IDs to the source and workspace', async t => {
    const f = fixture(t);
    const alias = path.join(f.directory, 'workspace-alias');
    fs.symlinkSync(f.cwd, alias, 'dir');
    const args = { request_id: 'scoped', message: 'Work in this project.' };
    await f.tasks.create({ ...args, cwd: alias });
    assert.equal(f.launches[0].options.cwd, f.cwd);
    assert.equal((await f.make().create(args)).reused, true);
    f.source.threadId = OTHER_SESSION;
    assert.equal((await f.tasks.receipt({ request_id: args.request_id })).requestState, 'missing');
    await f.tasks.create(args);
    const otherCwd = path.join(f.directory, 'other-project');
    fs.mkdirSync(otherCwd);
    await f.tasks.create({ ...args, cwd: otherCwd });
    assert.equal(f.launches.length, 3);
  });

  it('accepts whitespace in a prompt without putting control characters in the derived session name', async t => {
    const f = fixture(t);
    const result = await f.tasks.create({ request_id: 'derived-title', message: '\n  Implement\tthis helper\r\nContinue here.' });
    assert.equal(result.sessionId, SESSION);
    assert.doesNotMatch(result.name, /[\x00-\x1f]/);
    assert.equal(f.launches[0].args.at(-1), '\n  Implement\tthis helper\r\nContinue here.');
  });

  it('blocks unsafe Claude receipt metadata without overwriting it or launching again', async t => {
    const f = fixture(t);
    const args = { request_id: 'unsafe-metadata', title: 'Public title', message: 'Private request.' };
    await f.tasks.create(args);
    const original = await f.read(args.request_id);
    const file = path.join(f.store.directory, `${original.key}.json`);
    const callCount = f.calls.length;
    for (const patch of [{ configDir: 'relative' }, { name: 'line\nbreak' }, { permissionMode: 'unknown' }, { mcpMode: 'unknown' }, { model: 'unknown' }, { effort: 'unknown' }, { prompt: 'Must not be accepted' }, { environment: { SECRET: 'synthetic' } }]) {
      const unsafe = JSON.stringify({ ...original, claude: { ...original.claude, ...patch } });
      fs.writeFileSync(file, unsafe);
      await assert.rejects(f.make().create(args), /unsafe or corrupt/);
      await assert.rejects(f.make().receipt({ request_id: args.request_id }), /unsafe or corrupt/);
      assert.equal(fs.readFileSync(file, 'utf8'), unsafe);
    }
    assert.equal(f.calls.length, callCount);
    assert.equal(f.launches.length, 1);
  });
});

describe('Claude creation recovery', () => {
  it('recovers a timed-out launch from a unique native session in the same profile', async t => {
    const f = fixture(t);
    const alias = path.join(f.directory, 'workspace-alias');
    fs.symlinkSync(f.cwd, alias, 'dir');
    f.onLaunch = ({ record, options }) => {
      f.rows.set(options.configDir, [f.candidate(record, { cwd: alias })]);
      throw Object.assign(new Error('Timeout with sensitive command'), { stderr: 'PRIVATE OUTPUT MUST NOT LEAK' });
    };
    const args = { request_id: 'timeout-known', message: 'Run once.', profile: 'other' };
    const recovered = await f.tasks.create(args);
    assert.equal(recovered.requestState, 'known');
    assert.equal(recovered.sessionId, SESSION);
    assert.ok(!JSON.stringify(recovered).includes('PRIVATE OUTPUT'));
    assert.equal((await f.read(args.request_id)).threadId, SESSION);
    assert.equal((await f.make().create(args)).sessionId, SESSION);
    assert.equal(f.launches.length, 1);
    assert.ok(f.catalogs.every(call => call.options.configDir === f.otherConfig));
  });

  it('keeps absent or ambiguous native results unknown across retries and restart', async t => {
    for (const ambiguous of [false, true]) {
      const f = fixture(t);
      f.onLaunch = ({ record, options }) => {
        f.rows.set(options.configDir, ambiguous ? [f.candidate(record), f.candidate(record, { sessionId: OTHER_SESSION })] : []);
        throw new Error('Lost native response');
      };
      const args = { request_id: 'uncertain', message: 'Do not duplicate.' };
      const created = await f.tasks.create(args);
      assert.equal(created.requestState, 'unknown');
      assert.equal(created.sessionId, null);
      assert.equal((await f.make().create(args)).requestState, 'unknown');
      assert.equal((await f.make().receipt({ request_id: args.request_id })).requestState, 'unknown');
      assert.equal(f.launches.length, 1);
    }
  });

  it('rejects recovery candidates with the wrong name, cwd, kind, ID or start time', async t => {
    const f = fixture(t);
    f.onLaunch = ({ record, options }) => {
      f.rows.set(options.configDir, [
        f.candidate(record, { name: `${record.claude.name} suffix` }),
        f.candidate(record, { cwd: f.otherConfig }),
        f.candidate(record, { kind: 'interactive' }),
        f.candidate(record, { sessionId: 'short-id' }),
        f.candidate(record, { startedAt: record.startedAt - 2001 }),
        f.candidate(record, { startedAt: String(record.startedAt) }),
      ]);
      return { stdout: `Started ${SESSION}`, stderr: '' };
    };
    const result = await f.tasks.create({ request_id: 'wrong-candidates', message: 'Do work.' });
    assert.equal(result.requestState, 'unknown', 'stdout alone must not establish native identity');
    assert.equal(result.sessionId, null);
  });

  it('does not search a different profile to recover a matching session', async t => {
    const f = fixture(t);
    f.onLaunch = ({ record }) => {
      f.rows.set(f.otherConfig, [f.candidate(record)]);
      throw new Error('Timeout');
    };
    const result = await f.tasks.create({ request_id: 'profile-bound', message: 'Run once.' });
    assert.equal(result.requestState, 'unknown');
    assert.ok(f.catalogs.every(call => call.options.configDir === f.configDir));
  });

  it('retains unknown receipts when the native catalog fails or returns malformed data', async t => {
    for (const behavior of ['throw', 'json', 'object']) {
      const f = fixture(t);
      f.onCatalog = () => { if (behavior === 'throw') throw new Error('Catalog unavailable'); return { stdout: behavior === 'json' ? '{' : '{}' }; };
      const args = { request_id: 'catalog-error', message: 'Run once.' };
      assert.equal((await f.tasks.create(args)).requestState, 'unknown');
      assert.equal((await f.make().create(args)).requestState, 'unknown');
      assert.equal(f.launches.length, 1);
    }
  });

  it('persists a late recovery so the same native ID survives catalog cleanup', async t => {
    for (const recoverThrough of ['receipt', 'create']) {
      const f = fixture(t);
      f.onLaunch = () => { throw new Error('Timeout'); };
      const args = { request_id: 'late-recovery', message: 'Run once.' };
      assert.equal((await f.tasks.create(args)).requestState, 'unknown');
      const pending = await f.read(args.request_id);
      f.rows.set(f.configDir, [f.candidate(pending)]);
      const recovered = recoverThrough === 'receipt'
        ? await f.make().receipt({ request_id: args.request_id })
        : await f.make().create(args);
      assert.equal(recovered.sessionId, SESSION);
      assert.equal((await f.read(args.request_id)).state, 'known', 'recovered identity must be durable');
      f.rows.clear();
      assert.equal((await f.make().receipt({ request_id: args.request_id })).sessionId, SESSION);
      assert.equal(f.launches.length, 1);
    }
  });

  it('never replaces a known native session ID with a new matching candidate', async t => {
    const f = fixture(t);
    const args = { request_id: 'immutable-native-id', message: 'Keep the original session.' };
    await f.tasks.create(args);
    const known = await f.read(args.request_id);
    f.rows.set(f.configDir, [f.candidate(known, { sessionId: OTHER_SESSION })]);
    assert.equal((await f.make().receipt({ request_id: args.request_id })).sessionId, SESSION);
    assert.equal((await f.make().create(args)).sessionId, SESSION);
    assert.equal((await f.read(args.request_id)).threadId, SESSION);
    assert.equal(f.launches.length, 1);
  });

  it('reports native trust or unsupported CLI without retrying or exposing stderr', async t => {
    for (const [stderr, pattern] of [['Workspace not trusted SECRET', /not trusted/], ["unknown option '--background' SECRET", /does not support/]]) {
      const f = fixture(t);
      f.onLaunch = () => { throw Object.assign(new Error('Native failure'), { stderr }); };
      const args = { request_id: 'native-refusal', message: 'Run once.' };
      const result = await f.tasks.create(args);
      assert.match(result.launchError, pattern);
      assert.ok(!JSON.stringify(result).includes('SECRET'));
      assert.equal(result.requestState, 'unknown');
      await f.make().create(args);
      assert.equal(f.launches.length, 1);
    }
  });
});

describe('Claude launch argument and profile boundaries', () => {
  it('keeps flag-like prompts and shell syntax as one argument after the separator', () => {
    const message = '--dangerously-skip-permissions $(touch /tmp/never) `command`\nsecond line';
    const spec = { name: 'Title; $(not-a-command)', permissionMode: 'manual', mcpMode: 'inherit', message };
    assert.deepEqual(claudeLaunchArgs(spec), ['--background', '--name', spec.name, '--permission-mode', 'manual', '--', message]);
    assert.ok(!claudeLaunchArgs(spec).includes('--session-id'));
  });

  it('removes inherited session identity without changing provider credentials or caller environment', () => {
    const env = { PATH: '/test/bin', TOKEN: 'synthetic', CLAUDE_CONFIG_DIR: '/old', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: SOURCE, CODEX_TURN_ID: TURN, CLAUDE_BRIDGE_PERMISSION_MODE: 'bypass' };
    assert.deepEqual(claudeEnvironment('/selected', env), { PATH: '/test/bin', TOKEN: 'synthetic', CLAUDE_CONFIG_DIR: '/selected' });
    assert.equal(env.CLAUDE_CODE_SESSION_ID, SESSION);
    assert.equal(env.CLAUDE_CONFIG_DIR, '/old');
  });

  it('resolves only an exact installed profile and canonicalizes its directory', t => {
    const f = fixture(t);
    const alias = path.join(f.directory, 'profile-link');
    fs.symlinkSync(f.otherConfig, alias, 'dir');
    const discovery = { directories: [{ path: f.configDir, sources: ['default', 'CLAUDE_CONFIG_DIR'] }, { path: alias, sources: ['CCS:work'] }] };
    assert.equal(resolveClaudeProfile('default', discovery), f.configDir);
    assert.equal(resolveClaudeProfile('CLAUDE_CONFIG_DIR', discovery), f.configDir);
    assert.equal(resolveClaudeProfile('work', discovery), f.otherConfig);
    assert.equal(resolveClaudeProfile('CCS:work', discovery), f.otherConfig);
    assert.throws(() => resolveClaudeProfile('wor', discovery), /missing or ambiguous/);
    assert.throws(() => resolveClaudeProfile('default', { directories: [...discovery.directories, { path: f.otherConfig, sources: ['default'] }] }), /missing or ambiguous/);
    assert.equal(canonicalDirectory(alias), f.otherConfig);
  });
});
