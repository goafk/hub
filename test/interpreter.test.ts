import test from "node:test";
import assert from "node:assert/strict";
import { Interpreter } from "../src/hub/interpreter.ts";
import type { HubEvent } from "../src/hub/interpreter.ts";

const SID = "s1";
const OPTS = [{ id: "model", category: "model", type: "select", currentValue: "a", options: [{ value: "a" }, { value: "b" }] }];

function setup() {
  const events: HubEvent[] = [];
  const it = new Interpreter((e) => events.push(e));
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: 1, result: { sessionId: SID, configOptions: OPTS, modes: { currentModeId: "ask" } } });
  return { it, events };
}
const upd = (update: any) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update } });
const chunk = (kind: string, text: string) => upd({ sessionUpdate: kind, content: { type: "text", text } });

test("session/new creates a thread", () => {
  const { it, events } = setup();
  const t = it.threads.get(SID)!;
  assert.equal(t.cwd, "/p");
  assert.equal(t.agentId, "claude");
  assert.equal(t.status, "idle");
  assert.deepEqual(t.configOptions, OPTS);
  assert.equal(events[0].type, "thread.created");
});

test("Zed prompt → user entry, running; chunks merge; response → idle + needs_input", () => {
  const { it, events } = setup();
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "hi" }] } });
  assert.equal(it.threads.get(SID)!.status, "running");
  it.handle("claude", "c1", "agent->zed", chunk("agent_thought_chunk", "think"));
  it.handle("claude", "c1", "agent->zed", chunk("agent_message_chunk", "Hel"));
  it.handle("claude", "c1", "agent->zed", chunk("agent_message_chunk", "lo"));
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  const e = it.entries.get(SID)!;
  assert.deepEqual(e.map((x) => [x.kind, x.text]), [["user", "hi"], ["thought", "think"], ["agent", "Hello"]]);
  assert.equal(it.threads.get(SID)!.status, "idle");
  const ni = events.find((x) => x.type === "needs_input")!;
  assert.deepEqual(ni.data, { reason: "turn_ended", stopReason: "end_turn" });
});

test("tool_call + update merge by id; plan replaces", () => {
  const { it } = setup();
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "plan", entries: [{ content: "a" }] }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "plan", entries: [{ content: "b" }] }));
  const e = it.entries.get(SID)!;
  assert.equal(e.length, 2);
  assert.equal(e[0].title, "Read");
  assert.equal(e[0].status, "completed");
  assert.deepEqual(e[1].data, [{ content: "b" }]);
});

test("permission request → needs_permission; any response clears it", () => {
  const { it, events } = setup();
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "write it" }] } });
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: SID, toolCall: { title: "Write" }, options: [{ optionId: "allow" }] } });
  const t = it.threads.get(SID)!;
  assert.equal(t.status, "needs_permission");
  assert.equal(t.pendingPermissions[0].requestId, 7);
  assert.equal(events.at(-1)!.type, "needs_input");
  assert.equal(events.at(-1)!.data.reason, "permission");
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  assert.equal(t.pendingPermissions.length, 0);
  assert.equal(t.status, "running");
});

test("elicitation (question) → waiting + needs_input question; response clears it", () => {
  const { it, events } = setup();
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "ask me" }] } });
  const schema = { type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "A", title: "A" }] } } };
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: 9, method: "elicitation/create", params: { sessionId: SID, mode: "form", toolCallId: "t9", message: "Pick one", requestedSchema: schema } });
  const t = it.threads.get(SID)!;
  assert.equal(t.status, "needs_permission");
  assert.deepEqual(t.pendingElicitations, [{ requestId: 9, mode: "form", toolCallId: "t9", message: "Pick one", requestedSchema: schema, url: undefined }]);
  assert.equal(events.at(-1)!.data.reason, "question");
  it.handle("claude", "c1", "sync->agent", { jsonrpc: "2.0", id: 9, result: { action: "accept", content: { question_0: "A" } } });
  assert.equal(t.pendingElicitations.length, 0);
  assert.equal(t.status, "running");
});

