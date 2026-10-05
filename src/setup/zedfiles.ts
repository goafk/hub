// Edits Zed's settings.json / keymap.json by inserting marker-delimited blocks,
// leaving the rest of the user's file (comments, formatting) untouched.
import { scanSignificant } from "./jsonc.ts";

export const BEGIN = "// afk:begin";
export const END = "// afk:end";
// Blocks written before the rename (afk → afk) are still recognised and replaced.
const LEGACY_BEGIN = "// acp-sync:begin";
const LEGACY_END = "// acp-sync:end";

export function removeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.includes(BEGIN) || line.includes(LEGACY_BEGIN)) { skipping = true; continue; }
    if (skipping) { if (line.includes(END) || line.includes(LEGACY_END)) skipping = false; continue; }
    out.push(line);
  }
  return out.join("\n");
}

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split("\n").join("\n" + indent);
}

/** Index just after the `{` opening the top-level "agent_servers" object, or -1. */
function findAgentServersOpen(text: string): number {
  let depth = 0;
  let pendingKey = false;
  let afterColon = false;
  let found = -1;
  scanSignificant(text, (ch, index, str) => {
    if (found >= 0) return;
    if (afterColon) {
      afterColon = false;
      if (ch === "{" && depth === 1) { found = index + 1; return; }
    }
    if (ch === '"') { pendingKey = depth === 1 && str === "agent_servers"; return; }
    if (ch === ":" && pendingKey) { afterColon = true; pendingKey = false; return; }
    pendingKey = false;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  });
  return found;
}

function firstChar(text: string, wanted: string): number {
  let at = -1;
  scanSignificant(text, (ch, index) => { if (at < 0 && ch === wanted) at = index; });
  return at;
}

export function upsertSettingsBlock(text: string, entries: Record<string, unknown>): string {
  let doc = removeBlocks(text);
  let open = findAgentServersOpen(doc);
  if (open < 0) {
    const top = firstChar(doc, "{");
    if (top < 0) throw new Error("settings.json: no top-level object");
    doc = doc.slice(0, top + 1) + '\n  "agent_servers": {},' + doc.slice(top + 1);
    open = findAgentServersOpen(doc);
  }
  const ind = "    ";
  const body = Object.entries(entries)
    .map(([k, v]) => `${ind}${JSON.stringify(k)}: ${indentJson(v, ind)},`)
    .join("\n");
  // Always end with a newline so the end-marker comment never swallows a following `}`.
  const block = `\n${ind}${BEGIN}\n${body}\n${ind}${END}` + (/^[ \t]*\n/.test(doc.slice(open)) ? "" : "\n");
  return doc.slice(0, open) + block + doc.slice(open);
}

export function upsertKeymapBlock(text: string, bindings: Record<string, unknown>): string {
  const doc = removeBlocks(text);
  let depth = 0;
  let closeAt = -1;
  let lastSig: { ch: string; index: number } | null = null;
  let lastBeforeClose: { ch: string; index: number } | null = null;
  scanSignificant(doc, (ch, index, _str, end) => {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === "]") { closeAt = index; lastBeforeClose = lastSig; }
    }
    // For strings, record the closing-quote position so a comma lands after the string.
    lastSig = { ch, index: end ?? index };
  });
  if (closeAt < 0) throw new Error("keymap.json: no top-level array");
  const ind = "  ";
  const block = `${ind}${BEGIN}\n${ind}${indentJson({ bindings }, ind)},\n${ind}${END}\n`;
  let before = doc.slice(0, closeAt);
  const prev = lastBeforeClose as { ch: string; index: number } | null;
  if (prev && prev.ch !== "," && prev.ch !== "[") {
    before = doc.slice(0, prev.index + 1) + "," + doc.slice(prev.index + 1, closeAt);
  }
  if (!before.endsWith("\n")) before += "\n";
  return before + block + doc.slice(closeAt);
}

/** Index just after the `{` of the object at `keys` (e.g. ["agent_servers", "claude-acp"]), or -1. */
export function findObjectOpen(text: string, keys: string[]): number {
  const stack: Array<string | null> = []; // key of each open container (null for arrays/unknown)
  let pendingKey: string | null = null;
  let lastString: string | null = null;
  let found = -1;
  scanSignificant(text, (ch, index, str) => {
    if (found >= 0) return;
    if (ch === '"') {
      lastString = str ?? null;
      return;
    }
    if (ch === ":") {
      pendingKey = lastString;
      lastString = null;
      return;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? pendingKey : null);
      pendingKey = null;
      // stack[0] is the root object (key null); compare the rest with `keys`.
      if (ch === "{" && stack.length === keys.length + 1 && keys.every((k, i) => stack[i + 1] === k)) found = index + 1;
      return;
    }
    if (ch === "}" || ch === "]") stack.pop();
    pendingKey = null;
    lastString = null;
  });
  return found;
}

/** Inserts (or replaces) marker-delimited members as the first members of the object at `keys`. */
export function upsertMemberBlock(text: string, keys: string[], members: Record<string, unknown>, indent = "      "): string {
  const open = findObjectOpen(text, keys);
  if (open < 0) throw new Error(`no object at ${keys.join(".")}`);
  const body = Object.entries(members)
    .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).split("\n").join("\n" + indent)},`)
    .join("\n");
  const block = `\n${indent}${BEGIN}\n${body}\n${indent}${END}` + (/^[ \t]*\n/.test(text.slice(open)) ? "" : "\n");
  return text.slice(0, open) + block + text.slice(open);
}
