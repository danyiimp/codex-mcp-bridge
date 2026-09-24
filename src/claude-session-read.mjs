import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LINES = 100000;
const VERSION_FIELDS = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
const sameVersion = (left, right) => VERSION_FIELDS.every((key) => left[key] === right[key]);

function failure(code, message) {
  const error = new Error(message);
  error.code = `CLAUDE_TRANSCRIPT_${code}`;
  return error;
}

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\0") && path.isAbsolute(value);
}

function directoryInfo(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw failure("UNSAFE", "Claude transcript directories must be real directories, not symlinks.");
  }
  return info;
}

function readSnapshot(configDir, slug, sessionId) {
  const rootInfo = directoryInfo(configDir);
  // The caller verifies the account owning this root. Canonicalize trusted parent
  // aliases (such as macOS /tmp), while refusing symlinks below the selected root.
  const root = fs.realpathSync.native(configDir);
  const directories = [root, path.join(root, "projects"), path.join(root, "projects", slug)];
  const versions = [rootInfo, ...directories.slice(1).map(directoryInfo)];
  const file = path.join(directories[2], `${sessionId}.jsonl`);
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw failure("UNSAFE", "Claude transcript must be a regular file without links.");
  }
  if (info.size > MAX_FILE_BYTES) throw failure("TOO_LARGE", "Claude transcript exceeds the 16 MiB read limit.");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || !sameVersion(info, opened)) {
      throw failure("CHANGED", "Claude transcript changed while opening it; retry the read.");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw failure("CHANGED", "Claude transcript changed while reading it; retry the read.");
      offset += count;
    }
    if (!sameVersion(opened, fs.fstatSync(descriptor)) || !sameVersion(opened, fs.lstatSync(file))
        || directories.some((directory, index) => {
          const current = directoryInfo(directory);
          return current.dev !== versions[index].dev || current.ino !== versions[index].ino;
        }) || fs.realpathSync.native(configDir) !== root) {
      throw failure("CHANGED", "Claude transcript changed while reading it; retry the read.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function timestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

function visibleText(content) {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n")
    : "";
  // Never traverse tool, thinking, image or other blocks. Inline data in plain
  // text is also removed; long opaque base64 tokens are not useful summaries.
  return text.replace(/data:[^,\s]*,[^\s"'<>)]*/gi, "[inline data omitted]")
    .replace(/[A-Za-z0-9+/_-]{256,}={0,2}/g, "[encoded data omitted]").trim();
}

function transcriptStatus(state, lastEventAt = null) {
  return {
    source: "transcript", state, lastEventAt, processRunning: null,
    reason: "Transcript events only; this is not authoritative process-running or task-completion status.",
  };
}

/**
 * Read recent native Claude user turns without running Claude or inspecting a
 * different account. The caller must verify configDir's account before calling.
 * maxOutputChars bounds the sum of message text lengths (UTF-16 code units).
 */
export function readClaudeSession({ target, cwd, configDir, turnLimit = 3, maxOutputChars = 12000 } = {}) {
  if (typeof target !== "string" || !UUID.test(target) || !absolutePath(cwd) || !absolutePath(configDir)
      || !Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 50
      || !Number.isInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 100000) {
    throw failure("INVALID_ARGUMENT", "Provide a UUID target, absolute cwd/configDir, turnLimit 1–50, and maxOutputChars 1–100000.");
  }
  const sessionId = target.toLowerCase();
  const expectedCwd = path.resolve(cwd);
  const result = {
    sessionId, cwd: expectedCwd, source: "claude_native_transcript", model: null,
    status: transcriptStatus("empty"), messages: [], truncated: false,
  };
  // Native project slugs escape all punctuation, including underscores/spaces.
  // The contents are checked too, because distinct cwd values can share a slug.
  const slug = expectedCwd.replace(/[^a-zA-Z0-9]/g, "-");
  let snapshot;
  try {
    snapshot = readSnapshot(configDir, slug, sessionId);
  } catch (error) {
    if (error.code === "ENOENT") {
      result.status = transcriptStatus("missing");
      return result;
    }
    if (error.code?.startsWith("CLAUDE_TRANSCRIPT_")) throw error;
    throw failure("UNREADABLE", "Claude transcript could not be read safely.");
  }
  const lines = snapshot.split("\n");
  if (lines.length > MAX_LINES) throw failure("TOO_LARGE", "Claude transcript exceeds the line count limit.");
  const turns = [];
  let currentTurn;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw failure("TOO_LARGE", "Claude transcript entry exceeds the 1 MiB read limit.");
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch {
      // A live writer may not have finished its final JSONL entry yet.
      if (index === lines.length - 1) { result.truncated = true; break; }
      throw failure("INVALID", "Claude transcript contains an invalid JSONL entry.");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw failure("INVALID", "Claude transcript contains an invalid entry.");
    for (const key of ["sessionId", "session_id"]) {
      if (Object.hasOwn(entry, key) && (typeof entry[key] !== "string" || entry[key].toLowerCase() !== sessionId)) {
        throw failure("SESSION_MISMATCH", "Claude transcript contains a different session identity.");
      }
    }
    if (Object.hasOwn(entry, "cwd") && (!absolutePath(entry.cwd) || path.resolve(entry.cwd) !== expectedCwd)) {
      throw failure("CWD_MISMATCH", "Claude transcript contains a different project directory.");
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.sessionId || !entry.cwd || entry.message?.role !== entry.type) {
      throw failure("INVALID", "Claude message lacks a consistent session, cwd, or role.");
    }
    if (entry.isMeta || entry.isSidechain) continue;
    const message = entry.message;
    if (entry.type === "assistant" && typeof message.model === "string" && /^[A-Za-z0-9._:/-]{1,160}$/.test(message.model)) result.model = message.model;
    const content = message.content;
    const toolOnly = Array.isArray(content) && content.some((block) => ["tool_use", "tool_result"].includes(block?.type));
    const text = visibleText(content);
    const state = entry.type === "assistant" && ["end_turn", "stop_sequence"].includes(message.stop_reason)
      ? "assistant_completed" : toolOnly ? "tool_activity" : `${entry.type}_message`;
    result.status = transcriptStatus(state, timestamp(entry.timestamp));
    if (!text) continue;
    if (entry.type === "user" || !currentTurn) {
      currentTurn = [];
      turns.push(currentTurn);
      if (turns.length > turnLimit) { turns.shift(); result.truncated = true; }
    }
    currentTurn.push({ role: entry.type, text, timestamp: timestamp(entry.timestamp) });
  }
  const messages = turns.flat();
  let remaining = maxOutputChars;
  // Favor the latest answer if a verbose earlier message consumes the budget.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (remaining === 0 || result.messages.length === 200) { result.truncated = true; break; }
    if (message.text.length > remaining) {
      let text = message.text.slice(0, remaining);
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
      result.messages.unshift({ ...message, text });
      result.truncated = true;
      break;
    }
    result.messages.unshift(message);
    remaining -= message.text.length;
  }
  return result;
}
