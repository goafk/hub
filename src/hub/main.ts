// Runs the hub daemon: unix socket for proxies + HTTP/SSE API.
import fs from "node:fs";
import path from "node:path";
import { Notifier } from "./notify.ts";
import { MetaStore, pickAllowOption } from "./meta.ts";
import { loadConfig } from "../config.ts";
import { paths, zedSupportDir } from "../paths.ts";
import { ZedReader } from "./zed.ts";
import { ProgressThrottle, UsageLedger, progressOf } from "./extras.ts";
import { PendingLaunches } from "./pending.ts";
import { Hub } from "./hub.ts";
import { hubInfo, startHttp } from "./http.ts";
import { Launcher } from "./launcher.ts";

export async function runHub(): Promise<void> {
  const p = paths();
  fs.mkdirSync(p.home, { recursive: true });
  const cfg = loadConfig();
  const hub = new Hub({ sock: p.sock, dbFile: p.db });
  await hub.start();
  const launcher = new Launcher(hub, () => loadConfig());
  const zed = new ZedReader(zedSupportDir());
  const notifier = new Notifier(path.join(p.home, "devices.json"));
  notifier.hub = () => hubInfo(loadConfig());
  const meta = new MetaStore(path.join(p.home, "thread-meta.json"));
  const usage = new UsageLedger(path.join(p.home, "usage.json"));
  for (const t of hub.interpreter.threads.values()) if (t.usage?.cost?.amount !== undefined) usage.seed(t.id, Number(t.usage.cost.amount));
  setInterval(() => usage.flush(), 30_000).unref();
  const pending = new PendingLaunches(path.join(p.home, "pending-launches.json"));
  const api = await startHttp(hub, { host: cfg.host, port: cfg.port, cfg: () => loadConfig(), launcher, zed, notifier, meta, usage, pending, adopt: (id) => adoptNow(id) });
  // Threads asked for while the Mac was locked: start them in Zed once it's unlocked.
  let starting = false;
  setInterval(async () => {
    if (starting || !pending.list().length || (await launcher.locked())) return;
    starting = true;
    try {
      for (const w of [...pending.list()]) {
        const project = path.basename(w.cwd);
        try {
          const t = await launcher.launch({ cwd: w.cwd, agentId: w.agentId, prompt: w.prompt });
          pending.remove(w.id);
          log(`started waiting thread ${t.id} in ${w.cwd}`);
          notifier.message({ title: `${project} · started in Zed`, body: w.prompt ? `“${w.prompt.slice(0, 120)}”` : "Your new thread is ready.", threadId: t.id }).catch(() => {});
        } catch (err: any) {
          log(`waiting thread failed: ${err.message}`);
          if (!pending.failed(w.id)) notifier.message({ title: `${project} · couldn't start the thread`, body: err.message }).catch(() => {});
        }
        hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
      }
    } finally {
      starting = false;
    }
  }, 10_000).unref();
  // Phone-only threads move into Zed once the Mac is unlocked and nobody is using it (so the
  // hub bringing Zed forward never interrupts you). The app's "Move into Zed" does it on demand.
  const adoptTries = new Map<string, number>();
  let adopting = false;
  const adoptNow = async (id: string) => {
    const t = hub.interpreter.threads.get(id);
    if (!t) return;
    await hub.adopt(id, () => launcher.openNewThread(t.cwd, t.agentId));
    meta.set(id, { phoneOnly: false });
    hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
    log(`moved phone thread ${id} into Zed`);
  };
  setInterval(async () => {
    if (adopting) return;
    const waiting = [...hub.interpreter.threads.values()].filter((t) => meta.get(t.id).phoneOnly && t.status === "idle" && (adoptTries.get(t.id) ?? 0) < 3);
    if (!waiting.length || (await launcher.locked()) || (await launcher.idleSeconds()) < 120) return;
    adopting = true;
    try {
      for (const t of waiting) {
        try {
          await adoptNow(t.id);
          notifier.message({ title: `${path.basename(t.cwd)} · now in Zed`, body: "Your phone thread is in Zed's sidebar, with its whole conversation.", threadId: t.id }).catch(() => {});
        } catch (err: any) {
          adoptTries.set(t.id, (adoptTries.get(t.id) ?? 0) + 1);
          log(`moving ${t.id} into Zed failed: ${err.message}`);
        }
      }
    } finally {
      adopting = false;
    }
  }, 30_000).unref();
  const titleOf = (t: { id: string; title?: string }) => t.title ?? (zed.available() ? zed.thread(t.id)?.title : undefined) ?? "Thread";
  // Cost ledger + the phone's live "agent working" notification.
  const throttle = new ProgressThrottle();
  const pushProgress = (id: string) => {
    const t = hub.interpreter.threads.get(id);
    if (!t) return;
    const pr = progressOf(t, hub.interpreter.entries.get(id) ?? [], titleOf(t));
    if (throttle.shouldSend(pr)) notifier.progress(pr).catch((err) => log(`progress push error ${err.message}`));
  };
  hub.on("event", (e: any) => {
    if (e.type !== "thread.updated" && e.type !== "entry.upserted" && e.type !== "needs_input") return;
    const t = hub.interpreter.threads.get(e.threadId);
    if (!t) return;
    if (e.type === "thread.updated") usage.observe(t.id, t.usage?.cost);
    pushProgress(t.id);
  });
  // Catch up on changes the throttle held back.
  setInterval(() => {
    for (const t of hub.interpreter.threads.values()) if (t.status === "running" || t.status === "needs_permission") pushProgress(t.id);
  }, 25_000).unref();
  // Threads switched to "approve everything" in the app get their permission requests answered here.
  hub.on("event", (e: any) => {
    if (e.type !== "needs_input" || e.data?.reason !== "permission" || !meta.get(e.threadId).autoApprove) return;
    const optionId = pickAllowOption(e.data.options ?? []);
    if (!optionId) return;
    hub.command(e.threadId, { cmd: "permission", requestId: e.data.requestId, optionId }).then(
      () => log(`auto-approved ${e.data.toolCall?.title ?? "tool"} in ${e.threadId}`),
      (err) => log(`auto-approve failed: ${err.message}`),
    );
  });
  hub.on("event", (e: any) => {
    if (e.type !== "needs_input") return;
    // Auto-approved permissions don't need a notification.
    if (e.data?.reason === "permission" && meta.get(e.threadId).autoApprove && pickAllowOption(e.data.options ?? [])) return;
    const t = hub.interpreter.threads.get(e.threadId);
    if (!t) return;
    const lastAgent = [...(hub.interpreter.entries.get(t.id) ?? [])].reverse().find((x) => x.kind === "agent")?.text ?? "";
    // Prefer Zed's own title for the thread when the agent didn't set one.
    const title = t.title ?? (zed.available() ? zed.thread(t.id)?.title : undefined);
    notifier.notify(e, { id: t.id, title, cwd: t.cwd }, lastAgent).catch((err) => log(`push error ${err.message}`));
  });
  // Zed's sidebar (all threads, any agent) lives in its own DB: poll it for changes.
  let sig = "";
  setInterval(() => {
    try {
      if (!zed.available()) return;
      const next = zed.signature();
      if (next !== sig) {
        if (sig) hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
        sig = next;
      }
    } catch {}
  }, 2000).unref();
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
  log(`hub listening on http://${cfg.host}:${api.port} and ${p.sock}`);
  hub.on("event", (e: any) => {
    if (e.type === "agent.connected" || e.type === "agent.disconnected") log(`${e.type} ${e.data.agentId} ${e.data.conn}`);
    else if (e.type === "thread.created") log(`thread.created ${e.threadId} ${e.data.agentId} ${e.data.cwd}`);
    else if (e.type === "needs_input") log(`needs_input ${e.threadId} ${e.data.reason}`);
  });
  const shutdown = async () => {
    log("shutting down");
    usage.flush();
    await api.close();
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
