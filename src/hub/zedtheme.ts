// Reads the theme the user picked in Zed so the phone can match it.
// Zed's settings name the theme(s); extension and user themes are JSON files on disk.
// Built-in themes (One, Ayu, Gruvbox) are compiled into Zed, so for those we only
// return the name and the app falls back to its bundled copy.
import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "../setup/jsonc.ts";

export type ZedThemeColors = {
  name: string;
  appearance: "light" | "dark";
  ui: Record<string, string>;
  syntax: Record<string, string>;
};
export type ZedThemeRef = { name: string; theme?: ZedThemeColors };
export type ZedThemeInfo = { mode: "system" | "light" | "dark"; light: ZedThemeRef; dark: ZedThemeRef };

const UI_KEYS = [
  "background", "surface.background", "elevated_surface.background", "panel.background", "editor.background",
  "text", "text.muted", "text.placeholder", "text.accent", "border", "border.variant",
  "element.background", "element.hover", "element.selected", "ghost_element.hover", "ghost_element.selected",
  "created", "deleted", "warning", "error", "success", "info", "link_text.hover",
];
const SYNTAX_KEYS = [
  "keyword", "function", "string", "number", "comment", "type", "operator", "property",
  "tag", "attribute", "variable", "constant", "boolean", "punctuation",
];

/** The theme names from Zed's settings (string or {mode, light, dark}). Defaults match Zed's. */
export function themeSetting(configDir: string): { mode: ZedThemeInfo["mode"]; light: string; dark: string } {
  const fallback = { mode: "system" as const, light: "One Light", dark: "One Dark" };
  let s: any;
  try {
    s = parseJsonc(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
  } catch {
    return fallback;
  }
  const t = s?.theme;
  if (typeof t === "string") return { mode: "system", light: t, dark: t };
  if (t && typeof t === "object") {
    const mode = t.mode === "light" || t.mode === "dark" ? t.mode : "system";
    return { mode, light: typeof t.light === "string" ? t.light : fallback.light, dark: typeof t.dark === "string" ? t.dark : fallback.dark };
  }
  return fallback;
}

function themeFiles(configDir: string, supportDir: string): string[] {
  const out: string[] = [];
  const add = (dir: string) => {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) out.push(path.join(dir, f));
    } catch {}
  };
  add(path.join(configDir, "themes"));
  const ext = path.join(supportDir, "extensions", "installed");
  try {
    for (const e of fs.readdirSync(ext)) add(path.join(ext, e, "themes"));
  } catch {}
  return out;
}

const color = (v: unknown): string | undefined => (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined);

function normalize(t: any): ZedThemeColors {
  const style = t.style ?? {};
  const ui: Record<string, string> = {};
  for (const k of UI_KEYS) {
    const c = color(style[k]);
    if (c) ui[k] = c;
  }
  const syntax: Record<string, string> = {};
  for (const k of SYNTAX_KEYS) {
    const c = color(style.syntax?.[k]?.color);
    if (c) syntax[k] = c;
  }
  const cursor = color(style.players?.[0]?.cursor);
  if (cursor) ui["player.cursor"] = cursor;
  return { name: String(t.name), appearance: t.appearance === "light" ? "light" : "dark", ui, syntax };
}

/** Finds named themes among the user's and extensions' theme files. */
export function findThemes(names: string[], configDir: string, supportDir: string): Map<string, ZedThemeColors> {
  const want = new Set(names);
  const found = new Map<string, ZedThemeColors>();
  for (const f of themeFiles(configDir, supportDir)) {
    if (found.size === want.size) break;
    let j: any;
    try {
      j = parseJsonc(fs.readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    for (const t of Array.isArray(j?.themes) ? j.themes : []) {
      if (want.has(t?.name) && !found.has(t.name)) found.set(t.name, normalize(t));
    }
  }
  return found;
}

export function readZedTheme(configDir: string, supportDir: string): ZedThemeInfo {
  const s = themeSetting(configDir);
  const found = findThemes([s.light, s.dark], configDir, supportDir);
  return { mode: s.mode, light: { name: s.light, theme: found.get(s.light) }, dark: { name: s.dark, theme: found.get(s.dark) } };
}