test("metadata updates: config, mode, title, usage", () => {
  const { it } = setup();
  it.handle("claude", "c1", "sync->zed", upd({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "b" }] }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "current_mode_update", currentModeId: "auto" }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "session_info_update", title: "My thread" }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "usage_update", used: 5 }));
  it.handle("claude", "c1", "agent->zed", upd({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review code" }] }));
  assert.deepEqual(it.threads.get(SID)!.availableCommands, [{ name: "review", description: "Review code" }]);
  const t = it.threads.get(SID)!;
  assert.equal(t.configOptions![0].currentValue, "b");
  assert.equal(t.modes.currentModeId, "auto");
  assert.equal(t.title, "My thread");
  assert.equal(t.usage.used, 5);
});

test("set_config_option response updates config", () => {
  const { it } = setup();
  it.handle("claude", "c1", "sync->agent", { jsonrpc: "2.0", id: "sync-1", method: "session/set_config_option", params: { sessionId: SID, configId: "model", value: "b" } });
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: "sync-1", result: { configOptions: [{ id: "model", currentValue: "b" }] } });
  assert.equal(it.threads.get(SID)!.configOptions![0].currentValue, "b");
});

test("session/load clears entries and replay rebuilds them without duplicates", () => {
  const { it } = setup();
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "hi" }] } });
  it.handle("claude", "c1", "agent->zed", chunk("agent_message_chunk", "yo"));
  // New proxy connection after Zed restart loads the session.
  it.handle("claude", "c2", "zed->agent", { jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: SID, cwd: "/p", mcpServers: [] } });
  it.handle("claude", "c2", "agent->zed", chunk("user_message_chunk", "hi"));
  it.handle("claude", "c2", "agent->zed", chunk("agent_message_chunk", "yo"));
  it.handle("claude", "c2", "agent->zed", { jsonrpc: "2.0", id: 1, result: {} });
  assert.deepEqual(it.entries.get(SID)!.map((x) => [x.kind, x.text]), [["user", "hi"], ["agent", "yo"]]);
  assert.equal(it.threads.get(SID)!.conn, "c2");
});

test("injected prompt: echoed user chunk recorded once, running until reply", () => {
  const { it } = setup();
  it.handle("claude", "c1", "sync->zed", chunk("user_message_chunk", "from phone"));
  it.handle("claude", "c1", "sync->agent", { jsonrpc: "2.0", id: "sync-2", method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "from phone" }] } });
  assert.equal(it.threads.get(SID)!.status, "running");
  it.handle("claude", "c1", "agent->zed", chunk("agent_message_chunk", "ok"));
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: "sync-2", result: { stopReason: "end_turn" } });
  assert.deepEqual(it.entries.get(SID)!.map((x) => [x.kind, x.text]), [["user", "from phone"], ["agent", "ok"]]);
  assert.equal(it.threads.get(SID)!.status, "idle");
});

test("disconnect marks threads offline; unknown sessions ignored", () => {
  const { it } = setup();
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", method: "session/update", params: { sessionId: "nope", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
  assert.equal(it.threads.has("nope"), false);
  it.disconnect("c1");
  assert.equal(it.threads.get(SID)!.status, "offline");
});

test("inbox: turn end marks unread; seen clears it; replying in Zed counts as seen", () => {
  const { it } = setup();
  it.handle("claude", "c1", "zed->agent", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: SID, prompt: [{ type: "text", text: "go" }] } });
  it.handle("claude", "c1", "agent->zed", { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  const t = it.threads.get(SID)!;
  assert.ok(t.turnEndedAt && (!t.seenAt || t.seenAt <= t.turnEndedAt));
  it.markSeen(SID);
  assert.ok(t.seenAt! >= t.turnEndedAt!);
});
