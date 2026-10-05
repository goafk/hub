// Client for the AFK hub HTTP API.
import { Platform } from "react-native";
import { activeConn } from "./hosts";

export type ConfigOption = {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue: string | boolean;
  options?: Array<{ value: string; name?: string; description?: string } | { group?: string; name?: string; options: Array<{ value: string; name?: string; description?: string }> }>;
};

export type Entry = {
  seq: number;
  kind: "user" | "agent" | "thought" | "tool_call" | "plan";
  text?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  data?: any;
};

export type PendingPermission = { requestId: string | number; toolCall?: any; options: Array<{ optionId: string; name: string; kind?: string }> };

export type PendingElicitation = { requestId: string | number; mode: string; toolCallId?: string; message: string; requestedSchema?: any; url?: string };

export type QueuedMessage = { id: string; text: string; images: number; createdAt: number };

export type ThreadStatus = "idle" | "running" | "needs_permission" | "offline" | "unsynced";

export type SidebarThread = {
  unread?: boolean;
  preview?: string;
  archived?: boolean;
  autoApprove?: boolean;
  /** Zed's own title when renamed in the app. */
  zedTitle?: string;
  id: string;
  title: string;
  agentId: string;
  agentName: string;
  kind: string;
  synced: boolean;
  status: ThreadStatus;
  online: boolean;
  createdAt: number;
  updatedAt: number;
  cwd: string;
};

export type Project = { name: string; path: string; paths: string[]; expanded: boolean; threads: SidebarThread[] };

export type ThreadDetail = SidebarThread & {
  entries: Entry[];
  configOptions?: ConfigOption[];
  modes?: any;
  pendingPermissions?: PendingPermission[];
  pendingElicitations?: PendingElicitation[];
  usage?: { used?: number; size?: number; cost?: { amount: number; currency: string } };
  availableCommands?: Array<{ name: string; description?: string; input?: { hint?: string } | null }>;
  queued?: QueuedMessage[];
};

export type FileChange = { path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked"; added: number; removed: number; staged: boolean };
export type GitStatus = { branch: string; ahead: number; behind: number; upstream: boolean; files: FileChange[] };

export type Agent = { agentId: string; name: string; zedName: string; keys: string; connections: number };

export type Conn = { url: string; token: string };


export function defaultConn(): Conn {
  if (Platform.OS === "web" && typeof location !== "undefined") {
    return { url: `http://${location.hostname || "127.0.0.1"}:47321`, token: "" };
  }
  return { url: "", token: "" };
}

/** The active Mac's connection (see hosts.ts). */
export async function loadConn(): Promise<Conn> {
  const c = await activeConn();
  return c.url ? c : defaultConn();
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function makeApi(conn: Conn) {
  const base = conn.url.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (conn.token) headers.authorization = `Bearer ${conn.token}`;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e: any) {
      throw new ApiError(0, "network", `Can't reach the hub at ${base || "(not set)"}`);
    }
    const json: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, json.error?.code ?? "error", json.error?.message ?? `HTTP ${r.status}`);
    return json as T;
  }
  return {
    base,
    token: conn.token,
    sidebar: () => call<{ projects: Project[] }>("GET", "/zed/sidebar"),
    gitStatus: (cwd: string) => call<GitStatus>("GET", `/git/status?cwd=${encodeURIComponent(cwd)}`),
    gitDiff: (cwd: string, file: string) => call<{ diff: string }>("GET", `/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`),
    gitCommit: (cwd: string, message: string, files?: string[]) => call<{ hash: string }>("POST", "/git/commit", { cwd, message, files }),
    gitDiscard: (cwd: string, files: string[]) => call("POST", "/git/discard", { cwd, files }),
    gitPush: (cwd: string) => call<{ output: string }>("POST", "/git/push", { cwd }),
    seen: (id: string) => call("POST", `/threads/${encodeURIComponent(id)}/seen`),
    setMeta: (id: string, patch: { title?: string; archived?: boolean; autoApprove?: boolean }) => call("POST", `/zed/threads/${encodeURIComponent(id)}/meta`, patch),
    resume: (id: string) => call("POST", `/zed/threads/${encodeURIComponent(id)}/resume`),
    thread: (id: string) => call<ThreadDetail>("GET", `/zed/threads/${encodeURIComponent(id)}`),
    agents: () => call<Agent[]>("GET", "/agents"),
    prompt: (id: string, text: string, mentions: string[] = [], images: Array<{ mimeType: string; data: string }> = []) =>
      call<{ queued?: QueuedMessage }>("POST", `/threads/${id}/prompt`, { text, mentions, images }),
    queue: (id: string, action: "remove" | "edit" | "send_now" | "clear", qid?: string, text?: string) =>
      call<{ queued: QueuedMessage[] }>("POST", `/threads/${id}/queue`, { action, id: qid, text }),
    files: (cwd: string, q: string) => call<{ files: Array<{ path: string; dir: boolean }> }>("GET", `/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`),
    config: (id: string, configId: string, value: string) => call<{ configOptions?: ConfigOption[] }>("POST", `/threads/${id}/config`, { configId, value }),
    cancel: (id: string) => call("POST", `/threads/${id}/cancel`),
    permission: (id: string, requestId: string | number, optionId: string) => call("POST", `/threads/${id}/permission`, { requestId, optionId }),
    answer: (id: string, requestId: string | number, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) =>
      call("POST", `/threads/${id}/elicitation`, { requestId, action, content }),
    registerDevice: (d: { token: string; platform: string; name?: string; prefs?: { finished?: boolean; input?: boolean }; showHub?: boolean }) => call("POST", "/devices", d),
    info: () => call<{ id: string; name: string; version: string }>("GET", "/info"),
    newThread: (cwd: string, agentId: string, prompt?: string) => call<SidebarThread>("POST", "/threads", { cwd, agentId, prompt }),
  };
}

export type Api = ReturnType<typeof makeApi>;
