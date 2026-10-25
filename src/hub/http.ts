import crypto from "node:crypto";
// REST + Server-Sent Events API over the hub.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { searchFiles } from "./files.ts";
import * as git from "./git.ts";
import type { Config } from "../config.ts";
import type { PromptCommand } from "./queue.ts";
import { HubError } from "./hub.ts";
import { Pairing } from "./pairing.ts";
import { paths, zedConfigDir, zedSupportDir } from "../paths.ts";
import { readZedTheme } from "./zedtheme.ts";
import { searchEntries, type UsageLedger } from "./extras.ts";
import type { PendingLaunches } from "./pending.ts";
import { VERSION } from "../version.ts";
import type { Hub } from "./hub.ts";
import type { Thread } from "./interpreter.ts";
import type { Launcher } from "./launcher.ts";
import { transcriptFor } from "./transcripts.ts";
import type { SidebarThread, ZedReader } from "./zed.ts";
import type { Notifier } from "./notify.ts";
import type { MetaStore } from "./meta.ts";

const STATUS: Record<string, number> = {
  not_found: 404, busy: 409, outdated: 409, git_error: 422, offline: 409, invalid: 400, timeout: 504, agent_error: 502, unauthorized: 401, launch_failed: 500, locked: 409,
};

/** Constant-time comparison for secrets. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b ?? "");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export const isLoopback = (addr?: string) => !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

/** "claude" | "codex" | "cursor" | "other" — drives the icon clients show, like Zed's agent icons. */
export function agentKind(id: string): string {
  const a = id.toLowerCase();
  return a.includes("claude") ? "claude" : a.includes("codex") ? "codex" : a.includes("cursor") ? "cursor" : a.includes("gemini") ? "gemini" : "other";
}

/** Overlays app-side rename/archive/auto-approve onto a thread summary. */
function withMeta<T extends { id: string; title?: string }>(t: T, meta?: MetaStore): T & { archived: boolean; autoApprove: boolean; zedTitle?: string } {
  const m = meta?.get(t.id) ?? {};
  return { ...t, title: m.title ?? t.title, zedTitle: m.title ? t.title : undefined, archived: !!m.archived, autoApprove: !!m.autoApprove };
}

/** Hub agent id for a Zed agent id (registry id, or a "(synced)" entry's binding). */
function agentIdFor(cfg: Config, zedAgentId: string): string | undefined {
  const bound = Object.entries(cfg.bindings).find(([, b]) => b.zedName === zedAgentId)?.[0];
  return bound ?? (cfg.bindings[zedAgentId] ? zedAgentId : undefined);
}

function withLive(hub: Hub, cfg: Config, t: SidebarThread) {
  const live = hub.interpreter.threads.get(t.id);
  const syncedAgent = Object.entries(cfg.bindings).find(([, b]) => b.zedName === t.agentId)?.[0];
  return {
    ...t,
    kind: agentKind(syncedAgent ?? t.agentId),
    synced: !!syncedAgent || !!live,
    status: live?.status ?? "unsynced",
    unread: live ? isUnread(live) : false,
    preview: live ? [...(hub.interpreter.entries.get(live.id) ?? [])].reverse().find((e) => e.kind === "agent")?.text?.slice(-160) : undefined,
    online: !!live?.conn,
    // Zed's own activity time, so ages match its sidebar (hub reconnects don't count as activity).
    updatedAt: Math.max(t.updatedAt, live?.turnEndedAt ?? 0),
    title: live?.title ?? t.title,
  };
}

/** Only list files inside folders Zed (or a synced thread) already works in. */
function knownProject(hub: Hub, zed: ZedReader | undefined, cwd: string): boolean {
  if (!cwd) return false;
  for (const t of hub.interpreter.threads.values()) if (t.cwd === cwd) return true;
  try {
    return !!zed?.available() && zed.sidebar().some((p) => p.paths.includes(cwd));
  } catch {
    return false;
  }
}

