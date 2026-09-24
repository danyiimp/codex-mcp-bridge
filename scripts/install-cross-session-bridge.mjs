#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exitForVersionRequest } from "../src/cli-version.mjs";
import { claudeExecutable } from "../src/claude-session-create.mjs";
import { stdioMcpRegistration } from "../src/codex-mcp-registration.mjs";
import { resolveCodexBin, spawnEnv } from "../src/platform.mjs";
import { createReleaseSnapshot, snapshotRoot } from "../src/release-snapshot.mjs";

exitForVersionRequest(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "mcp-supervisor.mjs");
const worker = "cross-session-bridge.mjs";
const name = "cross-session-bridge";
const flags = new Set(process.argv.slice(2));
const supported = new Set(["--codex", "--claude", "--both", "--remove"]);
const modes = ["--codex", "--claude", "--both"].filter((flag) => flags.has(flag));
if ([...flags].some((flag) => !supported.has(flag)) || modes.length > 1 || flags.size !== process.argv.slice(2).length) {
  throw new Error("Usage: cross-session-bridge-install [--codex | --claude | --both] [--remove]");
}

const installCodex = !flags.has("--claude");
const installClaude = !flags.has("--codex");
const remove = flags.has("--remove");
const nodeBin = process.execPath;
const codexBin = resolveCodexBin(process.env.CODEX_EXE);

function executable(file) {
  if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  if (process.platform === "win32") return true;
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function resolveClaudeBin() {
  const preferred = claudeExecutable();
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
  const candidates = [preferred, ...((process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap((dir) => names.map((base) => path.join(dir, base))))];
  for (const candidate of candidates) {
    // Keep a stable installer-managed symlink such as ~/.local/bin/claude.
    // Its target may change when Claude Code upgrades.
    if (executable(candidate)) return path.resolve(candidate);
  }
  throw new Error("Claude Code executable not found. Install Claude Code or set CLAUDE_BIN to its absolute executable path.");
}

if (!fs.existsSync(entry) || !fs.existsSync(path.join(root, "src", worker))) throw new Error("Combined bridge entry point is missing");
if (!remove && !executable(codexBin) || remove && installCodex && !executable(codexBin)) throw new Error(`Codex executable not found at ${codexBin}. Set CODEX_EXE to its absolute path.`);
const claudeBin = installClaude || installCodex && !remove ? resolveClaudeBin() : null;
const runCodex = (args) => execFileSync(codexBin, args, { env: spawnEnv(), stdio: "pipe", encoding: "utf8" }).trim();
const runClaude = (args) => execFileSync(claudeBin, args, { env: spawnEnv(), stdio: "pipe", encoding: "utf8" }).trim();

// Inspect both clients before changing either. Existing Claude registrations
// are left alone because its text-oriented `mcp get` output cannot preserve
// every access and environment option when rewritten through `mcp add`.
let codexExisting = null;
if (installCodex && !remove) {
  const servers = JSON.parse(runCodex(["mcp", "list", "--json"]));
  if (!Array.isArray(servers)) throw new Error("Codex returned an invalid MCP inventory; no configuration was changed");
  codexExisting = servers.some((server) => server.name === name)
    ? JSON.parse(runCodex(["mcp", "get", name, "--json"])) : null;
}
let claudeExisting = null;
if (installClaude && !remove) {
  try { claudeExisting = runClaude(["mcp", "get", name]); }
  catch (error) {
    if (error.status !== 1) throw new Error(`Could not inspect Claude Code MCP registration: ${error.message}`);
  }
  if (claudeExisting !== null && (!claudeExisting.includes(entry) || !claudeExisting.includes(worker))) {
    throw new Error(`Claude Code already has ${name} with a different command. Preserve its settings and update its command and arguments manually: ${nodeBin} ${entry} ${worker}`);
  }
}

if (remove) {
  if (installCodex) console.log(runCodex(["mcp", "remove", name]) || `Removed ${name} from Codex`);
  if (installClaude) console.log(runClaude(["mcp", "remove", name]) || `Removed ${name} from Claude Code`);
  process.exit(0);
}

const registration = installCodex ? stdioMcpRegistration({
  name, existing: codexExisting, node: nodeBin, entry, entryArgs: [worker],
  envOverrides: { CODEX_BIN: codexBin, CLAUDE_BIN: claudeBin },
}) : null;
createReleaseSnapshot(root, { cache: snapshotRoot(process.env) });

if (installCodex) {
  runCodex(registration.args);
  console.log(`Codex: registered ${name} -> ${nodeBin} ${entry} ${worker}`);
}
if (installClaude) {
  if (claudeExisting !== null) {
    console.log(`Claude Code: existing ${name} registration already points to this installation`);
  } else {
    const args = ["mcp", "add", "--scope", "user", name,
      "-e", `CODEX_BIN=${codexBin}`, "-e", `CLAUDE_BIN=${claudeBin}`,
      "--", nodeBin, entry, worker];
    console.log(runClaude(args) || `Claude Code: registered ${name}`);
  }
}
console.log(`Reconnect ${name} in the existing Codex and Claude Code tasks, then call bridge_status from each task.`);
