// Phone extras built on the hub's in-memory threads: live progress for running threads,
// full-text search across transcripts, and a cost ledger for "usage at a glance".
import fs from "node:fs";
import path from "node:path";
import type { Entry, Thread } from "./interpreter.ts";
import type { Progress } from "./notify.ts";

// ---- live progress ----

/** One line describing what a running thread is doing: plan step, else the tool being run. */
export function progressOf(t: Thread, entries: Entry[], title: string): Progress {
  const project = path.basename(t.cwd ?? "") || "project";
  const running = t.status === "running" || t.status === "needs_permission";
  const plan = [...entries].reverse().find((e) => e.kind === "plan") as any;
  const items: Array<{ content?: string; status?: string }> = Array.isArray(plan?.data) ? plan.data : [];
  const done = items.filter((x) => x.status === "completed").length;
  const current = items.find((x) => x.status === "in_progress")?.content;
  const tool = [...entries].reverse().find((e) => e.kind === "tool_call");
  const toolTitle = tool && tool.status !== "completed" && tool.status !== "failed" ? tool.title : undefined;
  const step =
    t.status === "needs_permission"
      ? "Waiting for you"
      : current ?? toolTitle ?? (items.length && done === items.length ? "Wrapping up" : "Working…");
  return { threadId: t.id, title, project, running, step: step.slice(0, 120), ...(items.length ? { done, total: items.length } : {}) };
}

/**
 * Decides when a thread's progress is worth a push: always when it starts or stops running,
 * otherwise only when the line changed and at most once every `minGapMs`.
 */
export class ProgressThrottle {
  private last = new Map<string, { sig: string; at: number; running: boolean }>();
  private minGapMs: number;
  constructor(minGapMs = 20_000) {
    this.minGapMs = minGapMs;
  }

  shouldSend(p: Progress, now = Date.now()): boolean {
    const prev = this.last.get(p.threadId);
    const sig = `${p.running}|${p.step}|${p.done}/${p.total}`;
    if (!prev && !p.running) return false; // never announced: nothing to clear
    if (prev && prev.sig === sig) return false;
    const edge = !prev || prev.running !== p.running;
    if (!edge && now - prev!.at < this.minGapMs) return false;
    if (p.running) this.last.set(p.threadId, { sig, at: now, running: true });
    else this.last.delete(p.threadId);
    return true;
  }
}

// ---- search ----

export type SearchHit = { threadId: string; kind: Entry["kind"]; seq: number; snippet: string };

/** Case-insensitive substring search over message text, newest threads first, one hit per entry. */
export function searchEntries(entries: Map<string, Entry[]>, order: string[], q: string, limit = 40): SearchHit[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const out: SearchHit[] = [];
  for (const id of order) {
    const list = entries.get(id) ?? [];
    let perThread = 0;
    for (let i = list.length - 1; i >= 0 && perThread < 3; i--) {
      const e = list[i];
      if (e.kind !== "user" && e.kind !== "agent") continue;
      const text = e.text ?? "";
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      out.push({ threadId: id, kind: e.kind, seq: e.seq, snippet: snippet(text, at, needle.length) });
      perThread++;
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function snippet(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + len + 90);
  return (start ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

// ---- usage ----

type Ledger = { days: Record<string, Record<string, number>>; last: Record<string, number>; currency?: string };

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Agents report a running cost per thread. The ledger books each increase to the day it
 * happened, so the app can show today, the last 7 days, and the most expensive threads.
 */
export class UsageLedger {
  private data: Ledger;
  private dirty = false;
  private file: string;
  constructor(file: string) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = { days: {}, last: {} };
    }
  }

  /** Seeds a thread's known cost without booking it (threads already running before the ledger existed). */
  seed(threadId: string, amount: number): void {
    if (this.data.last[threadId] === undefined) {
      this.data.last[threadId] = amount;
      this.dirty = true;
    }
  }

  observe(threadId: string, cost: { amount?: number; currency?: string } | undefined, now = Date.now()): void {
    const amount = Number(cost?.amount);
    if (!Number.isFinite(amount)) return;
    const prev = this.data.last[threadId];
    this.data.last[threadId] = amount;
    if (cost?.currency) this.data.currency = cost.currency;
    this.dirty = true;
    // A lower number means the agent restarted its count (new session): book it from zero.
    const delta = prev === undefined ? 0 : amount >= prev ? amount - prev : amount;
    if (delta <= 0) return;
    const day = (this.data.days[dayKey(now)] ??= {});
    day[threadId] = (day[threadId] ?? 0) + delta;
  }

  summary(now = Date.now()): { currency: string; today: number; days: Array<{ day: string; cost: number }>; byThread: Record<string, number> } {
    const days: Array<{ day: string; cost: number }> = [];
    const byThread: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(now - i * 86_400_000);
      const d = this.data.days[key] ?? {};
      days.push({ day: key, cost: round(Object.values(d).reduce((a, b) => a + b, 0)) });
      for (const [id, c] of Object.entries(d)) byThread[id] = round((byThread[id] ?? 0) + c);
    }
    return { currency: this.data.currency ?? "USD", today: days[6].cost, days, byThread };
  }

  flush(): void {
    if (!this.dirty) return;
    // Keep 60 days of history.
    const keep = new Set(Array.from({ length: 60 }, (_, i) => dayKey(Date.now() - i * 86_400_000)));
    for (const k of Object.keys(this.data.days)) if (!keep.has(k)) delete this.data.days[k];
    fs.writeFileSync(this.file, JSON.stringify(this.data));
    this.dirty = false;
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000;
