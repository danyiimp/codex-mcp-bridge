#!/usr/bin/env node
import { runSupervisor } from "./mcp-supervisor.mjs";

await runSupervisor("cross-session-bridge.mjs");
