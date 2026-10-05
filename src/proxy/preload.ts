// In-process sync for registry agents (Claude Agent, Codex): Zed launches the agent with
//   NODE_OPTIONS=--import=<this file>  AFK_AGENT=<agent id>  (ACP_SYNC_* names from before the rename work too)
// and this module wraps the process's own stdin/stdout with the relay, so every thread of that
// agent syncs while Zed keeps its normal name, icon and settings for it.
import { paths } from "../paths.ts";
import { createRelay } from "./relay.ts";

const agentId = process.env.AFK_AGENT || process.env.ACP_SYNC_AGENT;

// Never leak into processes the agent spawns (tests, npm, the Codex app-server, …).
if (process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.split(/\s+/)
    .filter((o) => !/preload\.(ts|mjs|js)$/.test(o) && o !== "--experimental-strip-types")
    .join(" ")
    .trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
}
delete process.env.AFK_AGENT;
delete process.env.ACP_SYNC_AGENT;
const defaults = safeJson(process.env.AFK_DEFAULTS || process.env.ACP_SYNC_DEFAULTS) ?? {};
delete process.env.AFK_DEFAULTS;
delete process.env.ACP_SYNC_DEFAULTS;

if (agentId) install(agentId);

function install(id: string): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const origEmit = stdin.emit.bind(stdin) as (ev: string | symbol, ...args: any[]) => boolean;
  const origWrite = stdout.write.bind(stdout) as (chunk: any, ...rest: any[]) => boolean;

  const relay = createRelay({
    agentId: id,
    name: process.env.AFK_NAME ?? process.env.ACP_SYNC_NAME ?? id,
    defaults,
    sock: paths().sock,
    // Lines for the agent are delivered as if they had arrived on stdin.
    writeAgent: (line) => {
      const data = line + "\n";
      origEmit("data", stdin.readableEncoding ? data : Buffer.from(data));
    },
    writeZed: (line) => {
      origWrite(line + "\n");
    },
  });
  delete process.env.AFK_NAME;
  delete process.env.ACP_SYNC_NAME;

  // Zed -> agent: intercept stdin data events, line by line.
  let inBuf = "";
  (stdin as any).emit = (ev: string | symbol, ...args: any[]) => {
    if (ev !== "data") return origEmit(ev, ...args);
    inBuf += typeof args[0] === "string" ? args[0] : Buffer.from(args[0]).toString("utf8");
    let i: number;
    while ((i = inBuf.indexOf("\n")) >= 0) {
      const line = inBuf.slice(0, i);
      inBuf = inBuf.slice(i + 1);
      if (line.trim()) relay.fromZed(line);
    }
    return true;
  };

  // agent -> Zed: intercept stdout writes, line by line.
  let outBuf = "";
  (stdout as any).write = (chunk: any, enc?: any, cb?: any) => {
    const callback = typeof enc === "function" ? enc : cb;
    outBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let i: number;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      if (line.trim()) relay.fromAgent(line);
    }
    if (callback) process.nextTick(callback);
    return true;
  };

  process.on("exit", () => relay.link.close());
}

function safeJson(s?: string): any {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}
