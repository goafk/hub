// Folds mirrored ACP traffic into thread state + transcript entries. Pure: no I/O.

export type Dir = "zed->agent" | "agent->zed" | "sync->agent" | "sync->zed";

export type Entry = {
  seq: number;
  kind: "user" | "agent" | "thought" | "tool_call" | "plan";
  text?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  data?: any;
};

export type PendingPermission = { requestId: string | number; toolCall?: any; options: any[] };

export type Thread = {
  id: string;
  agentId: string;
  cwd: string;
  title?: string;
  status: "idle" | "running" | "needs_permission" | "offline";
  conn?: string;
  inFlight: number;
  configOptions?: any[];
  modes?: any;
  /** When the last turn ended, and when the user last looked at the thread (for the inbox). */
  turnEndedAt?: number;
  seenAt?: number;
  /** Slash commands the agent offers (ACP available_commands_update). */
  availableCommands?: Array<{ name: string; description?: string; input?: { hint?: string } | null }>;
  models?: any;
  usage?: any;
  createdAt: number;
  updatedAt: number;
  pendingPermissions: PendingPermission[];
  /** Agent questions (ACP `elicitation/create`), e.g. Claude's AskUserQuestion form. */
  pendingElicitations: PendingElicitation[];
};

export type PendingElicitation = {
  requestId: string | number;
  mode: string;
  toolCallId?: string;
  message: string;
  requestedSchema?: any;
  url?: string;
};

export type HubEvent = {
  type: "thread.created" | "thread.updated" | "entry.upserted" | "entries.cleared" | "needs_input";
  threadId: string;
  data: any;
};

type Req = { method: string; params: any };

const CHUNK_KIND: Record<string, Entry["kind"]> = {
  user_message_chunk: "user",
  agent_message_chunk: "agent",
  agent_thought_chunk: "thought",
};

export function contentText(c: any): string {
  if (!c) return "";
  if (c.type === "text") return c.text ?? "";
  if (c.type === "resource_link") return `@${c.name ?? c.uri}`;
  if (c.type === "resource") return `@${c.resource?.uri ?? "resource"}`;
  return `[${c.type}]`;
}

export class Interpreter {
  threads = new Map<string, Thread>();
  entries = new Map<string, Entry[]>();
  private emit: (e: HubEvent) => void;
  private toAgent = new Map<string, Map<string | number, Req>>(); // conn -> id -> request sent to agent
  private toZed = new Map<string, Map<string | number, Req>>(); // conn -> id -> request sent by agent
  private open = new Set<string>(); // threads whose last entry may still receive chunks

  constructor(emit: (e: HubEvent) => void) {
    this.emit = emit;
  }

  restore(threads: Thread[], entries: Map<string, Entry[]>): void {
    for (const t of threads) {
      this.threads.set(t.id, { ...t, status: "offline", conn: undefined, inFlight: 0, pendingPermissions: [], pendingElicitations: [] });
      this.entries.set(t.id, entries.get(t.id) ?? []);
    }
  }

  /** A proxy (re)connected and reports sessions it already knows about. */
  attach(conn: string, agentId: string, sessions: Array<{ sessionId: string; cwd?: string; configOptions?: any[]; modes?: any; availableCommands?: any[] }>): void {
    for (const s of sessions) {
      const t = this.threads.get(s.sessionId) ?? this.create(s.sessionId, agentId, s.cwd ?? "");
      t.conn = conn;
      if (t.status === "offline") t.status = "idle";
      if (s.configOptions) t.configOptions = s.configOptions;
      if (s.modes) t.modes = s.modes;
      if (s.availableCommands) t.availableCommands = s.availableCommands;
      this.touch(t);
    }
  }

  /** The user opened/read the thread (clears its unread mark). */
  markSeen(id: string): void {
    const t = this.threads.get(id);
    if (!t) return;
    t.seenAt = Date.now();
    this.touch(t);
  }

  disconnect(conn: string): void {
    this.toAgent.delete(conn);
    this.toZed.delete(conn);
    for (const t of this.threads.values()) {
      if (t.conn !== conn) continue;
      t.conn = undefined;
      t.status = "offline";
      t.inFlight = 0;
      t.pendingPermissions = [];
      t.pendingElicitations = [];
      this.touch(t);
    }
  }

