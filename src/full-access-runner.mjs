#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir, resolveCodexBin, spawnEnv } from "./platform.mjs";

/**
 * Codex Desktop downgrades every delegated `create_thread` task from full access
 * to "auto" (on-request approvals, workspace-write sandbox, network off), whatever
 * ~/.codex/config.toml or the UI default say. Bridge tasks therefore start in an
 * app-server owned by a detached runner: the thread and its first turn get the
 * full-access settings explicitly, the thread lands in the shared ~/.codex state
 * that Desktop lists and reads, and the runner exits when the turn ends, which
 * releases the writer lock so Desktop continues the same thread with the settings
 * the thread already carries.
 */
export const FULL_ACCESS = Object.freeze({ approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: Object.freeze({ type: "dangerFullAccess" }) });
export const FULL_ACCESS_BACKEND = "codex-app-server-full-access";
const RUNNER = fileURLToPath(import.meta.url);
const TURN_LIFETIME_MS = 12 * 60 * 60 * 1000;
const INHERITED_ENV_BLOCKLIST = /^(CLAUDECODE|CLAUDE_CODE_.*|CODEX_BRIDGE_.*|CODEX_THREAD_ID|CODEX_COMPANION_.*)$/;

const codexHome = (env = process.env) => env.CODEX_HOME ?? path.join(homeDir(), ".codex");
const runMarker = (threadId) => path.join(codexHome(), "bridge-full-access-runs", `${threadId}.pid`);

export function runnerLogPath(env = process.env) {
  return path.join(codexHome(env), "bridge-full-access-runner.log");
}

