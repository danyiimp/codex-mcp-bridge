import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const installer = fileURLToPath(new URL("../scripts/install-cross-session-bridge.mjs", import.meta.url));
const root = path.dirname(path.dirname(installer));

function fakeExecutable(file, role) {
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.BRIDGE_TEST_LOG, JSON.stringify({role: ${JSON.stringify(role)}, argv}) + '\\n');
if (argv.join(' ') === 'mcp list --json') process.stdout.write('[]');
else if (${JSON.stringify(role)} === 'claude' && argv.join(' ') === 'mcp get cross-session-bridge') process.exitCode = 1;
else process.stdout.write('ok');
`);
  fs.chmodSync(file, 0o755);
}

it("registers the combined MCP entry in Codex and Claude Code without a CCS profile", { skip: process.platform === "win32" }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "combined-bridge-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const packageRoot = path.join(home, "package");
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
  fs.mkdirSync(path.join(packageRoot, "node_modules"));
  fs.cpSync(path.join(root, "src"), path.join(packageRoot, "src"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, file), path.join(packageRoot, file));
  const installedScript = path.join(packageRoot, "scripts", "install-cross-session-bridge.mjs");
  fs.copyFileSync(installer, installedScript);
  const codex = path.join(home, "codex");
  const claude = path.join(home, "claude");
  const log = path.join(home, "calls.jsonl");
  fakeExecutable(codex, "codex");
  fakeExecutable(claude, "claude");

  const output = execFileSync(process.execPath, [installedScript, "--both"], {
    cwd: packageRoot, encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"),
      CODEX_EXE: codex, CLAUDE_BIN: claude, BRIDGE_TEST_LOG: log },
  });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const codexAdd = calls.find((call) => call.role === "codex" && call.argv.slice(0, 3).join(" ") === "mcp add cross-session-bridge");
  const claudeAdd = calls.find((call) => call.role === "claude" && call.argv.slice(0, 5).join(" ") === "mcp add --scope user cross-session-bridge");
  assert.ok(codexAdd, JSON.stringify(calls));
  assert.ok(claudeAdd, JSON.stringify(calls));
  for (const call of [codexAdd, claudeAdd]) {
    assert.deepEqual(call.argv.slice(-3), [process.execPath, path.join(canonicalPackageRoot, "src", "mcp-supervisor.mjs"), "cross-session-bridge.mjs"]);
    assert.ok(call.argv.includes(`CODEX_BIN=${codex}`));
    assert.ok(call.argv.includes(`CLAUDE_BIN=${claude}`));
  }
  assert.match(output, /Reconnect cross-session-bridge/);
});

it("exposes a version without inspecting or changing client configuration", () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const output = execFileSync(process.execPath, [installer, "--version"], { encoding: "utf8" });
  assert.equal(output.trim(), version);
});