  handle(agentId: string, conn: string, dir: Dir, msg: any): void {
    if (!msg || typeof msg !== "object") return;
    const isRequest = msg.method !== undefined && msg.id !== undefined;
    const isNotification = msg.method !== undefined && msg.id === undefined;
    const towardAgent = dir === "zed->agent" || dir === "sync->agent";

    if (isRequest) {
      const book = this.book(towardAgent ? this.toAgent : this.toZed, conn);
      book.set(msg.id, { method: msg.method, params: msg.params });
      this.onRequest(agentId, conn, dir, msg);
    } else if (isNotification) {
      if (msg.method === "session/update") this.onUpdate(msg.params, dir);
    } else if (msg.id !== undefined) {
      // Response: to an agent-bound request if it travels agent->zed, else to an agent's request.
      const book = this.book(towardAgent ? this.toZed : this.toAgent, conn);
      const req = book.get(msg.id);
      if (!req) return;
      book.delete(msg.id);
      this.onResponse(agentId, conn, req, msg);
    }
  }

  private book(m: Map<string, Map<string | number, Req>>, conn: string) {
    let b = m.get(conn);
    if (!b) m.set(conn, (b = new Map()));
    return b;
  }

  private onRequest(agentId: string, conn: string, dir: Dir, msg: any): void {
    const p = msg.params ?? {};
    const t = p.sessionId ? this.threads.get(p.sessionId) : undefined;
    switch (msg.method) {
      case "session/load": {
        const th = t ?? this.create(p.sessionId, agentId, p.cwd ?? "");
        th.conn = conn;
        th.status = "idle";
        th.cwd = p.cwd ?? th.cwd;
        this.entries.set(th.id, []);
        this.open.delete(th.id);
        this.emit({ type: "entries.cleared", threadId: th.id, data: {} });
        this.touch(th);
        break;
      }
      case "session/prompt": {
        if (!t) return;
        t.conn = conn;
        t.inFlight++;
        t.status = "running";
        this.open.delete(t.id);
        if (dir === "zed->agent") {
          t.seenAt = Date.now(); // replying in Zed means you've seen it
          const text = (p.prompt ?? []).map(contentText).join("");
          this.push(t, { kind: "user", text });
          this.open.delete(t.id);
        }
        this.touch(t);
        break;
      }
      case "elicitation/create": {
        if (!t) return;
        t.pendingElicitations.push({ requestId: msg.id, mode: p.mode ?? "form", toolCallId: p.toolCallId, message: p.message ?? "", requestedSchema: p.requestedSchema, url: p.url });
        t.status = "needs_permission";
        this.touch(t);
        this.emit({ type: "needs_input", threadId: t.id, data: { reason: "question", requestId: msg.id, message: p.message, requestedSchema: p.requestedSchema } });
        break;
      }
      case "session/request_permission": {
        if (!t) return;
        t.pendingPermissions.push({ requestId: msg.id, toolCall: p.toolCall, options: p.options ?? [] });
        t.status = "needs_permission";
        this.touch(t);
        this.emit({ type: "needs_input", threadId: t.id, data: { reason: "permission", requestId: msg.id, toolCall: p.toolCall, options: p.options ?? [] } });
        break;
      }
    }
  }

  private onResponse(agentId: string, conn: string, req: Req, msg: any): void {
    const r = msg.result ?? {};
    const p = req.params ?? {};
    switch (req.method) {
      case "session/new": {
        if (!r.sessionId) return;
        const t = this.threads.get(r.sessionId) ?? this.create(r.sessionId, agentId, p.cwd ?? "");
        t.conn = conn;
        t.status = "idle";
        this.applyMeta(t, r);
        this.touch(t);
        break;
      }
      case "session/load":
      case "session/resume": {
        const t = this.threads.get(p.sessionId);
        if (!t) return;
        this.open.delete(t.id);
        this.applyMeta(t, r);
        this.touch(t);
        break;
      }
      case "session/prompt": {
        const t = this.threads.get(p.sessionId);
        if (!t) return;
        t.inFlight = Math.max(0, t.inFlight - 1);
        if (r.stopReason !== "cancelled") t.turnEndedAt = Date.now();
        if (t.inFlight === 0) t.status = this.waiting(t) ? "needs_permission" : "idle";
        this.open.delete(t.id);
        if (r.usage) t.usage = { ...(t.usage ?? {}), ...r.usage };
        this.touch(t);
        const data = msg.error
          ? { reason: "turn_ended", stopReason: "error", error: msg.error.message ?? msg.error }
          : { reason: "turn_ended", stopReason: r.stopReason };
        this.emit({ type: "needs_input", threadId: t.id, data });
        break;
      }
      case "session/set_config_option":
      case "session/set_mode":
      case "session/set_model": {
        const t = this.threads.get(p.sessionId);
        if (!t || msg.error) return;
        if (r.configOptions) t.configOptions = r.configOptions;
        if (req.method === "session/set_mode" && t.modes) t.modes = { ...t.modes, currentModeId: p.modeId };
        if (req.method === "session/set_model" && t.models) t.models = { ...t.models, currentModelId: p.modelId };
        this.touch(t);
        break;
      }
      case "elicitation/create": {
        const t = this.threads.get(p.sessionId);
        if (!t) return;
        t.pendingElicitations = t.pendingElicitations.filter((x) => x.requestId !== msg.id);
        this.settle(t);
        break;
      }
      case "session/request_permission": {
        const t = this.threads.get(p.sessionId);
        if (!t) return;
        t.pendingPermissions = t.pendingPermissions.filter((x) => x.requestId !== msg.id);
        this.settle(t);
        this.touch(t);
        break;
      }
    }
  }

