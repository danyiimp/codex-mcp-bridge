import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { nativeToolsPipeFromProcessEnvironment, resolveNativeToolsPipePath } from '../src/native-relay.mjs';

const command = '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true';

it('reads the plugin Desktop pipe from its own environment only', () => {
  assert.equal(nativeToolsPipeFromProcessEnvironment(command, `${command} A=x CODEX_APP_TOOLS_PIPE_PATH=/tmp/tools.sock B=y`), '/tmp/tools.sock');
  for (const cmd of ['/usr/bin/node app-server', '/usr/bin/codex exec app-server', '/usr/bin/codex exec --prompt app-server']) {
    assert.equal(nativeToolsPipeFromProcessEnvironment(cmd, `${cmd} CODEX_APP_TOOLS_PIPE_PATH=/tmp/tools.sock`), null);
  }
  for (const env of ['CODEX_APP_TOOLS_PIPE_PATH=relative', 'OTHER=/tmp/tools.sock', 'CODEX_APP_TOOLS_PIPE_PATH=/a CODEX_APP_TOOLS_PIPE_PATH=/b']) {
    assert.equal(nativeToolsPipeFromProcessEnvironment(command, `${command} ${env}`), null);
  }
  assert.equal(nativeToolsPipeFromProcessEnvironment(command, `/other ${command} CODEX_APP_TOOLS_PIPE_PATH=/tmp/tools.sock`), null);
});

it('discovers only its Desktop ancestor through the bridge supervisor and checks socket protection', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pipe-'));
  const socket = path.join(dir, 's');
  const server = net.createServer();
  await new Promise(resolve => server.listen(socket, resolve));
  fs.chmodSync(socket, 0o600);
  const visited = [];
  const opts = {
    env: {}, platform: 'darwin', parentPid: 123,
    readParentCommandLine: async pid => { visited.push(pid); return pid === 123 ? '/usr/bin/node /bridge/src/mcp-supervisor.mjs native-relay-companion.mjs' : command; },
    readParentPid: async pid => { assert.equal(pid, 123); return 456; },
    readEnvironmentLine: async pid => { assert.equal(pid, 456); return `${command} CODEX_APP_TOOLS_PIPE_PATH=${socket}`; },
  };
  try {
    assert.equal(await resolveNativeToolsPipePath(opts), socket);
    assert.deepEqual(visited, [123, 456]);
    fs.chmodSync(socket, 0o666);
    assert.equal(await resolveNativeToolsPipePath(opts), null);
    assert.equal(await resolveNativeToolsPipePath({ ...opts, readParentCommandLine: async () => '/usr/bin/node unrelated.mjs', readEnvironmentLine: async () => assert.fail('unrelated environment accessed') }), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
