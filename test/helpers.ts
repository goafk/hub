import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onLines, tryParse } from "../src/lines.ts";
import { Hub } from "../src/hub/hub.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");

export function tmpHome(): { dir: string; sock: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acps-"));
  return { dir, sock: path.join(dir, "hub.sock"), db: path.join(dir, "hub.db") };
}

export async function startHub(home = tmpHome()): Promise<{ hub: Hub; home: ReturnType<typeof tmpHome> }> {
  const hub = new Hub({ sock: home.sock, dbFile: home.db });
  await hub.start();
  return { hub, home };
}

/** Plays Zed: spawns the proxy (wrapping the fake agent) and speaks ACP on its stdio. */
export class FakeZed {
  proc: ChildProcess;
  received: any[] = [];
  private nextId = 0;
  private waiters = new Map<number, (m: any) => void>();
  private listeners: Array<(m: any) => void> = [];

  /** inProcess: run the agent with the preload (like registry agents) instead of the proxy. */
  constructor(sock: string, defaults: Record<string, string> = {}, inProcess = false) {
    this.proc = inProcess
      ? spawn(process.execPath, ["--no-warnings", path.join(ROOT, "test/fixtures/fake-agent.ts")], {
          stdio: ["pipe", "pipe", "inherit"],
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${path.join(ROOT, "src/proxy/preload.ts")}`,
            ACP_SYNC_AGENT: "fake",
            ACP_SYNC_NAME: "Fake",
            ACP_SYNC_HOME: path.dirname(sock),
          },
        })
      : spawn(process.execPath, [
          "--no-warnings",
          path.join(ROOT, "src/proxy/main.ts"),
          "--agent", "fake", "--name", "Fake", "--sock", sock, "--defaults", JSON.stringify(defaults),
          "--", process.execPath, "--no-warnings", path.join(ROOT, "test/fixtures/fake-agent.ts"),
        ], { stdio: ["pipe", "pipe", "inherit"] });
    onLines(this.proc.stdout!, (line) => {
      const m = tryParse(line);
      if (!m) return;
      this.received.push(m);
      if (m.method === undefined && typeof m.id === "number" && this.waiters.has(m.id)) {
        this.waiters.get(m.id)!(m);
        this.waiters.delete(m.id);
      }
      for (const l of this.listeners) l(m);
    });
  }

  request(method: string, params: any): Promise<any> {
    const id = ++this.nextId;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((r) => this.waiters.set(id, r));
  }

  write(m: any): void {
    this.proc.stdin!.write(JSON.stringify(m) + "\n");
  }

  /** Waits for a message from the agent side matching pred (including already received). */
  next(pred: (m: any) => boolean, timeoutMs = 15000): Promise<any> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("FakeZed.next timeout")), timeoutMs);
      this.listeners.push((m) => {
        if (pred(m)) {
          clearTimeout(t);
          resolve(m);
        }
      });
    });
  }

  async open(cwd = "/proj"): Promise<string> {
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const r = await this.request("session/new", { cwd, mcpServers: [] });
    return r.result.sessionId;
  }

  kill(): void {
    this.proc.kill();
  }
}

export function until(pred: () => boolean, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("until: timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
