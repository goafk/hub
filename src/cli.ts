// afk command line: setup, hub daemon, proxy entry, and a thin API client.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { envVar, paths, zedConfigDir, zedSupportDir } from "./paths.ts";

const CLI_ENTRY = path.resolve(import.meta.dirname, "cli.ts");

const USAGE = `afk — two-way sync between Zed agent threads and a local hub

Setup:
  afk setup [--no-lan] [--no-tailscale]      sync Zed's agents, start the hub, pair a phone
  afk pair                                  show a new pairing QR for another phone
  afk devices [revoke <id>]                 list paired phones / remove one
  afk uninstall                             remove everything setup added
  afk hub                                   run the hub in the foreground
  afk permissions [--reset]                 check/grant the macOS permission for "new"

Use:
  afk status                                hub + connected agents
  afk threads [--status S]                  list synced threads
  afk show <thread>                         print a thread's transcript
  afk new <project> <agent> [prompt…]       start a thread in Zed
  afk send <thread> <text…>                 send a prompt into a thread
  afk set <thread> <configId> <value>       change model/mode/effort/…
  afk approve <thread> <optionId>           answer a pending permission
  afk cancel <thread>                       cancel the running turn
  afk watch [thread]                        stream live events

<thread> may be any unique prefix of a thread id.`;

