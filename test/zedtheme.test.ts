import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readZedTheme, themeSetting } from "../src/hub/zedtheme.ts";

const FX = path.join(import.meta.dirname, "fixtures", "zedtheme");

test("zed theme: reads settings (jsonc) and resolves extension themes; built-ins come back by name", () => {
  const info = readZedTheme(path.join(FX, "config"), path.join(FX, "support"));
  assert.equal(info.mode, "dark");
  assert.equal(info.light.name, "Cat Latte");
  assert.deepEqual(info.light.theme, {
    name: "Cat Latte",
    appearance: "light",
    ui: { background: "#d7dce5", text: "#4c4f69", "text.accent": "#8839ef", border: "#ccd0da", "element.selected": "#ccd0da4d", "player.cursor": "#dc8a78" },
    syntax: { keyword: "#8839ef", string: "#40a02b" },
  });
  assert.equal(info.dark.name, "One Dark");
  assert.equal(info.dark.theme, undefined);
});

test("zed theme: string setting, missing settings and user themes dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-zt-"));
  assert.deepEqual(themeSetting(dir), { mode: "system", light: "One Light", dark: "One Dark" });
  fs.mkdirSync(path.join(dir, "themes"));
  fs.writeFileSync(path.join(dir, "settings.json"), '{ "theme": "Mine" }');
  fs.writeFileSync(path.join(dir, "themes", "mine.json"), JSON.stringify({ themes: [{ name: "Mine", appearance: "dark", style: { text: "#ffffff" } }] }));
  const info = readZedTheme(dir, path.join(dir, "nope"));
  assert.equal(info.light.theme?.ui.text, "#ffffff");
  assert.equal(info.dark.theme?.appearance, "dark");
});
