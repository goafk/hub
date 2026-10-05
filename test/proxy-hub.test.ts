import test from "node:test";
import assert from "node:assert/strict";
import { FakeZed, startHub, tmpHome, until } from "./helpers.ts";
import { Hub } from "../src/hub/hub.ts";

const isUpdate = (kind: string, text?: string) => (m: any) =>
  m.method === "session/update" && m.params.update.sessionUpdate === kind && (text === undefined || m.params.update.content?.text === text);

test("thread started in Zed appears in hub; defaults applied before Zed sees session", async () => {
  const { hub, home } = await startHub();
  // effort listed before model: model change resets effort, so order must be handled.
  const zed = new FakeZed(home.sock, { effort: "high", model: "b", mode: "auto", bogus: "x" });
  try {
    await zed.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const r = await zed.request("session/new", { cwd: "/proj", mcpServers: [] });
    const sid = r.result.sessionId;
    assert.equal(r.result.configOptions.find((o: any) => o.id === "model").currentValue, "b");
    assert.equal(r.result.configOptions.find((o: any) => o.id === "mode").currentValue, "auto");
    assert.equal(r.result.modes.currentModeId, "auto");
    assert.equal(r.result.configOptions.find((o: any) => o.id === "effort").currentValue, "high");
    // The available_commands_update the agent sent right after must arrive after the response.
    const idxResp = zed.received.findIndex((m) => m.id === r.id);
    const idxCmds = zed.received.findIndex(isUpdate("available_commands_update"));
    assert.ok(idxCmds > idxResp, "updates for the session are held until Zed knows the session");
    await until(() => hub.interpreter.threads.get(sid)?.configOptions?.[0]?.currentValue === "b");
    const t = hub.interpreter.threads.get(sid)!;
    assert.equal(t.cwd, "/proj");
    assert.equal(t.agentId, "fake");
    assert.ok(t.conn);
    assert.ok(!zed.received.some((m) => typeof m.id === "string"), "no sync-* responses leak to Zed");
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("hub prompt is echoed to Zed and the reply streams in; no response leaks", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    const ack = await hub.command(sid, { cmd: "prompt", text: "from phone" });
    assert.deepEqual(ack, { accepted: true });
    await zed.next(isUpdate("user_message_chunk", "from phone"));
    await zed.next(isUpdate("agent_message_chunk", "lo"));
    await until(() => hub.interpreter.threads.get(sid)!.status === "idle" && hub.interpreter.entries.get(sid)!.length === 2);
    assert.deepEqual(hub.interpreter.entries.get(sid)!.map((e) => [e.kind, e.text]), [["user", "from phone"], ["agent", "Hello"]]);
    assert.ok(!zed.received.some((m) => typeof m.id === "string"));
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("agent error on injected prompt is surfaced in Zed and as needs_input", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  const events: any[] = [];
  hub.on("event", (e) => events.push(e));
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    await hub.command(sid, { cmd: "prompt", text: "FAIL please" });
    const m = await zed.next((x) => isUpdate("agent_message_chunk")(x) && /⚠️ afk: model not available/.test(x.params.update.content.text));
    assert.ok(m);
    await until(() => events.some((e) => e.type === "needs_input" && e.data.stopReason === "error"));
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("injection while Zed's own prompt runs is rejected as busy", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    const pending = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "SLOW" }] });
    await until(() => hub.interpreter.threads.get(sid)!.status === "running");
    await assert.rejects(hub.command(sid, { cmd: "prompt", text: "x" }), (e: any) => e.code === "busy");
    await pending;
    await until(() => hub.interpreter.threads.get(sid)!.status === "idle");
    // Busy clears after the turn: injection works again.
    await hub.command(sid, { cmd: "prompt", text: "again" });
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("hub answers a permission request; Zed is told to cancel and its late answer is dropped", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  const events: any[] = [];
  hub.on("event", (e) => events.push(e));
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    const turn = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "PERM" }] });
    const permReq = await zed.next((m) => m.method === "session/request_permission");
    await until(() => hub.interpreter.threads.get(sid)!.status === "needs_permission");
    assert.ok(events.some((e) => e.type === "needs_input" && e.data.reason === "permission"));
    await assert.rejects(hub.command(sid, { cmd: "permission", requestId: permReq.id, optionId: "nope" }), (e: any) => e.code === "invalid");
    await hub.command(sid, { cmd: "permission", requestId: permReq.id, optionId: "allow" });
    await zed.next((m) => m.method === "$/cancel_request" && m.params.requestId === permReq.id);
    // Zed's own (late) answer must not reach the agent twice.
    zed.write({ jsonrpc: "2.0", id: permReq.id, result: { outcome: { outcome: "selected", optionId: "deny" } } });
    await zed.next(isUpdate("agent_message_chunk", "perm:allow"));
    await turn;
    await until(() => hub.interpreter.threads.get(sid)!.status === "idle");
    assert.equal(hub.interpreter.threads.get(sid)!.pendingPermissions.length, 0);
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("hub answers an agent question (elicitation); Zed's copy is cancelled", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  const events: any[] = [];
  hub.on("event", (e) => events.push(e));
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    const turn = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "ASK" }] });
    const req = await zed.next((m) => m.method === "elicitation/create");
    await until(() => hub.interpreter.threads.get(sid)!.pendingElicitations.length === 1);
    assert.ok(events.some((e) => e.type === "needs_input" && e.data.reason === "question"));
    await assert.rejects(hub.command(sid, { cmd: "elicitation", requestId: req.id, action: "bogus" }), (e: any) => e.code === "invalid");
    await hub.command(sid, { cmd: "elicitation", requestId: req.id, action: "accept", content: { question_0: "B" } });
    await zed.next((m) => m.method === "$/cancel_request" && m.params.requestId === req.id);
    zed.write({ jsonrpc: "2.0", id: req.id, result: { action: "decline" } }); // late answer from Zed is dropped
    await zed.next((m) => m.method === "session/update" && m.params.update.content?.text === 'ask:accept:{"question_0":"B"}');
    await turn;
    await until(() => hub.interpreter.threads.get(sid)!.status === "idle");
    assert.equal(hub.interpreter.threads.get(sid)!.pendingElicitations.length, 0);
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("config change from hub reaches agent and Zed's dropdown", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  try {
    const sid = await zed.open();
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    const r = await hub.command(sid, { cmd: "config", configId: "model", value: "b" });
    assert.equal(r.configOptions.find((o: any) => o.id === "model").currentValue, "b");
    const u = await zed.next(isUpdate("config_option_update"));
    assert.equal(u.params.update.configOptions.find((o: any) => o.id === "model").currentValue, "b");
    await assert.rejects(hub.command(sid, { cmd: "config", configId: "model", value: "zzz" }), (e: any) => e.code === "invalid");
    await until(() => hub.interpreter.threads.get(sid)!.configOptions!.find((o: any) => o.id === "model").currentValue === "b");
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("proxy relays with no hub running, then syncs once the hub starts; proxy exit → offline", async () => {
  const home = tmpHome();
  const zed = new FakeZed(home.sock);
  let hub: Hub | undefined;
  try {
    const sid = await zed.open();
    const p = await zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hi" }] });
    assert.equal(p.result.stopReason, "end_turn");
    hub = new Hub({ sock: home.sock, dbFile: home.db });
    await hub.start();
    await until(() => (hub!.interpreter.entries.get(sid)?.length ?? 0) === 2, 8000);
    assert.equal(hub.interpreter.threads.get(sid)!.status, "idle");
    zed.kill();
    await until(() => hub!.interpreter.threads.get(sid)!.status === "offline", 8000);
    await assert.rejects(hub.command(sid, { cmd: "prompt", text: "x" }), (e: any) => e.code === "offline");
  } finally {
    zed.kill();
    await hub?.stop();
  }
});

test("hub restart keeps history (persistence)", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock);
  let sid = "";
  try {
    sid = await zed.open();
    await zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "hi" }] });
    await until(() => hub.interpreter.entries.get(sid)?.length === 2);
  } finally {
    zed.kill();
    await hub.stop();
  }
  const hub2 = new Hub({ sock: home.sock, dbFile: home.db });
  await hub2.start();
  try {
    assert.equal(hub2.interpreter.entries.get(sid)!.length, 2);
    assert.equal(hub2.interpreter.threads.get(sid)!.status, "offline");
  } finally {
    await hub2.stop();
  }
});
