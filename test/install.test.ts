import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../src/setup/jsonc.ts";
import { install, uninstall } from "../src/setup/install.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acps-inst-"));
  process.env.ACP_SYNC_HOME = path.join(root, "home");
  const zedConfig = path.join(root, "zedconfig");
  const zedSupport = path.join(root, "zedsupport");
  const reg = path.join(zedSupport, "external_agents", "registry");
  fs.mkdirSync(zedConfig, { recursive: true });
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, "registry.json"), JSON.stringify({ agents: [{ id: "claude-acp", name: "Claude Agent", distribution: { npx: { package: "cl@1" } } }] }));
  const pkg = path.join(reg, "npx", "claude-acp", "node_modules", "cl");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: "index.js" }));
  const settings = `{
  // mine
  "agent_servers": {
    "claude-acp": { "type": "registry", "default_config_options": { "model": "opus" } },
    "Poolside": { "type": "custom", "command": "pool", "args": ["acp"] },
  },
}`;
  fs.writeFileSync(path.join(zedConfig, "settings.json"), settings);
  fs.writeFileSync(path.join(zedConfig, "keymap.json"), "[]");
  return { root, zedConfig, zedSupport, settings };
}

test("install writes synced entries, bindings, config; idempotent; uninstall reverts", () => {
  const f = fixture();
  const opts = { zedConfig: f.zedConfig, zedSupport: f.zedSupport, nodePath: "/n/node", cliEntry: "/x/cli.ts", launchd: false, inProcess: false };
  const r = install(opts);
  assert.deepEqual(r.agents.map((a) => a.id).sort(), ["Poolside", "claude-acp"]);
  install(opts); // twice

  const s = parseJsonc(fs.readFileSync(path.join(f.zedConfig, "settings.json"), "utf8"));
  const claude = s.agent_servers["Claude Agent (synced)"];
  assert.equal(claude.type, "custom");
  assert.equal(claude.command, "/n/node");
  assert.deepEqual(claude.args, ["--no-warnings", "/x/cli.ts", "proxy", "--agent", "claude-acp", "--name", "Claude Agent", "--defaults", '{"model":"opus"}', "--registry", "claude-acp"]);
  const pool = s.agent_servers["Poolside (synced)"];
  assert.deepEqual(pool.args.slice(-3), ["--", "pool", "acp"]);
  assert.equal(s.agent_servers["claude-acp"].type, "registry");

  const k = parseJsonc(fs.readFileSync(path.join(f.zedConfig, "keymap.json"), "utf8"));
  assert.equal(k.length, 1);
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.ACP_SYNC_HOME!, "config.json"), "utf8"));
  const keys = cfg.bindings["claude-acp"].keys;
  assert.match(keys, /^ctrl-alt-cmd-z [a-y]$/);
  assert.deepEqual(k[0].bindings[keys], ["agent::NewExternalAgentThread", { agent: "Claude Agent (synced)" }]);
  assert.notEqual(cfg.bindings["Poolside"].keys, keys);
  assert.ok(fs.readdirSync(path.join(process.env.ACP_SYNC_HOME!, "backups")).length >= 2);

  // Keys stay stable on re-run.
  install(opts);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(process.env.ACP_SYNC_HOME!, "config.json"), "utf8"));
  assert.equal(cfg2.bindings["claude-acp"].keys, keys);

  uninstall({ zedConfig: f.zedConfig, launchd: false });
  assert.deepEqual(parseJsonc(fs.readFileSync(path.join(f.zedConfig, "settings.json"), "utf8")), parseJsonc(f.settings));
  assert.deepEqual(parseJsonc(fs.readFileSync(path.join(f.zedConfig, "keymap.json"), "utf8")), []);
});

test("in-process: registry Node agents get the preload env inside their own entry", () => {
  const f = fixture();
  const opts = { zedConfig: f.zedConfig, zedSupport: f.zedSupport, nodePath: "/n/node", cliEntry: "/x/cli.ts", launchd: false, preload: "/h/preload.mjs" };
  install(opts);
  install(opts); // idempotent
  const text = fs.readFileSync(path.join(f.zedConfig, "settings.json"), "utf8");
  const s = parseJsonc(text);
  assert.deepEqual(s.agent_servers["claude-acp"].env, { NODE_OPTIONS: "--import=/h/preload.mjs", AFK_AGENT: "claude-acp", AFK_NAME: "Claude Agent" });
  assert.equal(s.agent_servers["claude-acp"].type, "registry");
  assert.deepEqual(s.agent_servers["claude-acp"].default_config_options, { model: "opus" });
  assert.equal(s.agent_servers["Claude Agent (synced)"], undefined);
  assert.ok(s.agent_servers["Poolside (synced)"], "custom agents still use a synced entry");
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.ACP_SYNC_HOME!, "config.json"), "utf8"));
  assert.equal(cfg.bindings["claude-acp"].zedName, "claude-acp");
  uninstall({ zedConfig: f.zedConfig, launchd: false });
  assert.deepEqual(parseJsonc(fs.readFileSync(path.join(f.zedConfig, "settings.json"), "utf8")), parseJsonc(f.settings));
});

test("install --only filters agents", () => {
  const f = fixture();
  const r = install({ zedConfig: f.zedConfig, zedSupport: f.zedSupport, nodePath: "/n", cliEntry: "/c", launchd: false, only: ["claude-acp"], preload: "/p.mjs" });
  assert.deepEqual(r.agents.map((a) => a.id), ["claude-acp"]);
});
