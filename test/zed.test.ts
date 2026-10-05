import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZedReader } from "../src/hub/zed.ts";
import { parseClaude, parseCodex } from "../src/hub/transcripts.ts";

function fakeZed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acps-zeddb-"));
  fs.mkdirSync(path.join(root, "db", "0-stable"), { recursive: true });
  fs.mkdirSync(path.join(root, "external_agents", "registry"), { recursive: true });
  fs.writeFileSync(path.join(root, "external_agents", "registry", "registry.json"), JSON.stringify({ agents: [{ id: "claude-acp", name: "Claude Agent" }] }));
  const db = new DatabaseSync(path.join(root, "db", "0-stable", "db.sqlite"));
  db.exec(`
    CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scoped_kv_store (namespace TEXT, key TEXT, value TEXT);
    CREATE TABLE sidebar_threads (thread_id BLOB, session_id TEXT, agent_id TEXT, title TEXT, updated_at TEXT, created_at TEXT,
      folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0, main_worktree_paths TEXT, main_worktree_paths_order TEXT,
      remote_connection TEXT, interacted_at TEXT, title_override TEXT);
  `);
  db.prepare("INSERT INTO kv_store VALUES ('session_window_stack', '[2,1]')").run();
  const groups = (ps: string[]) => JSON.stringify({ project_groups: ps.map((p, i) => ({ path_list: { paths: p, order: "0" }, expanded: i === 0 })) });
  db.prepare("INSERT INTO scoped_kv_store VALUES ('multi_workspace_state', '1', ?)").run(groups(["/other"]));
  db.prepare("INSERT INTO scoped_kv_store VALUES ('multi_workspace_state', '2', ?)").run(groups(["/w/aurora-ui", "/w/pocket-ledger", "/w/empty"]));
  const ins = db.prepare("INSERT INTO sidebar_threads (session_id, agent_id, title, updated_at, created_at, folder_paths, interacted_at, archived, title_override) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("a", "claude-acp", "Older", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "/w/aurora-ui", "2026-10-01T00:00:00Z", 0, null);
  ins.run("b", "claude-acp", "Newer", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "/w/aurora-ui", "2026-10-02T00:00:00Z", 0, "Renamed");
  ins.run("c", "Codex (synced)", "Mail", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z", "/w/pocket-ledger", null, 0, null);
  ins.run("d", "claude-acp", "Archived", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z", "/w/pocket-ledger", null, 1, null);
  db.close();
  return root;
}

test("sidebar: frontmost window's groups in order, threads by recency, archived hidden", () => {
  const z = new ZedReader(fakeZed());
  const s = z.sidebar();
  assert.deepEqual(s.map((p) => p.name), ["aurora-ui", "pocket-ledger", "empty"]);
  assert.equal(s[0].expanded, true);
  assert.deepEqual(s[0].threads.map((t) => t.title), ["Renamed", "Older"]);
  assert.equal(s[0].threads[0].agentName, "Claude Agent");
  assert.deepEqual(s[1].threads.map((t) => t.id), ["c"]);
  assert.equal(s[2].threads.length, 0);
  assert.equal(z.thread("c")!.cwd, "/w/pocket-ledger");
  assert.match(z.signature(), /^4\|/);
});

test("parseClaude: user/agent/thought/tools, hides meta and command noise", () => {
  const d = parseClaude([
    { type: "user", message: { content: "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship it</command-args>" } },
    { type: "user", message: { content: "<local-command-stdout>Goal set</local-command-stdout>" } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "user", message: { content: "fix the bug" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  ]);
  assert.deepEqual(d.map((x) => [x.kind, x.text ?? x.title, x.status]), [
    ["user", "/goal ship it", undefined],
    ["user", "fix the bug", undefined],
    ["thought", "hmm", undefined],
    ["agent", "Looking.", undefined],
    ["tool_call", "Read /a.ts", "completed"],
    ["agent", "Done.", undefined],
  ]);
});

test("parseCodex: user, assistant, tool calls", () => {
  const d = parseCodex([
    { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "hi" }] } } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "sys" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":"ls"}' } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "x" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
  ]);
  assert.deepEqual(d.map((x) => [x.kind, x.text ?? x.title, x.status]), [
    ["user", "hi", undefined],
    ["tool_call", "shell ls", "completed"],
    ["agent", "ok", undefined],
  ]);
});
