#!/usr/bin/env python3
"""Per-caller stdio end of the shared cross-session-bridge daemon (src/bridge-daemon.mjs): ~5–10 MB of python instead of a
node supervisor + worker pair (~65–120 MB) in every Claude session and every loaded Codex thread.

Claude Code: command = "/usr/bin/python3", args = ["<repo>/scripts/bridge-shim.py"] (~/.local/share/cross-session-bridge/shim.py
links here). The daemon identifies the caller by the pid this shim reports — its own parent, the Claude process — and
CLAUDE_CONFIG_DIR.
Codex (~/.codex/config.toml): args = ["<repo>/scripts/bridge-shim.py", "cross-session-bridge"]. The daemon identifies the
thread by the _meta of each tool call, as the stdio server did; the pid this shim reports names the thread's peer entry.
initialize and tools/list are answered at once from the cache file (refreshed from the daemon on every connect), so a slow or
restarting daemon never fails the client's MCP startup. A daemon restart is invisible to the client: the shim reconnects and
replays the MCP handshake. Calls in flight at that moment get an error and are never retried."""
from __future__ import annotations

import json
import os
import queue
import socket
import sys
import threading
import time

SERVER = sys.argv[1] if len(sys.argv) > 1 else "claude"
HOME = os.path.expanduser("~/.local/share/cross-session-bridge")
if SERVER == "claude":
    SOCKET = os.environ.get("CROSS_SESSION_BRIDGE_SOCKET") or os.path.join(HOME, "daemon.sock")
    CACHE = os.environ.get("CROSS_SESSION_BRIDGE_SHIM_CACHE") or os.path.join(HOME, "claude-shim-cache.json")
    CALLER = {"ppid": os.getppid(), "configDir": os.environ.get("CLAUDE_CONFIG_DIR")}
else:
    SOCKET = os.environ.get("CROSS_SESSION_BRIDGE_CODEX_SOCKET") or os.path.join(HOME, "codex-daemon.sock")
    CACHE = os.environ.get("CROSS_SESSION_BRIDGE_CODEX_SHIM_CACHE") or os.path.join(HOME, "codex-shim-cache.json")
    CALLER = {"codex": {"pid": os.getpid(), "server": SERVER}}
HELLO = json.dumps({"bridge_caller": CALLER}).encode() + b"\n"
TOOLS_REFRESH = b'{"jsonrpc":"2.0","id":"shim:tools","method":"tools/list"}\n'
LOST = ("The shared cross-session-bridge daemon restarted while this call was in flight. The operation may already have been "
        "dispatched; it was not retried. Check get_oai_request / read_oai_session / get_delivery before any resend.")

lock = threading.Lock()  # the daemon connection
state = threading.Lock()  # pending and swallow
output = threading.Lock()
outbox: queue.Queue[tuple[int, bytes]] = queue.Queue()
generation = 0  # bumped when a lost connection's pending calls are failed; older queued lines are never sent
handshake: list[bytes] = []
pending: dict[str, object] = {}
swallow: dict[str, str] = {}
conn: socket.socket | None = None
connected = threading.Event()


def parse(line: bytes) -> dict:
    try:
        message = json.loads(line)
    except ValueError:
        return {}
    return message if isinstance(message, dict) else {}


def emit(message: dict) -> None:
    with output:
        sys.stdout.buffer.write(json.dumps(message).encode() + b"\n")
        sys.stdout.buffer.flush()


def load_cache() -> dict:
    try:
        return json.load(open(CACHE)).get(SERVER, {})
    except (OSError, ValueError, AttributeError):
        return {}


def store_cache(key: str, result: dict) -> None:
    if load_cache().get(key) == result:
        return
    try:
        cache = json.load(open(CACHE))
    except (OSError, ValueError):
        cache = {}
    cache.setdefault(SERVER, {})[key] = result
    tmp = f"{CACHE}.{os.getpid()}"
    json.dump(cache, open(tmp, "w"))
    os.replace(tmp, CACHE)


def connect(replay: bool):
    while True:
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.connect(SOCKET)
            sock.sendall(HELLO)
            reader = sock.makefile("rb")
            if parse(reader.readline()).get("bridge_ready"):
                if replay and handshake:
                    with state:
                        swallow[json.dumps(parse(handshake[0]).get("id"))] = "initialize"
                        swallow[json.dumps("shim:tools")] = "tools"
                    for line in handshake:
                        sock.sendall(line)
                    sock.sendall(TOOLS_REFRESH)
                return sock, reader
            sock.close()
        except OSError:
            pass
        time.sleep(1)


def link() -> None:
    global conn, generation
    while True:
        with state:
            for request_id in pending.values():
                emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": LOST}})
            pending.clear()
            if conn is not None:
                generation += 1
        with lock:
            replay = conn is not None
            if conn:
                conn.close()
            conn, reader = connect(replay)
        connected.set()
        for line in iter(reader.readline, b""):
            message = parse(line)
            key = json.dumps(message.get("id"))
            if "method" in message or "id" not in message:
                emit(message)
                continue
            with state:
                kind = swallow.pop(key, None)
                visible = pending.pop(key, None) is not None
            if kind and "result" in message:
                store_cache(kind, message["result"])
            if visible:
                emit(message)


def send() -> None:
    connected.wait()
    while True:
        stamp, line = outbox.get()
        with lock:
            if stamp != generation:
                continue
            try:
                conn.sendall(line)
            except OSError:
                pass


def main() -> None:
    threading.Thread(target=link, daemon=True).start()
    threading.Thread(target=send, daemon=True).start()
    for line in sys.stdin.buffer:
        message = parse(line)
        method, request_id = message.get("method"), message.get("id")
        cache = load_cache()
        with state:
            if method == "initialize":
                handshake[:] = [line]
                if "initialize" in cache:
                    emit({"jsonrpc": "2.0", "id": request_id, "result": cache["initialize"]})
                    swallow[json.dumps(request_id)] = "initialize"
                    outbox.put((generation, line))
                    continue
            elif method == "notifications/initialized":
                handshake.append(line)
                swallow[json.dumps("shim:tools")] = "tools"
                outbox.put((generation, line))
                outbox.put((generation, TOOLS_REFRESH))
                continue
            elif method == "tools/list" and "tools" in cache:
                emit({"jsonrpc": "2.0", "id": request_id, "result": cache["tools"]})
                continue
            if method and "id" in message:
                pending[json.dumps(request_id)] = request_id
                if method in ("initialize", "tools/list"):
                    swallow[json.dumps(request_id)] = method.split("/")[0]
            outbox.put((generation, line))

if __name__ == "__main__":
    main()
