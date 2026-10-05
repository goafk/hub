// Project file search for @-mentions: git-aware listing + fuzzy ranking.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cache = new Map<string, { at: number; files: string[] }>();
const TTL = 30_000;
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", ".next", "target", ".expo", "Pods"]);

/** Files (relative paths) in a project: git's view when available, else a bounded walk. */
export function listFiles(cwd: string): string[] {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.files;
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    files = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || files.length > 50_000) return;
      let names: fs.Dirent[] = [];
      try {
        names = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        if (SKIP.has(d.name) || d.name.startsWith(".DS_")) continue;
        const rel = dir ? `${dir}/${d.name}` : d.name;
        if (d.isDirectory()) walk(rel, depth + 1);
        else files.push(rel);
      }
    };
    walk("", 0);
  }
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/** Folders implied by the file list (so "@src/components" works too). */
function folders(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/") + "/");
  }
  return [...out];
}

/** Subsequence score: higher is better, -1 = no match. Rewards basename hits, contiguity, word starts. */
export function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  const base = c.slice(c.replace(/\/$/, "").lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 1000 - c.length;
  if (base.includes(q)) return 800 - c.length;
  if (c.includes(q)) return 600 - c.length;
  let score = 0;
  let ci = 0;
  let run = 0;
  const baseStart = c.replace(/\/$/, "").lastIndexOf("/") + 1;
  for (const ch of q) {
    const at = c.indexOf(ch, ci);
    if (at < 0) return -1;
    run = at === ci ? run + 1 : 0;
    // Contiguous runs, word starts, and letters inside the file name count most.
    score += 10 + run * 5 + (at === 0 || "/._-".includes(c[at - 1]) ? 15 : 0) + (at >= baseStart ? 12 : 0);
    ci = at + 1;
  }
  return score - c.length * 0.1;
}

export function searchFiles(cwd: string, query: string, limit = 40): Array<{ path: string; dir: boolean }> {
  const files = listFiles(cwd);
  const all = [...folders(files).map((p) => ({ path: p, dir: true })), ...files.map((p) => ({ path: p, dir: false }))];
  if (!query) return files.slice(0, limit).map((p) => ({ path: p, dir: false }));
  return all
    .map((x) => ({ x, s: fuzzyScore(x.path, query) }))
    .filter((r) => r.s >= 0)
    .map((r) => ({ ...r, s: r.x.dir ? r.s - 50 : r.s })) // files before folders on equal matches
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.x);
}
