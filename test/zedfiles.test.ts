import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../src/setup/jsonc.ts";
import { upsertSettingsBlock, upsertKeymapBlock, removeBlocks } from "../src/setup/zedfiles.ts";

const SETTINGS = `// Zed settings
{
  "context_servers": { "x": { "url": "https://a.b//c" } },
  "agent_servers": {
    "claude-acp": {
      "type": "registry",
    },
  },
  "theme": "One Dark",
}
`;

const ENTRIES = { "Claude Agent (synced)": { type: "custom", command: "node", args: ["a"] } };

test("settings block inserted into agent_servers and parses", () => {
  const out = upsertSettingsBlock(SETTINGS, ENTRIES);
  const parsed = parseJsonc(out);
  assert.equal(parsed.agent_servers["claude-acp"].type, "registry");
  assert.deepEqual(parsed.agent_servers["Claude Agent (synced)"], ENTRIES["Claude Agent (synced)"]);
  assert.equal(parsed.theme, "One Dark");
});

test("settings upsert is idempotent and replaces the block", () => {
  const once = upsertSettingsBlock(SETTINGS, ENTRIES);
  const twice = upsertSettingsBlock(once, { "Codex (synced)": { type: "custom", command: "x" } });
  assert.equal(twice.split("afk:begin").length, 2);
  const parsed = parseJsonc(twice);
  assert.equal(parsed.agent_servers["Claude Agent (synced)"], undefined);
  assert.equal(parsed.agent_servers["Codex (synced)"].command, "x");
});

test("settings block created when agent_servers is missing", () => {
  const out = upsertSettingsBlock('{\n  "theme": "x"\n}\n', ENTRIES);
  const parsed = parseJsonc(out);
  assert.equal(parsed.theme, "x");
  assert.equal(parsed.agent_servers["Claude Agent (synced)"].command, "node");
});

test("settings block works with empty agent_servers object", () => {
  const out = upsertSettingsBlock('{ "agent_servers": {} }', ENTRIES);
  assert.equal(parseJsonc(out).agent_servers["Claude Agent (synced)"].command, "node");
});

test("removeBlocks restores an equivalent document", () => {
  const out = removeBlocks(upsertSettingsBlock(SETTINGS, ENTRIES));
  assert.deepEqual(parseJsonc(out), parseJsonc(SETTINGS));
  const out2 = removeBlocks(upsertSettingsBlock('{\n  "theme": "x"\n}\n', ENTRIES));
  assert.deepEqual(parseJsonc(out2).theme, "x");
});

const KEYMAP = `[
  {
    "bindings": { "cmd-b": "workspace::ToggleRightDock" },
  },
]
`;

test("keymap block appended, idempotent, removable", () => {
  const bindings = { "ctrl-alt-cmd-z a": ["agent::NewExternalAgentThread", { agent: "Claude Agent (synced)" }] };
  const once = upsertKeymapBlock(KEYMAP, bindings);
  const twice = upsertKeymapBlock(once, bindings);
  assert.equal(twice.split("afk:begin").length, 2);
  const parsed = parseJsonc(twice);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1].bindings, bindings);
  assert.deepEqual(parseJsonc(removeBlocks(twice)), parseJsonc(KEYMAP));
  assert.equal(parseJsonc(upsertKeymapBlock("[]", bindings)).length, 1);
});

test("member block inside a nested object; parses; removable", async () => {
  const { upsertMemberBlock, findObjectOpen } = await import("../src/setup/zedfiles.ts");
  assert.ok(findObjectOpen(SETTINGS, ["agent_servers", "claude-acp"]) > 0);
  assert.equal(findObjectOpen(SETTINGS, ["agent_servers", "nope"]), -1);
  const out = upsertMemberBlock(SETTINGS, ["agent_servers", "claude-acp"], { env: { A: "1" } });
  const parsed = parseJsonc(out);
  assert.deepEqual(parsed.agent_servers["claude-acp"], { env: { A: "1" }, type: "registry" });
  assert.deepEqual(parseJsonc(removeBlocks(out)), parseJsonc(SETTINGS));
});

test("blocks written under the old name (acp-sync) are replaced, not duplicated", () => {
  const old = '{\n  // acp-sync:begin\n  "agent_servers": {},\n  // acp-sync:end\n  "theme": "One Dark"\n}\n';
  const cleaned = removeBlocks(old);
  assert.ok(!cleaned.includes("acp-sync"));
  assert.ok(cleaned.includes('"theme"'));
});
