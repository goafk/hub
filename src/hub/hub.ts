// The hub: accepts proxy connections, interprets their mirrored ACP traffic,
// persists threads, and routes commands back to the proxy that owns a session.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { onLines, tryParse } from "../lines.ts";
import { Interpreter } from "./interpreter.ts";
import { PromptQueue } from "./queue.ts";
import type { HubEvent, Thread } from "./interpreter.ts";
import { Store } from "./store.ts";

export type Conn = {
  id: string;
  agentId: string;
  name: string;
  pid?: number;
  /** Commands the proxy supports; undefined for proxies older than this field. */
  commands?: string[];
  socket: net.Socket;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
};

export class HubError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Hub extends EventEmitter {
  interpreter: Interpreter;
  queue: PromptQueue;
  conns = new Map<string, Conn>();
  private server: net.Server | null = null;
  private store: Store;
  private sock: string;
  private nextConn = 0;
  private nextCmd = 0;
  private stopped = false;

  constructor(opts: { sock: string; dbFile: string }) {
    super();
    this.setMaxListeners(0);
    this.sock = opts.sock;
    this.store = new Store(opts.dbFile);
    this.interpreter = new Interpreter((e) => this.onEvent(e));
    this.queue = new PromptQueue(this);
    const { threads, entries } = this.store.load();
    this.interpreter.restore(threads, entries);
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.sock)) {
      const alive = await new Promise<boolean>((res) => {
        const s = net.createConnection(this.sock);
        s.on("connect", () => { s.destroy(); res(true); });
        s.on("error", () => res(false));
      });
      if (alive) throw new HubError("in_use", `another hub is listening on ${this.sock}`);
      fs.unlinkSync(this.sock);
    }
    this.server = net.createServer((s) => this.accept(s));
    await new Promise<void>((res) => this.server!.listen(this.sock, res));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.conns.values()) c.socket.destroy();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    this.store.close();
  }

  private onEvent(e: HubEvent): void {
    if (this.stopped) return;
    if (e.type === "thread.created" || e.type === "thread.updated") this.store.saveThread(e.data);
    else if (e.type === "entry.upserted") this.store.saveEntry(e.threadId, e.data);
    else if (e.type === "entries.cleared") this.store.clearEntries(e.threadId);
    this.emit("event", e);
  }

  private accept(socket: net.Socket): void {
    const conn: Conn = { id: `c${++this.nextConn}`, agentId: "?", name: "?", socket, pending: new Map() };
    let hello = false;
    onLines(socket, (line) => {
      const m = tryParse(line);
      if (!m) return;
      if (m.type === "hello") {
        conn.agentId = m.agentId;
        conn.name = m.name ?? m.agentId;
        conn.pid = m.pid;
        conn.commands = Array.isArray(m.commands) ? m.commands : undefined;
        if (!hello) {
          hello = true;
          this.conns.set(conn.id, conn);
          this.emit("event", { type: "agent.connected", threadId: "", data: { conn: conn.id, agentId: conn.agentId, name: conn.name, pid: conn.pid } });
        }
        this.interpreter.attach(conn.id, conn.agentId, m.sessions ?? []);
      } else if (m.type === "acp" && hello) {
        this.interpreter.handle(conn.agentId, conn.id, m.dir, m.msg);
      } else if (m.type === "reply") {
        const p = conn.pending.get(m.id);
        if (!p) return;
        conn.pending.delete(m.id);
        if (m.error) p.reject(new HubError(m.error.code ?? "proxy_error", m.error.message));
        else p.resolve(m.result);
      }
    });
    const drop = () => {
      if (!this.conns.has(conn.id)) return;
      this.conns.delete(conn.id);
      for (const p of conn.pending.values()) p.reject(new HubError("offline", "proxy disconnected"));
      this.interpreter.disconnect(conn.id);
      this.emit("event", { type: "agent.disconnected", threadId: "", data: { conn: conn.id, agentId: conn.agentId } });
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  sendToConn(connId: string, cmd: object, timeoutMs = 60000): Promise<any> {
    const conn = this.conns.get(connId);
    if (!conn) return Promise.reject(new HubError("offline", "agent process is not connected"));
    const id = ++this.nextCmd;
    conn.socket.write(JSON.stringify({ type: "cmd", id, ...cmd }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new HubError("timeout", "proxy did not reply"));
      }, timeoutMs);
      conn.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  thread(id: string): Thread {
    const t = this.interpreter.threads.get(id);
    if (!t) throw new HubError("not_found", `no thread ${id}`);
    return t;
  }

  /** Sends a command to the proxy that owns the thread's session. */
  command(threadId: string, cmd: Record<string, any>): Promise<any> {
    const t = this.thread(threadId);
    if (!t.conn) return Promise.reject(new HubError("offline", "thread's agent process is not running (open it in Zed)"));
    const conn = this.conns.get(t.conn);
    const known = conn?.commands ?? ["prompt", "config", "cancel", "permission", "rpc", "notify"];
    // Older proxies only take plain text: fold @-mention paths into the message instead.
    if (cmd.cmd === "prompt" && Array.isArray(cmd.content) && !known.includes("prompt:content")) {
      const blocks = cmd.content as any[];
      const text = blocks.map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? `@${decodeURIComponent(String(b.uri).replace(/^file:\/\//, ""))}` : "")).join(" ");
      cmd = { cmd: "prompt", text };
    }
    if (!known.includes(String(cmd.cmd))) {
      return Promise.reject(
        new HubError("outdated", "This thread's agent was started before this feature existed. Answer it in Zed this time, then restart Zed once to enable it from the app."),
      );
    }
    return this.sendToConn(t.conn, { ...cmd, sessionId: threadId });
  }

  /**
   * Loads a thread into a running agent process so it can be continued from the hub/app even when
   * Zed doesn't have it open. Zed picks the new turns up the next time it opens the thread.
   */
  async resume(threadId: string, agentId: string, cwd: string): Promise<Thread> {
    const live = this.interpreter.threads.get(threadId);
    if (live?.conn) return live;
    const conn = [...this.conns.values()].reverse().find((c) => c.agentId === agentId && (c.commands ?? []).includes("rpc"));
    if (!conn) throw new HubError("offline", `no ${agentId} process is running — open any ${agentId} thread in Zed first`);
    await this.sendToConn(conn.id, { cmd: "rpc", method: "session/load", params: { sessionId: threadId, cwd, mcpServers: [] } }, 120000);
    const t = this.interpreter.threads.get(threadId);
    if (!t) throw new HubError("agent_error", "the agent did not load the thread");
    return t;
  }

  agents(): Array<{ agentId: string; name: string; connections: number }> {
    const by = new Map<string, { agentId: string; name: string; connections: number }>();
    for (const c of this.conns.values()) {
      const a = by.get(c.agentId) ?? { agentId: c.agentId, name: c.name, connections: 0 };
      a.connections++;
      by.set(c.agentId, a);
    }
    return [...by.values()];
  }

  /** Resolves with the first thread created after now that matches pred. */
  waitForThread(pred: (t: Thread) => boolean, timeoutMs: number): Promise<Thread> {
    return new Promise((resolve, reject) => {
      const onEv = (e: any) => {
        if (e.type !== "thread.updated" && e.type !== "thread.created") return;
        const t = this.interpreter.threads.get(e.threadId);
        if (t && t.conn && pred(t)) {
          cleanup();
          resolve(t);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new HubError("timeout", "no new thread appeared in Zed"));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEv);
      };
      this.on("event", onEv);
    });
  }
}
