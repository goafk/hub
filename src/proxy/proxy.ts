// Out-of-process ACP proxy: Zed (our stdio) <-> relay <-> the real agent (child stdio).
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { onLines } from "../lines.ts";
import type { HubLink } from "./hublink.ts";
import { createRelay } from "./relay.ts";

export { optionValues, PROXY_COMMANDS } from "./relay.ts";

export type ProxyOpts = {
  agentId: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  defaults: Record<string, string>;
  sock: string;
  stdin: Readable;
  stdout: Writable;
  rpcTimeoutMs?: number;
};

export function startProxy(opts: ProxyOpts): { done: Promise<number>; link: HubLink } {
  const child = spawn(opts.command, opts.args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(opts.env ?? {}) } });
  const relay = createRelay({
    agentId: opts.agentId,
    name: opts.name,
    defaults: opts.defaults,
    sock: opts.sock,
    rpcTimeoutMs: opts.rpcTimeoutMs,
    writeAgent: (line) => child.stdin.write(line + "\n"),
    writeZed: (line) => opts.stdout.write(line + "\n"),
  });
  onLines(opts.stdin, relay.fromZed);
  onLines(child.stdout!, relay.fromAgent);
  const done = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      relay.link.close();
      resolve(code ?? 0);
    });
    opts.stdin.on("end", () => child.stdin.end());
  });
  return { done, link: relay.link };
}
