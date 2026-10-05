// Rebuilds transcripts of threads the hub did not see live, from the agents' own session logs.
// Output uses the interpreter's Entry shape so clients render both the same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "./interpreter.ts";

type Draft = Omit<Entry, "seq">;

const cache = new Map<string, { mtime: number; entries: Entry[] }>();

function finish(drafts: Draft[]): Entry[] {
  const out: Entry[] = [];
  for (const d of drafts) {
    const last = out.at(-1);
    if (last && (d.kind === "agent" || d.kind === "thought") && last.kind === d.kind) {
      last.text = `${last.text ?? ""}\n\n${d.text ?? ""}`;
      continue;
    }
    out.push({ seq: out.length + 1, ...d });
  }
  return out;
}

function cached(file: string, parse: (lines: any[]) => Draft[]): Entry[] {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.entries;
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const entries = finish(parse(lines));
  cache.set(file, { mtime, entries });
  return entries;
}

export function toolTitle(name: string, input: any): string {
  const arg = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? "";
  const s = typeof arg === "string" ? arg : JSON.stringify(arg);
  return `${name}${s ? ` ${s.length > 120 ? s.slice(0, 117) + "…" : s}` : ""}`;
}

// ---- Claude Code (~/.claude/projects/<escaped cwd>/<session>.jsonl)

const HIDDEN_USER = /^\s*<(command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification)/;

/** Slash commands are logged as XML; show them the way the user typed them. */
function userText(text: string): string | undefined {
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return args ? `${cmd[1]} ${args}` : cmd[1];
  }
  return HIDDEN_USER.test(text) ? undefined : text;
}

export function parseClaude(lines: any[]): Draft[] {
  const drafts: Draft[] = [];
  const tools = new Map<string, Draft>();
  for (const l of lines) {
    if (l.isSidechain || l.isMeta) continue;
    const content = l.message?.content;
    if (l.type === "user") {
      if (typeof content === "string") {
        const text = userText(content);
        if (text) drafts.push({ kind: "user", text });
        continue;
      }
      for (const b of content ?? []) {
        const text = b.type === "text" ? userText(b.text) : undefined;
        if (text) drafts.push({ kind: "user", text });
        if (b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          if (t) t.status = b.is_error ? "failed" : "completed";
        }
      }
    } else if (l.type === "assistant") {
      for (const b of content ?? []) {
        if (b.type === "text" && b.text?.trim()) drafts.push({ kind: "agent", text: b.text });
        else if (b.type === "thinking" && b.thinking?.trim()) drafts.push({ kind: "thought", text: b.thinking });
        else if (b.type === "tool_use") {
          const t: Draft = { kind: "tool_call", toolCallId: b.id, title: toolTitle(b.name, b.input), status: "pending", data: { name: b.name, rawInput: b.input } };
          tools.set(b.id, t);
          drafts.push(t);
        }
      }
    }
  }
  return drafts;
}

export function claudeLogFile(cwd: string, sessionId: string, home = os.homedir()): string | undefined {
  const root = path.join(home, ".claude", "projects");
  const direct = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

// ---- Codex (~/.codex/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl)

export function parseCodex(lines: any[]): Draft[] {
  const drafts: Draft[] = [];
  const tools = new Map<string, Draft>();
  for (const l of lines) {
    const p = l.payload ?? {};
    if (l.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage") {
      const text = (p.item.content ?? []).map((c: any) => c.text ?? "").join("");
      if (text.trim()) drafts.push({ kind: "user", text });
    } else if (l.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") {
        const text = (p.content ?? []).map((c: any) => c.text ?? "").join("");
        if (text.trim()) drafts.push({ kind: "agent", text });
      } else if (p.type === "reasoning") {
        const text = (p.summary ?? []).map((s: any) => s.text ?? "").join("\n");
        if (text.trim()) drafts.push({ kind: "thought", text });
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        let input: any = p.arguments ?? p.input ?? p.action;
        try {
          if (typeof input === "string") input = JSON.parse(input);
        } catch {}
        const id = p.call_id ?? p.id;
        const t: Draft = { kind: "tool_call", toolCallId: id, title: toolTitle(p.name ?? "shell", input), status: "pending", data: { name: p.name, rawInput: input } };
        tools.set(id, t);
        drafts.push(t);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const t = tools.get(p.call_id);
        if (t) t.status = "completed";
      }
    }
  }
  return drafts;
}

export function codexLogFile(sessionId: string, home = os.homedir()): string | undefined {
  const root = path.join(home, ".codex", "sessions");
  const walk = (dir: string, depth: number): string | undefined => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).sort().reverse();
    } catch {
      return undefined;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (depth === 0) {
        if (n.endsWith(`${sessionId}.jsonl`)) return p;
      } else {
        const hit = walk(p, depth - 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(root, 3);
}

/** Best-effort transcript for a thread from its agent's logs. */
export function transcriptFor(agentId: string, cwd: string, sessionId: string): { entries: Entry[]; source?: string } {
  const a = agentId.toLowerCase();
  if (a.includes("claude")) {
    const f = claudeLogFile(cwd, sessionId);
    if (f) return { entries: cached(f, parseClaude), source: f };
  }
  if (a.includes("codex")) {
    const f = codexLogFile(sessionId);
    if (f) return { entries: cached(f, parseCodex), source: f };
  }
  return { entries: [] };
}