/** An @-mention (project-relative path) as an ACP resource_link, the way Zed sends mentions. */
export function mentionBlock(cwd: string, rel: string) {
  const abs = path.resolve(cwd, rel);
  if (abs !== cwd && !abs.startsWith(cwd.replace(/\/$/, "") + "/")) throw new HubError("invalid", `mention outside project: ${rel}`);
  return { type: "resource_link", uri: pathToFileURL(abs).href, name: path.basename(abs) || rel };
}

/** Finished since you last looked (questions/permissions show as waiting instead). */
export function isUnread(t: Thread): boolean {
  return !!t.turnEndedAt && (!t.seenAt || t.seenAt < t.turnEndedAt);
}

export function hubInfo(cfg: Config): { id: string; name: string; version: string } {
  return { id: cfg.hubId, name: cfg.name || computerName(), version: VERSION };
}

let cachedName: string | undefined;
function computerName(): string {
  if (cachedName) return cachedName;
  try {
    cachedName = execFileSync("scutil", ["--get", "ComputerName"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  return (cachedName ||= os.hostname().replace(/\.local$/, ""));
}

function summary(hub: Hub, t: Thread) {
  const entries = hub.interpreter.entries.get(t.id) ?? [];
  const lastAgent = [...entries].reverse().find((e) => e.kind === "agent");
  const { conn: _c, ...rest } = t;
  return { ...rest, online: !!t.conn, entryCount: entries.length, preview: lastAgent?.text?.slice(-200), unread: isUnread(t), queued: hub.queue.list(t.id) };
}

async function body(req: http.IncomingMessage, max = 1_000_000): Promise<any> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > max) throw new HubError("invalid", "body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HubError("invalid", "body is not JSON");
  }
}

export function startHttp(
  hub: Hub,
  opts: {
    host: string;
    port: number;
    cfg: () => Config;
    launcher: Launcher;
    zed?: ZedReader;
    notifier?: Notifier;
    meta?: MetaStore;
    usage?: UsageLedger;
    pending?: PendingLaunches;
    /** Moves a phone-only thread into Zed now ("Move into Zed" in the app). */
    adopt?: (threadId: string) => Promise<void>;
    pairing?: Pairing;
    isLoopback?: (addr?: string) => boolean;
  },
): Promise<{ port: number; close: () => Promise<void> }> {
  const loopback = opts.isLoopback ?? isLoopback;
  let sseClients = 0;
  const pairing = opts.pairing ?? new Pairing(paths().home);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // The app's web build runs on another origin; auth is the bearer token, not cookies.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      // Requests relayed by a local proxy (e.g. `tailscale serve`) arrive from 127.0.0.1 but come from
      // another device: they must carry the token like any remote client.
      const proxied = !!(req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"] || req.headers["forwarded"]);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const m = req.method;
      // Pairing: a one-time code from `afk setup` / `afk pair` buys this phone its own key.
      if (m === "POST" && url.pathname === "/pair") {
        const b = await body(req);
        // Rate-limit per sender. Behind a local proxy (Tailscale Serve) the sender is in its header.
        const who = proxied && loopback(req.socket.remoteAddress) ? String(req.headers["x-forwarded-for"] ?? req.headers["tailscale-user-login"] ?? "proxy").split(",")[0].trim() : req.socket.remoteAddress ?? "";
        const r = pairing.redeem(String(b.code ?? ""), String(b.name ?? "Phone"), Date.now(), who);
        if (!r) throw new HubError("unauthorized", "pairing code is wrong or expired — run `afk pair` for a new one");
        return send(200, { key: r.key, client: r.client, hub: hubInfo(opts.cfg()) });
      }
      // Every request needs the token or a paired phone's key, also from this Mac: otherwise any
      // web page open in a browser here could drive the hub (and the agents) through localhost.
      {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "") || url.searchParams.get("token") || "";
        if (!sameSecret(token, opts.cfg().token) && !pairing.verify(token)) throw new HubError("unauthorized", "missing or bad token");
      }

      if (m === "GET" && url.pathname === "/info") return send(200, hubInfo(opts.cfg()));
      if (m === "GET" && url.pathname === "/clients") return send(200, pairing.clients().map(({ keyHash: _h, ...c }) => c));
      if (m === "POST" && url.pathname === "/clients/revoke") {
        const b = await body(req);
        return send(pairing.revoke(String(b.id ?? "")) ? 200 : 404, { ok: true });
      }

      if (m === "GET" && url.pathname === "/health") return send(200, { ok: true, agents: hub.agents().length });
      if (m === "GET" && url.pathname === "/agents") {
        const live = new Map(hub.agents().map((a) => [a.agentId, a.connections]));
        const cfg = opts.cfg();
        return send(200, Object.entries(cfg.bindings).map(([agentId, b]) => ({ agentId, name: b.name, zedName: b.zedName, keys: b.keys, connections: live.get(agentId) ?? 0 })));
      }
      if (url.pathname === "/devices" || parts[0] === "devices") {
        if (!opts.notifier) throw new HubError("not_found", "notifications are not enabled");
        if (m === "GET" && parts.length === 1) return send(200, opts.notifier.list().map((d) => ({ ...d, token: d.token.slice(0, 22) + "…" })));
        if (m === "POST" && parts.length === 1) {
          const b = await body(req);
          try {
            return send(200, opts.notifier.register({ token: b.token, platform: String(b.platform ?? "unknown"), name: b.name, prefs: b.prefs, showHub: !!b.showHub }));
          } catch (e: any) {
            throw new HubError("invalid", e.message);
          }
        }
        if (m === "POST" && parts[1] === "test") return send(200, await opts.notifier.test(String((await body(req)).token ?? "")));
        if (m === "POST" && parts[2] === "delete") {
          opts.notifier.unregister(parts[1]);
          return send(200, { ok: true });
        }
      }
      if (parts[0] === "git") {
        const b = m === "POST" ? await body(req) : {};
        const cwd = String(m === "POST" ? b.cwd ?? "" : url.searchParams.get("cwd") ?? "");
        if (!knownProject(hub, opts.zed, cwd)) throw new HubError("invalid", "not a known project folder");
        try {
          if (m === "GET" && parts[1] === "status") return send(200, await git.status(cwd));
          if (m === "GET" && parts[1] === "diff") return send(200, { diff: await git.diff(cwd, url.searchParams.get("file") ?? "") });
          if (m === "POST" && parts[1] === "commit") return send(200, await git.commit(cwd, String(b.message ?? ""), Array.isArray(b.files) ? b.files.map(String) : undefined));
          if (m === "POST" && parts[1] === "discard") {
            await git.discard(cwd, Array.isArray(b.files) ? b.files.map(String) : []);
            return send(200, { ok: true });
          }
          if (m === "POST" && parts[1] === "push") return send(200, { output: await git.push(cwd) });
        } catch (e: any) {
          throw new HubError(e.code === "invalid" ? "invalid" : "git_error", e.message);
        }
      }
      if (m === "GET" && url.pathname === "/files") {
        const cwd = url.searchParams.get("cwd") ?? "";
        if (!knownProject(hub, opts.zed, cwd)) throw new HubError("invalid", "not a known project folder");
        return send(200, { files: searchFiles(cwd, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 40)) });
      }
      if (m === "GET" && url.pathname === "/events") {
        if (sseClients >= 32) throw new HubError("busy", "too many live connections");
        sseClients++;
        res.on("close", () => sseClients--);
        return sse(hub, req, res, url.searchParams.get("thread"));
      }
      if (m === "GET" && url.pathname === "/search") {
        const threads = [...hub.interpreter.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
        const hits = searchEntries(hub.interpreter.entries, threads.map((t) => t.id), url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 40));
        const title = (id: string) => hub.interpreter.threads.get(id)?.title ?? (opts.zed?.available() ? opts.zed.thread(id)?.title : undefined) ?? "Thread";
        return send(200, { results: hits.map((h) => ({ ...h, title: title(h.threadId), cwd: hub.interpreter.threads.get(h.threadId)?.cwd ?? "", updatedAt: hub.interpreter.threads.get(h.threadId)?.updatedAt ?? 0 })) });
      }
      if (m === "GET" && url.pathname === "/usage") {
        const sum = opts.usage?.summary() ?? { currency: "USD", today: 0, days: [], byThread: {} };
        const threads = [...hub.interpreter.threads.values()]
          .filter((t) => t.usage)
          .map((t) => ({
            id: t.id,
            title: t.title ?? (opts.zed?.available() ? opts.zed.thread(t.id)?.title : undefined) ?? "Thread",
            cwd: t.cwd,
            status: t.status,
            used: t.usage?.used,
            size: t.usage?.size,
            cost: t.usage?.cost?.amount,
            week: sum.byThread[t.id] ?? 0,
            updatedAt: t.updatedAt,
          }))
          .sort((a, b) => b.week - a.week || (b.cost ?? 0) - (a.cost ?? 0))
          .slice(0, 30);
        const { byThread: _b, ...totals } = sum;
        return send(200, { ...totals, threads });
      }
      if (m === "GET" && url.pathname === "/zed/theme") return send(200, readZedTheme(zedConfigDir(), zedSupportDir()));
      if (m === "POST" && url.pathname === "/threads/seen") {
        // Mark all as read: one call for the whole inbox.
        const b = await body(req);
        if (!Array.isArray(b.ids)) throw new HubError("invalid", "ids must be an array");
        for (const id of b.ids) hub.interpreter.markSeen(String(id));
        return send(200, { ok: true });
      }
      if (m === "GET" && url.pathname === "/zed/sidebar") {
        if (!opts.zed?.available()) throw new HubError("not_found", "Zed database not found");
        const cfg = opts.cfg();
        const projects: any[] = opts.zed.sidebar().map((p) => ({ ...p, threads: p.threads.map((t) => withMeta(withLive(hub, cfg, t), opts.meta)) }));
        const projectFor = (cwd: string) => {
          let p = projects.find((x) => x.path === cwd || (x.paths ?? []).includes(cwd));
          if (!p) projects.push((p = { name: path.basename(cwd), path: cwd, paths: [cwd], expanded: true, threads: [] }));
          return p;
        };
        // Threads started from the phone without Zed: Zed's database doesn't know them.
        const inZed = new Set(projects.flatMap((p) => p.threads.map((t: any) => t.id)));
        for (const t of hub.interpreter.threads.values()) {
          if (inZed.has(t.id) || !opts.meta?.get(t.id).phoneOnly) continue;
          const b = cfg.bindings[t.agentId];
          const firstUser = (hub.interpreter.entries.get(t.id) ?? []).find((e) => e.kind === "user")?.text;
          const st = { id: t.id, title: t.title ?? firstUser?.split("\n")[0].slice(0, 80) ?? "New thread", agentId: b?.zedName ?? t.agentId, agentName: b?.name ?? t.agentId, createdAt: t.createdAt, updatedAt: t.updatedAt, cwd: t.cwd };
          const p = projectFor(t.cwd);
          p.threads = [{ ...withMeta(withLive(hub, cfg, st as SidebarThread), opts.meta), phoneOnly: true }, ...p.threads];
        }
        // Waiting to start in Zed once the Mac is unlocked.
        for (const w of opts.pending?.list() ?? []) {
          const p = projectFor(w.cwd);
          (p.pending ??= []).push({ id: w.id, prompt: w.prompt, agentName: cfg.bindings[w.agentId]?.name ?? w.agentId, createdAt: w.createdAt });
        }
        return send(200, { projects });
      }
      if (m === "POST" && parts[0] === "zed" && parts[1] === "threads" && parts[3] === "meta") {
        if (!opts.meta) throw new HubError("not_found", "metadata store not enabled");
        const b = await body(req);
        const next = opts.meta.set(parts[2], { title: b.title, archived: b.archived, autoApprove: b.autoApprove });
        hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
        return send(200, next);
      }
      if (m === "POST" && parts[0] === "zed" && parts[1] === "threads" && parts[3] === "resume") {
        const meta = opts.zed?.available() ? opts.zed.thread(parts[2]) : undefined;
        const known = hub.interpreter.threads.get(parts[2]);
        const agentId = known?.agentId ?? agentIdFor(opts.cfg(), meta?.agentId ?? "");
        const cwd = known?.cwd ?? meta?.cwd;
        if (!agentId || !cwd) throw new HubError("not_found", `no thread ${parts[2]}`);
        const wasLive = !!hub.interpreter.threads.get(parts[2])?.conn;
        await hub.resume(parts[2], agentId, cwd);
        // Zed applies your agent defaults to sessions it opens; do the same for ones we open.
        if (!wasLive) {
          for (const [configId, value] of Object.entries(opts.cfg().bindings[agentId]?.defaults ?? {})) {
            await hub.command(parts[2], { cmd: "config", configId, value: String(value) }).catch(() => {});
          }
        }
        return send(200, { ok: true });
      }
      if (m === "GET" && parts[0] === "zed" && parts[1] === "threads" && parts.length === 3) {
        const id = parts[2];
        const live = hub.interpreter.threads.get(id);
        const meta = opts.zed?.available() ? opts.zed.thread(id) : undefined;
        if (!live && !meta) throw new HubError("not_found", `no thread ${id}`);
        const base = meta ? withLive(hub, opts.cfg(), meta) : undefined;
        if (live) {
          return send(200, withMeta({ ...base, ...summary(hub, live), title: live.title ?? base?.title, agentName: base?.agentName, kind: base?.kind ?? agentKind(live.agentId), synced: true, entries: hub.interpreter.entries.get(id) ?? [] }, opts.meta));
        }
        const { entries } = transcriptFor(meta!.agentId, meta!.cwd, id);
        return send(200, withMeta({ ...base, entries }, opts.meta));
      }
      if (parts[0] === "threads") {
        if (parts.length === 1 && m === "GET") {
          const q = url.searchParams;
          const list = [...hub.interpreter.threads.values()]
            .filter((t) => (!q.get("status") || t.status === q.get("status")) && (!q.get("cwd") || t.cwd === q.get("cwd")) && (!q.get("agent") || t.agentId === q.get("agent")))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((t) => summary(hub, t));
          return send(200, list);
        }
        if (parts.length === 1 && m === "POST") {
          const b = await body(req);
          // "when_unlocked": the Mac is locked, so keep the request and start it in Zed on unlock.
          if (b.mode === "when_unlocked" || b.mode === "phone") {
            // Only folders Zed already knows (a project in its sidebar), never an arbitrary path.
            if (!b.cwd || !fs.existsSync(b.cwd) || !fs.statSync(b.cwd).isDirectory()) throw new HubError("invalid", `not a directory: ${b.cwd}`);
            if (!knownProject(hub, opts.zed, b.cwd)) throw new HubError("invalid", "not a project Zed knows — open it in Zed once first");
          }
          if (b.mode === "when_unlocked") {
            if (!opts.pending) throw new HubError("not_found", "waiting threads are not enabled");
            if (!opts.cfg().bindings[b.agentId]) throw new HubError("invalid", `agent ${b.agentId} is not set up (run: afk setup)`);
            return send(202, { queued: opts.pending.add({ cwd: b.cwd, agentId: b.agentId, prompt: b.prompt }) });
          }
          // "phone": start it right away with the agent, without Zed (it won't be in Zed's sidebar).
          if (b.mode === "phone") {
            const t = await hub.startHeadless(String(b.agentId), String(b.cwd));
            opts.meta?.set(t.id, { phoneOnly: true });
            if (b.prompt) await hub.command(t.id, { cmd: "prompt", text: String(b.prompt) });
            hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
            return send(201, summary(hub, t));
          }
          const t = await opts.launcher.launch({ cwd: b.cwd, agentId: b.agentId, prompt: b.prompt });
          return send(201, summary(hub, t));
        }
        if (parts.length === 3 && parts[2] === "adopt" && m === "POST") {
          if (!opts.adopt) throw new HubError("not_found", "moving threads into Zed is not enabled");
          await opts.adopt(parts[1]);
          return send(200, { ok: true });
        }
        if (parts[1] === "pending" && parts[3] === "cancel" && m === "POST") {
          opts.pending?.remove(parts[2]);
          hub.emit("event", { type: "sidebar.changed", threadId: "", data: {} });
          return send(200, { ok: true });
        }
        const t = hub.thread(parts[1]);
        if (parts.length === 2 && m === "GET") return send(200, { ...summary(hub, t), phoneOnly: !!opts.meta?.get(t.id).phoneOnly, entries: hub.interpreter.entries.get(t.id) ?? [] });
        if (parts.length === 3 && m === "POST") {
          // Prompts may carry photos (base64), so they get a larger limit.
          const b = await body(req, parts[2] === "prompt" ? 30_000_000 : 1_000_000);
          switch (parts[2]) {
            case "prompt": {
              if (typeof b.text !== "string" || !b.text.trim()) throw new HubError("invalid", "text is required");
              const mentions: string[] = Array.isArray(b.mentions) ? b.mentions.map(String) : [];
              const images: any[] = Array.isArray(b.images) ? b.images.slice(0, 6) : [];
              for (const im of images) {
                if (!/^image\/(png|jpe?g|gif|webp)$/.test(String(im?.mimeType)) || typeof im?.data !== "string" || !im.data) throw new HubError("invalid", "images need a mimeType (png/jpeg/gif/webp) and base64 data");
              }
              const command: PromptCommand =
                !mentions.length && !images.length
                  ? { cmd: "prompt", text: b.text }
                  : {
                      cmd: "prompt",
                      text: b.text,
                      content: [
                        { type: "text", text: b.text },
                        ...mentions.map((m) => mentionBlock(t.cwd, m)),
                        ...images.map((im) => ({ type: "image", mimeType: im.mimeType, data: im.data })),
                      ],
                    };
              // Mid-turn messages wait for the turn to end, as in Zed (unless the caller insists).
              if (!b.now && hub.queue.busy(t.id)) return send(202, { queued: hub.queue.add(t.id, command) });
              return send(202, await hub.command(t.id, command));
            }
            case "queue": {
              const id = String(b.id ?? "");
              if (b.action === "clear") hub.queue.clear(t.id);
              else if (!id) throw new HubError("invalid", "id is required");
              else if (b.action === "remove") hub.queue.remove(t.id, id);
              else if (b.action === "edit") {
                if (typeof b.text !== "string" || !b.text.trim()) throw new HubError("invalid", "text is required");
                hub.queue.edit(t.id, id, b.text);
              } else if (b.action === "send_now") await hub.queue.sendNow(t.id, id);
              else throw new HubError("invalid", "action must be remove, edit, send_now or clear");
              return send(200, { queued: hub.queue.list(t.id) });
            }
            case "config": {
              if (!b.configId || b.value === undefined) throw new HubError("invalid", "configId and value are required");
              const opt = (t.configOptions ?? []).find((o: any) => o.id === b.configId);
              if (opt?.type === "boolean") {
                // Boolean options (e.g. Fast mode) take a real true/false. Sent as a plain ACP call so it
                // also works through older proxies, then Zed's toggle is updated to match.
                const value = b.value === true || String(b.value).toLowerCase() === "true" || String(b.value).toLowerCase() === "on";
                const r = await hub.command(t.id, { cmd: "rpc", method: "session/set_config_option", params: { sessionId: t.id, configId: b.configId, type: "boolean", value } });
                if (r?.configOptions) {
                  await hub.command(t.id, { cmd: "notify", method: "session/update", params: { sessionId: t.id, update: { sessionUpdate: "config_option_update", configOptions: r.configOptions } } });
                  t.configOptions = r.configOptions;
                }
                return send(200, { configOptions: r?.configOptions ?? t.configOptions });
              }
              return send(200, await hub.command(t.id, { cmd: "config", configId: b.configId, value: String(b.value) }));
            }
            case "seen":
              hub.interpreter.markSeen(t.id);
              return send(200, { ok: true });
            case "cancel":
              return send(200, await hub.command(t.id, { cmd: "cancel" }));
            case "elicitation": {
              const requestId = b.requestId ?? t.pendingElicitations[0]?.requestId;
              if (requestId === undefined) throw new HubError("not_found", "no pending question");
              return send(200, await hub.command(t.id, { cmd: "elicitation", requestId, action: b.action ?? "accept", content: b.content ?? {} }));
            }
            case "permission": {
              const requestId = b.requestId ?? t.pendingPermissions[0]?.requestId;
              if (requestId === undefined) throw new HubError("not_found", "no pending permission request");
              if (!b.optionId) throw new HubError("invalid", "optionId is required");
              return send(200, await hub.command(t.id, { cmd: "permission", requestId, optionId: b.optionId }));
            }
          }
        }
      }
      throw new HubError("not_found", `no route ${m} ${url.pathname}`);
    } catch (e: any) {
      if (res.headersSent) return res.end();
      const code = e instanceof HubError || e?.code ? e.code : "internal";
      send(STATUS[code] ?? 500, { error: { code, message: e?.message ?? String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}

const ALWAYS_SENT = new Set(["id", "status", "online", "title", "unread", "pendingPermissions", "pendingElicitations"]);

function sse(hub: Hub, req: http.IncomingMessage, res: http.ServerResponse, thread: string | null): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.socket?.setNoDelay(true);
  // A 2KB comment up front flushes proxy / client buffers (Tailscale serve, Android's HTTP stack),
  // so the app sees the stream as connected right away.
  res.write(`: connected ${" ".repeat(2048)}\n\n`);
  // Per connection: what we last sent for each thread. Thread updates fire many times a second while
  // an agent streams, and the slash-command list / model options alone are ~70KB — send fields only
  // when they changed (clients keep the previous value for anything missing).
  const sent = new Map<string, Map<string, string>>();
  const onEv = (e: any) => {
    if (thread && e.threadId !== thread) return;
    let data = e.data;
    if (e.type === "thread.updated" || e.type === "thread.created") {
      const t = hub.interpreter.threads.get(e.threadId);
      if (t) {
        const full: Record<string, unknown> = summary(hub, t);
        let last = sent.get(e.threadId);
        if (!last) sent.set(e.threadId, (last = new Map()));
        data = {};
        for (const [k, v] of Object.entries(full)) {
          const j = JSON.stringify(v) ?? "";
          if (ALWAYS_SENT.has(k) || last.get(k) !== j) {
            data[k] = v;
            last.set(k, j);
          }
        }
      }
    }
    res.write(`event: ${e.type}\ndata: ${JSON.stringify({ threadId: e.threadId, data })}\n\n`);
  };
  hub.on("event", onEv);
  const beat = setInterval(() => res.write(": ping\n\n"), 10_000);
  req.on("close", () => {
    clearInterval(beat);
    hub.off("event", onEv);
  });
}