/** PID of a live runner that still owns this thread's writer lock, or null. */
export function activeFullAccessRunner(threadId) {
  try {
    const pid = Number(fs.readFileSync(runMarker(threadId), "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function childEnv() {
  return Object.fromEntries(Object.entries(spawnEnv()).filter(([key]) => !INHERITED_ENV_BLOCKLIST.test(key)));
}

function appServer({ cwd, codexBin, log }) {
  const child = spawn(codexBin, ["app-server"], { cwd, env: childEnv(), stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let buffer = "";
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const answer = (message) => {
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": return { decision: "accept" };
      case "execCommandApproval":
      case "applyPatchApproval": return { decision: "approved" };
      case "item/permissions/requestApproval": return { permissions: message.params?.permissions ?? {}, scope: "turn" };
      case "item/tool/requestUserInput": return { answers: {} };
      case "mcpServer/elicitation/request": return { action: "decline", content: null };
      default: return null;
    }
  };
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && message.method === undefined) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry?.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else entry?.resolve(message.result);
      } else if (message.id !== undefined) {
        log(`server request ${message.method}`);
        const result = answer(message);
        send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: `The bridge full-access runner does not serve ${message.method}` } });
      } else for (const listener of listeners) listener(message);
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => {
    for (const entry of pending.values()) entry.reject(new Error(`app-server exited (${signal ?? code})`));
    pending.clear();
    resolve(`app-server exited (${signal ?? code})`);
  }));
  child.on("error", (error) => log(`app-server spawn failed: ${error.message}`));
  return {
    exited,
    notify: (method, params) => send({ method, params }),
    onNotification: (listener) => listeners.add(listener),
    request: (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      send({ id, method, params });
    }),
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Child side: one thread, one full-access turn, then release. */
export async function runFullAccessTurn(job, { report, log, codexBin = resolveCodexBin(), lifetimeMs = TURN_LIFETIME_MS }) {
  const server = appServer({ cwd: job.cwd, codexBin, log });
  const finished = new Map();
  let onFinished = () => {};
  let lifetime;
  let marker;
  server.onNotification((message) => {
    if (message.method !== "turn/completed" || !message.params?.turn?.id) return;
    finished.set(message.params.turn.id, message.params.turn.status);
    onFinished();
  });
  try {
    await server.request("initialize", { clientInfo: { name: "Codex Desktop", title: "Codex Desktop (cross-session-bridge full access)", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    server.notify("initialized", {});
    const started = await server.request("thread/start", {
      cwd: job.cwd, approvalPolicy: FULL_ACCESS.approvalPolicy, sandbox: FULL_ACCESS.sandbox, threadSource: "agent_created_thread",
      ...(job.model ? { model: job.model } : {}),
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("app-server created no thread id");
    report({ event: "thread", threadId });
    marker = runMarker(threadId);
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, String(process.pid), { mode: 0o600 });
    if (job.title) await server.request("thread/name/set", { threadId, name: job.title }).catch((error) => log(`thread/name/set failed: ${error.message}`));
    const turn = await server.request("turn/start", {
      threadId, input: [{ type: "text", text: job.prompt, text_elements: [] }],
      approvalPolicy: FULL_ACCESS.approvalPolicy, sandboxPolicy: FULL_ACCESS.sandboxPolicy,
      ...(job.model ? { model: job.model } : {}), ...(job.effort ? { effort: job.effort } : {}),
    });
    const turnId = turn?.turn?.id;
    if (!turnId) throw new Error("app-server started no turn id");
    report({ event: "turn", threadId, turnId });
    const completed = new Promise((resolve) => { onFinished = () => finished.has(turnId) && resolve(finished.get(turnId)); onFinished(); });
    const status = await Promise.race([completed, server.exited, new Promise((resolve) => { lifetime = setTimeout(resolve, lifetimeMs, "runner lifetime exceeded"); })]);
    log(`turn ${turnId} of ${threadId} finished: ${status}`);
    await server.request("thread/unsubscribe", { threadId }, 5000).catch((error) => log(`thread/unsubscribe failed: ${error.message}`));
  } finally {
    clearTimeout(lifetime);
    await server.close();
    if (marker) fs.rmSync(marker, { force: true });
  }
}

/**
 * Parent side, shaped like a native `create_thread` relay response so the
 * existing receipt, source-guard and confirmation logic applies unchanged.
 */
export function launchFullAccessTurn({ cwd, prompt, title, model, thinking }, { timeoutMs = 40000, beforeSend } = {}) {
  return (async () => {
    await beforeSend?.();
    const child = spawn(process.execPath, [RUNNER], { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"], env: process.env });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ cwd, prompt, title, model, effort: thinking }));
    const events = {};
    try {
      await new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(resolve, timeoutMs);
        const done = (fn, value) => { clearTimeout(timer); fn(value); };
        child.on("error", (error) => done(reject, error));
        child.on("exit", (code) => done(resolve, code));
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n")) !== -1) {
            let event;
            try { event = JSON.parse(buffer.slice(0, index)); } catch { event = null; }
            buffer = buffer.slice(index + 1);
            if (event?.event) events[event.event] = event;
            if (events.turn || events.error) return done(resolve);
          }
        });
      });
    } finally {
      child.stdout.destroy();
      child.unref();
    }
    const threadId = events.thread?.threadId;
    if (events.turn) return { ok: true, operation: "create_thread", result: { threadId, hostId: "local", backend: FULL_ACCESS_BACKEND, firstTurn: { status: "accepted", turnId: events.turn.turnId } } };
    if (threadId && events.error) return { ok: true, operation: "create_thread", result: { threadId, hostId: "local", backend: FULL_ACCESS_BACKEND, firstTurn: { status: "failed", message: events.error.message } } };
    if (threadId) return { ok: true, operation: "create_thread", result: { status: "outcome-unknown", clientThreadId: threadId, hostId: "local" } };
    throw new Error(`The full-access app-server did not confirm creation${events.error ? `: ${events.error.message}` : ` within ${timeoutMs}ms`}. See ${runnerLogPath()}`);
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER) {
  const log = (line) => { try { fs.appendFileSync(runnerLogPath(), `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 }); } catch {} };
  process.stdout.on("error", () => {});
  const report = (event) => { log(JSON.stringify(event)); try { process.stdout.write(`${JSON.stringify(event)}\n`); } catch {} };
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    await runFullAccessTurn(JSON.parse(text), { report, log });
  } catch (error) {
    report({ event: "error", message: error.message });
    process.exitCode = 1;
  }
}
