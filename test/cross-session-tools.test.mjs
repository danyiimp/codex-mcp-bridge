import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('advertises native creation and image follow-ups on the existing MCP surface without granting anonymous creation', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-catalog-'));
  const client = new Client({ name: 'bridge-catalog-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cross-session-bridge.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, HOME: temp, CODEX_HOME: path.join(temp, '.codex'), CLAUDE_CONFIG_DIR: path.join(temp, '.claude') },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  t.after(async () => { await client.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.equal(byName.create_claude_session.annotations.readOnlyHint, false);
  assert.equal(byName.read_claude_session.annotations.readOnlyHint, true);
  assert.equal(byName.get_claude_request.annotations.readOnlyHint, true);
  assert.ok(byName.create_claude_session.inputSchema.required.includes('request_id'));
  assert.ok(byName.create_claude_session.inputSchema.properties.permission_mode.enum.includes('bypassPermissions'));
  assert.deepEqual(byName.create_claude_session.inputSchema.properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  const noClaudeCaller = await client.callTool({ name: 'create_claude_session', arguments: { message: 'No dispatch', request_id: 'claude-catalog-probe', permission_mode: 'bypassPermissions' } });
  assert.equal(noClaudeCaller.isError, true);
  assert.match(noClaudeCaller.content[0].text, /native Codex MCP caller/);
  assert.equal(byName.create_oai_session.annotations.readOnlyHint, false);
  assert.equal(byName.send_to_oai_session.annotations.readOnlyHint, false);
  assert.equal(byName.read_oai_session.annotations.readOnlyHint, true);
  assert.equal(byName.get_oai_request.annotations.readOnlyHint, true);
  assert.ok(byName.create_oai_session.inputSchema.required.includes('request_id'));
  assert.ok(byName.send_to_oai_session.inputSchema.properties.images);
  assert.deepEqual(byName.send_to_oai_session.inputSchema.properties.reply_mode.enum, ['read', 'callback']);
  assert.deepEqual(byName.create_oai_session.inputSchema.properties.reply_mode.enum, ['read', 'callback']);
  assert.ok(byName.list_claude_sessions && byName.send_to_claude_session && byName.get_delivery);
  const invalid = await client.callTool({ name: 'create_oai_session', arguments: { message: 'No dispatch', request_id: '../unsafe' } });
  assert.equal(invalid.isError, true);
  const unauthenticated = await client.callTool({ name: 'create_oai_session', arguments: { message: 'No dispatch', request_id: 'catalog-probe' } });
  assert.equal(unauthenticated.isError, true);
  assert.match(unauthenticated.content[0].text, /registry|вызывающ|Claude/i, stderr);
});
