// Starts a new agent thread in Zed: focus the project in the existing window, press the
// synced agent's keybinding, wait for the proxy to report the new session, then prompt it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { keyHelperFiles } from "../setup/keyhelper.ts";
import { HubError } from "./hub.ts";
import type { Hub } from "./hub.ts";
import type { Thread } from "./interpreter.ts";

export type Runner = (cmd: string, args: string[]) => Promise<string>;

export const execRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const why = err.killed ? "timed out (macOS may be waiting on a permission prompt)" : (stderr || err.message).trim();
      reject(new Error(`${path.basename(cmd)} ${why}`));
    }),
  );

const MODS: Record<string, string> = { ctrl: "control down", alt: "option down", cmd: "command down", shift: "shift down" };

/** "ctrl-alt-cmd-z a" -> AppleScript lines pressing each stroke in turn. */
export function keystrokeScript(keys: string): string[] {
  return keys.split(" ").filter(Boolean).flatMap((stroke) => {
    const parts = stroke.split("-");
    const key = parts.pop()!;
    const mods = parts.map((p) => MODS[p]).filter(Boolean);
    const using = mods.length ? ` using {${mods.join(", ")}}` : "";
    return [`tell application "System Events" to keystroke "${key}"${using}`, "delay 0.15"];
  });
}

export function findZedCli(cfg: Config): string {
  if (cfg.zedCli) return cfg.zedCli;
  for (const c of ["/usr/local/bin/zed", "/opt/homebrew/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli"]) {
    if (fs.existsSync(c)) return c;
  }
  return "zed";
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export class Launcher {
  private hub: Hub;
  private cfg: () => Config;
  private run: Runner;
  private timeoutMs: number;
  private settleMs: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(hub: Hub, cfg: () => Config, opts: { run?: Runner; timeoutMs?: number; settleMs?: number } = {}) {
    this.hub = hub;
    this.cfg = cfg;
    this.run = opts.run ?? execRunner;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.settleMs = opts.settleMs ?? 900;
  }

  launch(req: { cwd: string; agentId: string; prompt?: string }): Promise<Thread> {
    const next = this.chain.then(() => this.launchNow(req));
    this.chain = next.catch(() => {});
    return next;
  }

  private async launchNow({ cwd, agentId, prompt }: { cwd: string; agentId: string; prompt?: string }): Promise<Thread> {
    const cfg = this.cfg();
    const binding = cfg.bindings[agentId];
    if (!binding) throw new HubError("invalid", `agent ${agentId} is not set up (run: afk setup)`);
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HubError("invalid", `not a directory: ${cwd}`);
    const target = real(cwd);
    const start = Date.now();
    const wait = this.hub.waitForThread((t) => t.agentId === agentId && t.createdAt >= start && real(t.cwd) === target, this.timeoutMs);
    wait.catch(() => {});
    await this.run(findZedCli(cfg), ["-e", target]);
    await new Promise((r) => setTimeout(r, this.settleMs));
    const script = ['tell application "Zed" to activate', "delay 0.3", ...keystrokeScript(binding.keys)];
    try {
      if (cfg.keyHelper) await this.pressViaHelper(cfg.keyHelper, script);
      else await this.run("osascript", script.flatMap((l) => ["-e", l]));
    } catch (e: any) {
      const who = cfg.keyHelper ? "AcpSyncKeys" : "the process running the hub";
      throw new HubError("launch_failed", `${e.message} — allow ${who} in System Settings → Privacy & Security → Accessibility`);
    }
    const thread = await wait;
    if (prompt) await this.hub.command(thread.id, { cmd: "prompt", text: prompt });
    return thread;
  }

  /** Runs the keystroke script inside the AcpSyncKeys applet (which holds the Accessibility grant). */
  private async pressViaHelper(app: string, script: string[]): Promise<void> {
    const f = keyHelperFiles(path.dirname(app));
    fs.writeFileSync(f.script, script.join("\n"));
    fs.rmSync(f.result, { force: true });
    await this.run("open", ["-W", "-g", "-a", app]);
    const result = fs.existsSync(f.result) ? fs.readFileSync(f.result, "utf8") : "error: helper produced no result";
    if (result !== "ok") throw new Error(result.replace(/^error: /, "AcpSyncKeys: "));
  }
}
