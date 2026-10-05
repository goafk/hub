// Read-only view of Zed's own sidebar: project groups (in the main window's order) and
// every agent thread Zed lists, whatever agent it uses.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type SidebarThread = {
  id: string; // ACP session id (same id the hub uses for synced threads)
  title: string;
  agentId: string; // Zed's agent id: registry id ("claude-acp") or custom name ("Claude Agent (synced)")
  agentName: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
};

export type SidebarProject = {
  name: string;
  path: string;
  paths: string[];
  expanded: boolean;
  threads: SidebarThread[];
};

const ms = (s?: string | null) => (s ? Date.parse(s) || 0 : 0);

export class ZedReader {
  private dbFile: string;
  private zedSupport: string;
  private names: Map<string, string> | null = null;

  constructor(zedSupport: string) {
    this.zedSupport = zedSupport;
    this.dbFile = path.join(zedSupport, "db", "0-stable", "db.sqlite");
  }

  available(): boolean {
    return fs.existsSync(this.dbFile);
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbFile, { readOnly: true });
  }

  agentName(id: string): string {
    if (!this.names) {
      this.names = new Map();
      try {
        const reg = JSON.parse(fs.readFileSync(path.join(this.zedSupport, "external_agents", "registry", "registry.json"), "utf8"));
        for (const a of reg.agents ?? []) this.names.set(a.id, a.name);
      } catch {}
    }
    return this.names.get(id) ?? id;
  }

  /** Cheap change detector for polling. */
  signature(): string {
    const db = this.open();
    try {
      const r = db.prepare("SELECT count(*) AS n, max(updated_at) AS u, max(interacted_at) AS i FROM sidebar_threads").get() as any;
      const w = db.prepare("SELECT group_concat(value) AS v FROM scoped_kv_store WHERE namespace = 'multi_workspace_state'").get() as any;
      return `${r.n}|${r.u}|${r.i}|${(w?.v ?? "").length}|${hash(w?.v ?? "")}`;
    } finally {
      db.close();
    }
  }

  sidebar(): SidebarProject[] {
    const db = this.open();
    try {
      const groups = this.projectGroups(db);
      const rows = db
        .prepare(
          `SELECT session_id, agent_id, title, title_override, updated_at, created_at, interacted_at,
                  folder_paths, main_worktree_paths
           FROM sidebar_threads WHERE archived = 0 AND session_id IS NOT NULL`,
        )
        .all() as any[];
      return groups.map((g) => {
        const key = g.paths.join("\n");
        const threads = rows
          .filter((r) => r.folder_paths === key || r.main_worktree_paths === key)
          .map((r) => ({
            id: r.session_id,
            title: r.title_override || r.title || "New Thread",
            agentId: r.agent_id ?? "",
            agentName: this.agentName(r.agent_id ?? ""),
            createdAt: ms(r.created_at),
            updatedAt: ms(r.interacted_at) || ms(r.updated_at),
            cwd: g.paths[0],
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return { ...g, threads };
      });
    } finally {
      db.close();
    }
  }

  thread(id: string): SidebarThread | undefined {
    for (const p of this.sidebar()) {
      const t = p.threads.find((x) => x.id === id);
      if (t) return t;
    }
    return undefined;
  }

  /** Project groups of the frontmost Zed window, in sidebar order. */
  private projectGroups(db: DatabaseSync): Array<Omit<SidebarProject, "threads">> {
    const states = db.prepare("SELECT key, value FROM scoped_kv_store WHERE namespace = 'multi_workspace_state'").all() as any[];
    const byWindow = new Map(states.map((s) => [String(s.key), safeJson(s.value)]));
    const stack = safeJson((db.prepare("SELECT value FROM kv_store WHERE key = 'session_window_stack'").get() as any)?.value) ?? [];
    const windows: string[] = [...stack.map(String), ...byWindow.keys()];
    const seen = new Set<string>();
    const out: Array<Omit<SidebarProject, "threads">> = [];
    for (const w of windows) {
      const groups = byWindow.get(w)?.project_groups ?? [];
      if (!groups.length) continue;
      for (const g of groups) {
        const paths: string[] = String(g.path_list?.paths ?? "").split("\n").filter(Boolean);
        const key = paths.join("\n");
        if (!paths.length || seen.has(key)) continue;
        seen.add(key);
        out.push({ name: paths.map((p) => path.basename(p)).join(", "), path: paths[0], paths, expanded: !!g.expanded });
      }
      break; // only the frontmost window with a sidebar, like Zed shows it
    }
    return out;
  }
}

function safeJson(s: any): any {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return undefined;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
