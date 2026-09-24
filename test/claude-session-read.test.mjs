import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readClaudeSession } from "../src/claude-session-read.mjs";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-session-read-"));
const target = "10c7623c-b400-44e2-ab4d-ede852b5c61a";
const other = "20c7623c-b400-44e2-ab4d-ede852b5c61a";
let serial = 0;
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function fixture() {
  const configDir = path.join(sandbox, String(++serial));
  const cwd = path.join(sandbox, "Project_name with.dots", "nested");
  const directory = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${target}.jsonl`);
  const args = { target, cwd, configDir };
  const row = (role, content, extra = {}) => ({
    type: role, sessionId: target, cwd, timestamp: "2026-09-24T13:52:19.062Z",
    message: { role, content, ...(role === "assistant" ? { model: "claude-test", stop_reason: "end_turn" } : {}) },
    ...extra,
  });
  const write = (entries) => fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { args, file, directory, row, write };
}

function rejects(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, `CLAUDE_TRANSCRIPT_${code}`);
    assert.ok(!error.message.includes("PRIVATE"));
    return true;
  });
}

describe("bounded native Claude session reads", () => {
  it("reads the escaped cwd slug, preserving recent user turns and newest available model", () => {
    const { args, row, write } = fixture();
    write([
      { type: "custom-title", sessionId: target, customTitle: "PRIVATE METADATA" },
      { type: "file-history-snapshot", snapshot: { PRIVATE: true } },
      row("user", "old question"), row("assistant", [{ type: "text", text: "old answer" }]),
      row("user", "recent question"), row("assistant", [{ type: "text", text: "recent answer" }]),
    ]);
    const result = readClaudeSession({ ...args, target: target.toUpperCase(), cwd: `${args.cwd}${path.sep}`, turnLimit: 1 });
    assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "recent question" }, { role: "assistant", text: "recent answer" },
    ]);
    assert.equal(result.sessionId, target);
    assert.equal(result.model, "claude-test");
    assert.equal(result.status.state, "assistant_completed");
    assert.equal(result.status.source, "transcript");
    assert.equal(result.status.processRunning, null);
    assert.match(result.status.reason, /not authoritative/);
    assert.equal(result.truncated, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  });

  it("omits thinking, tools, image bytes, metadata and sidechains without recursively reading them", () => {
    const { args, row, write } = fixture();
    write([
      row("user", "question"),
      row("assistant", [
        { type: "thinking", thinking: "PRIVATE THOUGHT", signature: "PRIVATE SIGNATURE" },
        { type: "tool_use", input: { text: "PRIVATE TOOL ARGUMENT" } },
        { type: "image", source: { type: "base64", data: "PRIVATE IMAGE BYTES" } },
        { type: "text", text: "public answer" },
      ]),
      row("user", [{ type: "tool_result", content: [{ type: "text", text: "PRIVATE TOOL RESULT" }] }]),
      row("assistant", "PRIVATE META", { isMeta: true }),
      row("assistant", "PRIVATE SIDECHAIN", { isSidechain: true }),
    ]);
    const result = readClaudeSession(args);
    assert.deepEqual(result.messages.map((message) => message.text), ["question", "public answer"]);
    assert.equal(result.status.state, "tool_activity");
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  });

  it("removes inline data URLs and long base64 values from text blocks", () => {
    const { args, row, write } = fixture();
    const encoded = "ABCDabcd0123+/".repeat(40);
    write([row("user", `before data:image/png;base64,${encoded} after ${encoded}`)]);
    const result = readClaudeSession(args);
    assert.equal(result.messages[0].text, "before [inline data omitted] after [encoded data omitted]");
  });

  it("bounds all text together, favoring latest answers and preserving surrogate pairs", () => {
    const { args, row, write } = fixture();
    write([row("user", "long old question"), row("assistant", "🙂🙂🙂 last answer")]);
    const result = readClaudeSession({ ...args, maxOutputChars: 5 });
    assert.deepEqual(result.messages.map((message) => message.text), ["🙂🙂"]);
    assert.equal(result.truncated, true);
    assert.ok(result.messages.reduce((sum, message) => sum + message.text.length, 0) <= 5);
  });

  it("caps the number of tiny assistant blocks independently of the text budget", () => {
    const { args, row, write } = fixture();
    write([row("user", "question"), ...Array.from({ length: 300 }, () => row("assistant", "a"))]);
    const result = readClaudeSession(args);
    assert.equal(result.messages.length, 200);
    assert.equal(result.truncated, true);
  });

  it("rejects mismatched session IDs and cwd even in metadata and ignored sidechains", () => {
    const { args, row, write } = fixture();
    for (const entry of [
      row("user", "PRIVATE", { sessionId: other }),
      row("assistant", "PRIVATE", { session_id: other }),
      { type: "custom-title", sessionId: other, customTitle: "PRIVATE" },
      row("assistant", "PRIVATE", { isSidechain: true, sessionId: other }),
    ]) {
      write([row("user", "safe"), entry]);
      rejects(() => readClaudeSession(args), "SESSION_MISMATCH");
    }
    // Punctuation collisions must never let the slug substitute for cwd checks.
    write([row("user", "PRIVATE", { cwd: args.cwd.replace("Project_name", "Project-name") })]);
    rejects(() => readClaudeSession(args), "CWD_MISMATCH");
  });

  it("requires identity and role consistency on each surfaced message", () => {
    const { args, row, write } = fixture();
    for (const entry of [
      row("user", "PRIVATE", { sessionId: undefined }),
      row("user", "PRIVATE", { cwd: undefined }),
      row("user", "PRIVATE", { message: { role: "assistant", content: "PRIVATE" } }),
    ]) {
      write([entry]);
      rejects(() => readClaudeSession(args), "INVALID");
    }
  });

  it("returns explicit missing/empty states without claiming that a process is running", () => {
    const { args, file, write } = fixture();
    assert.equal(readClaudeSession(args).status.state, "missing");
    write([]);
    assert.equal(readClaudeSession(args).status.state, "empty");
    fs.rmSync(file);
    const result = readClaudeSession(args);
    assert.deepEqual(result.messages, []);
    assert.equal(result.model, null);
    assert.equal(result.status.processRunning, null);
    assert.equal(readClaudeSession({ ...args, configDir: path.join(args.configDir, "missing") }).status.state, "missing");
  });

  it("rejects symlinked files, project directories and selected config roots", () => {
    const { args, file, directory, row, write } = fixture();
    write([row("user", "PRIVATE")]);
    const moved = `${file}.actual`;
    fs.renameSync(file, moved);
    fs.symlinkSync(moved, file);
    rejects(() => readClaudeSession(args), "UNSAFE");
    fs.rmSync(file);
    fs.renameSync(moved, file);
    const movedDir = `${directory}.actual`;
    fs.renameSync(directory, movedDir);
    fs.symlinkSync(movedDir, directory, "junction");
    rejects(() => readClaudeSession(args), "UNSAFE");
    fs.rmSync(directory);
    fs.renameSync(movedDir, directory);
    const alias = `${args.configDir}.alias`;
    fs.symlinkSync(args.configDir, alias, "junction");
    rejects(() => readClaudeSession({ ...args, configDir: alias }), "UNSAFE");
  });

  it("rejects hard-linked and oversized files before reading payloads", () => {
    const { args, file, row, write } = fixture();
    write([row("user", "PRIVATE")]);
    const alias = `${file}.alias`;
    fs.linkSync(file, alias);
    rejects(() => readClaudeSession(args), "UNSAFE");
    fs.rmSync(alias);
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    rejects(() => readClaudeSession(args), "TOO_LARGE");
    write([row("user", "x".repeat(1024 * 1024))]);
    rejects(() => readClaudeSession(args), "TOO_LARGE");
  });

  it("rejects invalid complete JSON but tolerates an unfinished final write with a truncation marker", () => {
    const { args, file, row, write } = fixture();
    write([row("user", "safe")]);
    fs.appendFileSync(file, '{"PRIVATE":');
    const result = readClaudeSession(args);
    assert.equal(result.truncated, true);
    assert.equal(result.messages[0].text, "safe");
    fs.appendFileSync(file, "\n");
    rejects(() => readClaudeSession(args), "INVALID");
    fs.writeFileSync(file, Buffer.from([0xff]));
    rejects(() => readClaudeSession(args), "UNREADABLE");
  });

  it("rejects path traversal and invalid limits before filesystem access", () => {
    const { args } = fixture();
    for (const overrides of [
      { target: "../../secret" }, { target: "auto" }, { cwd: "relative" },
      { configDir: "relative" }, { cwd: `${args.cwd}\0` }, { turnLimit: 0 },
      { turnLimit: 51 }, { turnLimit: 1.5 }, { maxOutputChars: 0 }, { maxOutputChars: 100001 },
    ]) rejects(() => readClaudeSession({ ...args, ...overrides }), "INVALID_ARGUMENT");
  });
});