async function api(method: string, p: string, body?: unknown): Promise<any> {
  const cfg = loadConfig();
  const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
  let r: Response;
  try {
    r = await fetch(`http://${host}:${cfg.port}${p}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`hub is not running on ${host}:${cfg.port} (start it: afk hub, or afk setup)`);
  }
  const json: any = await r.json();
  if (!r.ok) throw new Error(`${json.error?.code ?? r.status}: ${json.error?.message ?? "request failed"}`);
  return json;
}

async function resolveThread(prefix: string): Promise<string> {
  if (!prefix) throw new Error("thread id required");
  const list: any[] = await api("GET", "/threads");
  const hits = list.filter((t) => t.id.startsWith(prefix));
  if (hits.length === 1) return hits[0].id;
  if (!hits.length) throw new Error(`no thread matches ${prefix}`);
  throw new Error(`ambiguous thread prefix ${prefix} (${hits.length} matches)`);
}

async function resolveAgent(q: string): Promise<string> {
  const agents: any[] = await api("GET", "/agents");
  const lc = q.toLowerCase();
  const hit = agents.find((a) => a.agentId === q) ?? agents.find((a) => a.agentId.toLowerCase().startsWith(lc) || a.name.toLowerCase().startsWith(lc));
  if (!hit) throw new Error(`unknown agent ${q}; set up: ${agents.map((a) => a.agentId).join(", ")}`);
  return hit.agentId;
}

async function resolveProject(q: string): Promise<string> {
  if (fs.existsSync(q) && fs.statSync(q).isDirectory()) return path.resolve(q);
  for (const base of ["Herd", "projects", "code", "src"]) {
    const p = path.join(os.homedir(), base, q);
    if (fs.existsSync(p)) return p;
  }
  const threads: any[] = await api("GET", "/threads");
  const hit = threads.find((t) => path.basename(t.cwd) === q);
  if (hit) return hit.cwd;
  throw new Error(`project not found: ${q}`);
}

const short = (id: string) => id.slice(0, 8);
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

function printEntry(e: any): void {
  if (e.kind === "user") console.log(`\n▶ you: ${e.text}`);
  else if (e.kind === "agent") console.log(`\n${e.text}`);
  else if (e.kind === "thought") console.log(`\n  (thinking) ${String(e.text).slice(0, 200)}`);
  else if (e.kind === "tool_call") console.log(`  • ${e.title ?? "tool"} [${e.status ?? ""}]`);
  else if (e.kind === "plan") console.log(`  plan: ${(e.data ?? []).map((p: any) => p.content).join(" / ")}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  switch (cmd) {
    case "proxy": {
      const { proxyMain } = await import("./proxy/main.ts");
      return proxyMain(rest);
    }
    case "hub": {
      const { runHub } = await import("./hub/main.ts");
      return runHub();
    }
    case "setup": {
      const { install } = await import("./setup/install.ts");
      const { setupTailscale, lanAddress, reachable } = await import("./setup/network.ts");
      const { printPairing } = await import("./setup/pair.ts");
      const { hubInfo } = await import("./hub/http.ts");
      const { saveConfig } = await import("./config.ts");
      const noLaunchd = rest.includes("--no-launchd");
      const lan = !rest.includes("--no-lan");
      const only = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
      const ok = (m: string) => console.log(`  ✓ ${m}`);
      const warn = (m: string) => console.log(`  ! ${m}`);
      console.log("Setting up afk\n");
      // Renamed from acp-sync: move ~/.acp-sync to ~/.afk (state, pairings, history). A link stays at
      // the old path so agents Zed already started keep working until Zed restarts.
      {
        const { legacyHome } = await import("./paths.ts");
        const { uninstallLaunchd } = await import("./setup/install.ts");
        const old = legacyHome();
        const fresh = path.join(os.homedir(), ".afk");
        if (!envVar("HOME") && fs.existsSync(old) && !fs.lstatSync(old).isSymbolicLink() && !fs.existsSync(fresh)) {
          uninstallLaunchd("dev.acp-sync.hub");
          fs.renameSync(old, fresh);
          fs.symlinkSync(fresh, old);
          ok("Moved ~/.acp-sync to ~/.afk (renamed)");
        }
      }

      // Phones on the same Wi-Fi reach the hub directly (every request needs a key either way).
      const cfg0 = loadConfig();
      if (lan && cfg0.host !== "0.0.0.0") saveConfig({ ...cfg0, host: "0.0.0.0" });
      if (fs.existsSync("/Applications/Zed.app") || fs.existsSync(path.join(os.homedir(), "Applications", "Zed.app"))) ok("Zed found");
      else warn("Zed.app not found in /Applications — install Zed, then run `afk setup` again");

      const r = install({ zedConfig: zedConfigDir(), zedSupport: zedSupportDir(), nodePath: process.execPath, cliEntry: CLI_ENTRY, only, launchd: !noLaunchd });
      if (r.agents.length) ok(`Synced agents: ${r.agents.map((a) => a.zedName).join(", ")}`);
      else warn("No agents found in Zed yet — add Claude Agent or Codex in Zed's Agent panel, then run setup again");

      const cfg = loadConfig();
      const local = `http://127.0.0.1:${cfg.port}`;
      let up = false;
      for (let i = 0; i < 20 && !up && !noLaunchd; i++) {
        up = await reachable(local, cfg.token, 1500);
        if (!up) await new Promise((res) => setTimeout(res, 500));
      }
      if (noLaunchd) warn("Start the hub yourself: afk hub");
      else if (up) ok(`Hub running in the background (logs: ${paths().logs}/hub.log)`);
      else warn(`Hub did not start — see ${paths().logs}/hub.log`);

      const urls: string[] = [];
      if (!rest.includes("--no-tailscale")) {
        const ts = setupTailscale(cfg.port);
        if (ts.ok) {
          urls.push(ts.url);
          ok(`Reachable anywhere over Tailscale: ${ts.url}`);
        } else if (ts.reason === "missing") warn("Tailscale not installed — the phone works on this Wi-Fi only. For anywhere access: https://tailscale.com/download, then run setup again");
        else if (ts.reason === "stopped") warn("Tailscale is installed but not connected — open it and sign in, then run setup again");
        else warn(`Tailscale Serve could not start: ${ts.detail}`);
      }
      const ip = lan ? lanAddress() : undefined;
      if (ip) {
        urls.push(`http://${ip}:${cfg.port}`);
        ok(`Reachable on this Wi-Fi: http://${ip}:${cfg.port}`);
      }
      if (!urls.length) throw new Error("no way for a phone to reach this Mac (no Tailscale, no network address)");

      const zedRunning = (() => {
        try {
          execFileSync("pgrep", ["-x", "zed"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      if (zedRunning && r.agents.length) warn("Restart Zed once so open agent threads start syncing (Cmd-Q, then reopen)");

      const info = hubInfo(cfg);
      await printPairing(paths().home, cfg, info.name, urls);
      return;
    }
    case "pair": {
      const { setupTailscale, lanAddress } = await import("./setup/network.ts");
      const { printPairing } = await import("./setup/pair.ts");
      const { hubInfo } = await import("./hub/http.ts");
      const cfg = loadConfig();
      const urls: string[] = [];
      const ts = setupTailscale(cfg.port);
      if (ts.ok) urls.push(ts.url);
      const ip = cfg.host === "0.0.0.0" ? lanAddress() : undefined;
      if (ip) urls.push(`http://${ip}:${cfg.port}`);
      if (!urls.length) throw new Error("no way for a phone to reach this Mac — run `afk setup` first");
      await printPairing(paths().home, cfg, hubInfo(cfg).name, urls);
      return;
    }
    case "devices": {
      const { Pairing } = await import("./hub/pairing.ts");
      const pairing = new Pairing(paths().home);
      if (rest[0] === "revoke") {
        if (!rest[1]) throw new Error("usage: afk devices revoke <id>");
        console.log(pairing.revoke(rest[1]) ? `Removed ${rest[1]} — that phone can no longer connect.` : `No phone with id ${rest[1]}`);
        return;
      }
      const list = pairing.clients();
      if (!list.length) console.log("No phones paired yet. Pair one: afk pair");
      for (const c of list) {
        const seen = c.lastSeen ? `last seen ${new Date(c.lastSeen).toLocaleString()}` : "not seen yet";
        console.log(`  ${c.id}  ${c.name.padEnd(24)} paired ${new Date(c.createdAt).toLocaleDateString()} · ${seen}`);
      }
      return;
    }
    case "permissions": {
      const { ensureKeyHelper, probeKeyHelper, HELPER_BUNDLE_ID } = await import("./setup/keyhelper.ts");
      const { execFileSync } = await import("node:child_process");
      ensureKeyHelper(paths().home);
      if (rest.includes("--reset")) {
        for (const svc of ["AppleEvents", "Accessibility"]) {
          try { execFileSync("tccutil", ["reset", svc, HELPER_BUNDLE_ID], { stdio: "ignore" }); } catch {}
        }
      }
      const r = probeKeyHelper(paths().home);
      if (r === "ok") {
        console.log("✓ AcpSyncKeys can press Zed keybindings — `afk new` will work.");
        return;
      }
      console.log(`✗ AcpSyncKeys is not allowed yet: ${r}`);
      console.log("  1. Allow the “control System Events” prompt if one appeared (or run: afk permissions --reset).");
      console.log("  2. In the Accessibility list that is opening now, turn on AcpSyncKeys");
      console.log(`     (use “+” and pick ${path.join(paths().home, "AcpSyncKeys.app")} if it is not listed).`);
      console.log("  3. Run: afk permissions");
      execFileSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
      process.exitCode = 1;
      return;
    }
    case "uninstall": {
      const { uninstall } = await import("./setup/install.ts");
      uninstall({ zedConfig: zedConfigDir(), launchd: !rest.includes("--no-launchd") });
      console.log("Removed synced agents, keybindings, and the hub launch agent. History kept in", paths().db);
      return;
    }
    case "status": {
      const h = await api("GET", "/health");
      const agents: any[] = await api("GET", "/agents");
      console.log(`hub ok · ${h.agents} agent type(s) connected`);
      for (const a of agents) console.log(`  ${a.agentId.padEnd(16)} ${a.zedName.padEnd(32)} processes: ${a.connections}`);
      return;
    }
    case "threads": {
      const status = flag("--status");
      const list: any[] = await api("GET", `/threads${status ? `?status=${status}` : ""}`);
      for (const t of list) {
        console.log(`${short(t.id)}  ${t.agentId.padEnd(12)} ${t.status.padEnd(16)} ${ago(t.updatedAt).padStart(4)}  ${path.basename(t.cwd).padEnd(16)} ${t.title ?? (t.preview ?? "").replace(/\s+/g, " ").slice(0, 50)}`);
      }
      if (!list.length) console.log("no synced threads yet — start one in Zed with a “(synced)” agent");
      return;
    }
    case "show": {
      const t = await api("GET", `/threads/${await resolveThread(rest[0])}`);
      console.log(`${t.title ?? "(untitled)"} — ${t.agentId} — ${t.cwd} — ${t.status}`);
      for (const o of t.configOptions ?? []) console.log(`  ${o.id}: ${o.currentValue}`);
      for (const e of t.entries) printEntry(e);
      for (const p of t.pendingPermissions ?? []) {
        console.log(`\n⚠ permission needed: ${p.toolCall?.title ?? "tool"} — options: ${p.options.map((o: any) => o.optionId).join(", ")}`);
      }
      return;
    }
    case "new": {
      const [project, agent, ...words] = rest;
      if (!project || !agent) throw new Error("usage: afk new <project> <agent> [prompt…]");
      const t = await api("POST", "/threads", { cwd: await resolveProject(project), agentId: await resolveAgent(agent), prompt: words.join(" ") || undefined });
      console.log(`started ${short(t.id)} (${t.agentId}) in ${t.cwd}`);
      return;
    }
    case "send": {
      const id = await resolveThread(rest[0]);
      await api("POST", `/threads/${id}/prompt`, { text: rest.slice(1).join(" ") });
      console.log(`sent to ${short(id)}`);
      return;
    }
    case "set": {
      const id = await resolveThread(rest[0]);
      const r = await api("POST", `/threads/${id}/config`, { configId: rest[1], value: rest[2] });
      const o = (r.configOptions ?? []).find((x: any) => x.id === rest[1]);
      console.log(`${rest[1]} = ${o?.currentValue ?? rest[2]}`);
      return;
    }
    case "approve": {
      const id = await resolveThread(rest[0]);
      await api("POST", `/threads/${id}/permission`, { optionId: rest[1] });
      console.log("answered");
      return;
    }
    case "cancel": {
      await api("POST", `/threads/${await resolveThread(rest[0])}/cancel`);
      console.log("cancel sent");
      return;
    }
    case "watch": {
      const cfg = loadConfig();
      const id = rest[0] ? await resolveThread(rest[0]) : undefined;
      const r = await fetch(`http://127.0.0.1:${cfg.port}/events${id ? `?thread=${id}` : ""}`, { headers: { authorization: `Bearer ${cfg.token}` } });
      const dec = new TextDecoder();
      const lastStatus = new Map<string, string>();
      let buf = "";
      for await (const chunk of r.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const d = JSON.parse(data);
          const t = short(d.threadId ?? "");
          if (ev === "entry.upserted") console.log(`[${t}] ${d.data.kind}: ${String(d.data.text ?? d.data.title ?? "").slice(-120).replace(/\s+/g, " ")}`);
          else if (ev === "needs_input") console.log(`[${t}] 🔔 needs input: ${d.data.reason}${d.data.stopReason ? ` (${d.data.stopReason})` : ""}`);
          else if (ev === "thread.updated") {
            if (lastStatus.get(d.threadId) === d.data.status) continue;
            lastStatus.set(d.threadId, d.data.status);
            console.log(`[${t}] ${d.data.status} ${d.data.title ?? ""}`);
          }
          else console.log(`[${t}] ${ev}`);
        }
      }
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`afk: ${e.message}`);
  process.exit(1);
});
