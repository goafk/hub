// The ACP client side for threads the hub starts without Zed ("start now from the phone"):
// the agent still asks its client to read/write files and run terminals, and Zed doesn't know
// these sessions, so the relay answers those requests itself, on this Mac, like Zed would.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Term = { proc: ChildProcess; out: string; truncated: boolean; limit: number; exit?: { exitCode: number | null; signal: string | null }; waiters: Array<(e: any) => void> };

export class HostClient {
  private terms = new Map<string, Term>();
  private seq = 0;

  /** Handles one agent → client request. Returns the result, or throws { code, message }. */
  async handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "fs/read_text_file": {
        const text = fs.readFileSync(String(p.path), "utf8");
        if (!p.line && !p.limit) return { content: text };
        const lines = text.split("\n");
        const start = Math.max(0, (p.line ?? 1) - 1);
        return { content: lines.slice(start, p.limit ? start + p.limit : undefined).join("\n") };
      }
      case "fs/write_text_file": {
        fs.mkdirSync(path.dirname(String(p.path)), { recursive: true });
        fs.writeFileSync(String(p.path), String(p.content ?? ""));
        return null;
      }
      case "terminal/create": {
        const id = `afk-term-${++this.seq}`;
        const env = { ...process.env, ...Object.fromEntries((p.env ?? []).map((e: any) => [e.name, e.value])) };
        const args: string[] = Array.isArray(p.args) ? p.args : [];
        // A bare command line (no args) runs through the shell, like a terminal would.
        const proc = args.length ? spawn(p.command, args, { cwd: p.cwd, env }) : spawn(p.command, { cwd: p.cwd, env, shell: true });
        const t: Term = { proc, out: "", truncated: false, limit: Number(p.outputByteLimit) || 1_000_000, waiters: [] };
        const add = (b: Buffer) => {
          t.out += b.toString("utf8");
          if (Buffer.byteLength(t.out) > t.limit) {
            t.out = t.out.slice(-t.limit);
            t.truncated = true;
          }
        };
        proc.stdout?.on("data", add);
        proc.stderr?.on("data", add);
        const done = (code: number | null, signal: NodeJS.Signals | null) => {
          if (t.exit) return;
          t.exit = { exitCode: code, signal };
          t.waiters.splice(0).forEach((w) => w(t.exit));
        };
        proc.on("exit", done);
        proc.on("error", (e) => {
          add(Buffer.from(`${e.message}\n`));
          done(127, null);
        });
        this.terms.set(id, t);
        return { terminalId: id };
      }
      case "terminal/output": {
        const t = this.term(p.terminalId);
        return { output: t.out, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
      }
      case "terminal/wait_for_exit": {
        const t = this.term(p.terminalId);
        return t.exit ?? new Promise((resolve) => t.waiters.push(resolve));
      }
      case "terminal/kill": {
        const t = this.term(p.terminalId);
        if (!t.exit) t.proc.kill("SIGTERM");
        return null;
      }
      case "terminal/release": {
        const t = this.terms.get(p.terminalId);
        if (t && !t.exit) t.proc.kill("SIGTERM");
        this.terms.delete(p.terminalId);
        return null;
      }
      default:
        throw Object.assign(new Error(`${method} is not supported for threads started from the phone`), { code: -32601 });
    }
  }

  private term(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw Object.assign(new Error(`unknown terminal ${id}`), { code: -32602 });
    return t;
  }
}
