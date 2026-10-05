// Builds the widgets' data from the hub (used by the background task and the running app).
import type { Project } from "../lib/api";
import { loadConn, makeApi } from "../lib/api";
import { age } from "../lib/time";
import type { WidgetData, WidgetItem } from "./AgentsWidget";

export function widgetDataFrom(projects: Project[]): WidgetData {
  const items: Array<WidgetItem & { at: number }> = [];
  let needs = 0;
  let running = 0;
  const now = Date.now();
  for (const p of projects) {
    for (const t of p.threads) {
      if (t.archived) continue;
      const base = { id: t.id, title: t.title, project: p.name, ago: age(t.updatedAt, now), at: t.updatedAt };
      if (t.status === "needs_permission") {
        needs++;
        items.push({ ...base, state: "input" });
      } else if (t.status === "running") {
        running++;
        items.push({ ...base, state: "running" });
      } else if (t.unread) {
        needs++;
        items.push({ ...base, state: "done" });
      }
    }
  }
  const rank = { input: 0, done: 1, running: 2 } as const;
  items.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  // Recent projects for Quick start: most recently active first.
  const recent = projects
    .map((p) => ({ name: p.name, path: p.path, at: Math.max(0, ...p.threads.map((t) => t.updatedAt)) }))
    .sort((a, b) => b.at - a.at)
    .map(({ name, path }) => ({ name, path }));
  return { needs, running, items: items.map(({ at: _at, ...it }) => it), projects: recent, updatedAt: now };
}

export async function fetchWidgetData(): Promise<WidgetData> {
  const empty = { needs: 0, running: 0, items: [], projects: [], updatedAt: Date.now() };
  try {
    const conn = await loadConn();
    if (!conn.url) return { ...empty, error: "Open the app to connect" };
    const { projects } = await makeApi(conn).sidebar();
    return widgetDataFrom(projects);
  } catch {
    return { ...empty, error: "Can't reach your Mac" };
  }
}