  private onUpdate(params: any, _dir: Dir): void {
    const t = params?.sessionId ? this.threads.get(params.sessionId) : undefined;
    const u = params?.update;
    if (!t || !u) return;
    const kind = CHUNK_KIND[u.sessionUpdate];
    if (kind) {
      const list = this.entries.get(t.id)!;
      const last = list.at(-1);
      const text = contentText(u.content);
      if (last && last.kind === kind && this.open.has(t.id)) {
        // Mentions arrive as their own chunks: keep them readable as "… @file.ts".
        const sep = u.content?.type !== "text" && last.text && !/\s$/.test(last.text) ? " " : "";
        last.text = (last.text ?? "") + sep + text;
        this.emit({ type: "entry.upserted", threadId: t.id, data: last });
      } else {
        this.push(t, { kind, text });
      }
      t.updatedAt = Date.now();
      return;
    }
    switch (u.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        const list = this.entries.get(t.id)!;
        const existing = list.find((e) => e.kind === "tool_call" && e.toolCallId === u.toolCallId);
        const { sessionUpdate: _s, ...rest } = u;
        if (existing) {
          existing.data = { ...(existing.data ?? {}), ...rest };
          if (u.title) existing.title = u.title;
          if (u.status) existing.status = u.status;
          this.emit({ type: "entry.upserted", threadId: t.id, data: existing });
        } else {
          this.push(t, { kind: "tool_call", toolCallId: u.toolCallId, title: u.title, status: u.status, data: rest });
        }
        this.open.delete(t.id);
        break;
      }
      case "plan": {
        const list = this.entries.get(t.id)!;
        const existing = list.find((e) => e.kind === "plan");
        if (existing) {
          existing.data = u.entries;
          this.emit({ type: "entry.upserted", threadId: t.id, data: existing });
        } else this.push(t, { kind: "plan", data: u.entries });
        this.open.delete(t.id);
        break;
      }
      case "config_option_update":
        t.configOptions = u.configOptions;
        this.touch(t);
        break;
      case "current_mode_update":
        t.modes = { ...(t.modes ?? {}), currentModeId: u.currentModeId };
        this.touch(t);
        break;
      case "session_info_update":
        if (u.title !== undefined) t.title = u.title;
        this.touch(t);
        break;
      case "available_commands_update":
        t.availableCommands = u.availableCommands ?? [];
        this.touch(t);
        break;
      case "usage_update": {
        const { sessionUpdate: _s, ...rest } = u;
        t.usage = { ...(t.usage ?? {}), ...rest };
        this.touch(t);
        break;
      }
    }
  }

  private waiting(t: Thread): boolean {
    return t.pendingPermissions.length > 0 || t.pendingElicitations.length > 0;
  }

  /** Recomputes status after an agent request (permission/question) was answered. */
  private settle(t: Thread): void {
    if (!this.waiting(t)) t.status = t.inFlight > 0 ? "running" : t.status === "offline" ? "offline" : "idle";
    this.touch(t);
  }

  private applyMeta(t: Thread, r: any): void {
    if (r.configOptions) t.configOptions = r.configOptions;
    if (r.modes) t.modes = r.modes;
    if (r.models) t.models = r.models;
  }

  private create(id: string, agentId: string, cwd: string): Thread {
    const now = Date.now();
    const t: Thread = { id, agentId, cwd, status: "idle", inFlight: 0, createdAt: now, updatedAt: now, pendingPermissions: [], pendingElicitations: [] };
    this.threads.set(id, t);
    this.entries.set(id, []);
    this.emit({ type: "thread.created", threadId: id, data: t });
    return t;
  }

  private push(t: Thread, e: Omit<Entry, "seq">): void {
    const list = this.entries.get(t.id)!;
    const entry: Entry = { seq: (list.at(-1)?.seq ?? 0) + 1, ...e };
    list.push(entry);
    this.open.add(t.id);
    t.updatedAt = Date.now();
    this.emit({ type: "entry.upserted", threadId: t.id, data: entry });
  }

  private touch(t: Thread): void {
    t.updatedAt = Date.now();
    this.emit({ type: "thread.updated", threadId: t.id, data: t });
  }
}
