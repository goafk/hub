import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAgents, resolveRegistryCommand } from "../src/setup/discover.ts";

function fakeZedSupport(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acps-zed-"));
  const reg = path.join(root, "external_agents", "registry");
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, "registry.json"), JSON.stringify({
    version: "1",
    agents: [
      { id: "claude-acp", name: "Claude Agent", distribution: { npx: { package: "@scope/claude-agent-acp@1.2.3" } } },
      { id: "codex-acp", name: "Codex", distribution: { binary: { "darwin-aarch64": { cmd: "./codex-acp", args: ["--x"] } } } },
      { id: "not-installed", name: "Nope", distribution: { npx: { package: "nope@1" } } },
    ],
  }));
  const pkg = path.join(reg, "npx", "claude-acp", "node_modules", "@scope", "claude-agent-acp");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@scope/claude-agent-acp", bin: { "claude-agent-acp": "dist/index.js" } }));
  fs.writeFileSync(path.join(pkg, "dist", "index.js"), "");
  for (const v of ["v_1.0.0_a", "v_2.0.0_b"]) {
    fs.mkdirSync(path.join(reg, "codex-acp", v), { recursive: true });
    fs.writeFileSync(path.join(reg, "codex-acp", v, "codex-acp"), "");
  }
  fs.utimesSync(path.join(reg, "codex-acp", "v_1.0.0_a"), new Date(1000), new Date(1000));
  return root;
}

const SETTINGS = `{
  "agent_servers": {
    "claude-acp": { "type": "registry", "default_config_options": { "model": "opus", "mode": "bypassPermissions", }, },
    "codex-acp": { "type": "registry" },
    "Poolside": { "type": "custom", "command": "pool", "args": ["acp"], "env": { "A": "1" } },
    "Claude Agent (synced)": { "type": "custom", "command": "node" },
  },
}`;

test("resolves npx and binary registry commands", () => {
  const z = fakeZedSupport();
  const c = resolveRegistryCommand(z, "claude-acp", "/usr/bin/node");
  assert.equal(c.command, "/usr/bin/node");
  assert.match(c.args[0], /claude-agent-acp\/dist\/index\.js$/);
  const x = resolveRegistryCommand(z, "codex-acp", "/usr/bin/node");
  assert.match(x.command, /v_2\.0\.0_b\/codex-acp$/);
  assert.deepEqual(x.args, ["--x"]);
  assert.throws(() => resolveRegistryCommand(z, "not-installed", "/usr/bin/node"), /not installed/);
});

test("discovers installed registry + custom agents with defaults, skipping synced entries", () => {
  const z = fakeZedSupport();
  const agents = discoverAgents({ settingsText: SETTINGS, zedSupport: z });
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(byId).sort(), ["Poolside", "claude-acp", "codex-acp"]);
  assert.equal(byId["claude-acp"].name, "Claude Agent");
  assert.deepEqual(byId["claude-acp"].defaults, { model: "opus", mode: "bypassPermissions" });
  assert.equal(byId["claude-acp"].source, "registry");
  assert.equal(byId["Poolside"].source, "custom");
  assert.equal(byId["Poolside"].command, "pool");
  assert.deepEqual(byId["Poolside"].env, { A: "1" });
});
