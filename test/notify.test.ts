import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notifier } from "../src/hub/notify.ts";

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acps-notify-")), "devices.json");
  const sent: any[] = [];
  let reply: any = (msgs: any[]) => ({ data: msgs.map(() => ({ status: "ok" })) });
  const n = new Notifier(file, async (_url, body) => {
    const msgs = JSON.parse(body);
    sent.push(...msgs);
    return reply(msgs);
  });
  const thread = { id: "s1", title: "Fix login", cwd: "/w/aurora-ui", agentId: "claude-acp" };
  const lastAgent = "All done, tests pass.";
  return { n, sent, file, thread, lastAgent, setReply: (r: any) => (reply = r) };
}

test("registers devices (deduped, persisted) and respects prefs", async () => {
  const { n, sent, file, thread } = setup();
  n.register({ token: "ExponentPushToken[a]", platform: "android", name: "Pixel" });
  n.register({ token: "ExponentPushToken[a]", platform: "android", name: "Pixel", prefs: { finished: false } });
  assert.equal(n.list().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "turn_ended", stopReason: "end_turn" } }, thread, "x");
  assert.equal(sent.length, 0, "finished disabled for this device");
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "question", message: "Pick a focus" } }, thread, "x");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ExponentPushToken[a]");
  assert.match(sent[0].title, /aurora-ui · Fix login/);
  assert.match(sent[0].body, /Pick a focus/);
  assert.deepEqual(sent[0].data, { threadId: "s1", hubId: "", url: "zedthreads://thread/s1" });
});

test("phones paired with several Macs see which Mac a notification is from", async () => {
  const { n, sent, thread } = setup();
  n.hub = () => ({ id: "h1", name: "Work MBP" });
  n.register({ token: "ExponentPushToken[m]", platform: "android", showHub: true });
  n.register({ token: "ExponentPushToken[s]", platform: "android" });
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "question", message: "Pick" } }, thread, "x");
  const multi = sent.find((m) => m.to === "ExponentPushToken[m]");
  const single = sent.find((m) => m.to === "ExponentPushToken[s]");
  assert.match(multi.title, /^Work MBP · /);
  assert.doesNotMatch(single.title, /Work MBP/);
  assert.equal(multi.data.hubId, "h1");
});

test("messages per reason; cancelled turns are quiet", async () => {
  const { n, sent, thread, lastAgent } = setup();
  n.register({ token: "ExponentPushToken[b]", platform: "ios" });
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "turn_ended", stopReason: "end_turn" } }, thread, lastAgent);
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "turn_ended", stopReason: "error", error: "model not available" } }, thread, lastAgent);
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "permission", toolCall: { title: "Write a.ts" } } }, thread, lastAgent);
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "turn_ended", stopReason: "cancelled" } }, thread, lastAgent);
  assert.deepEqual(sent.map((m) => m.body), ["All done, tests pass.", "⚠️ model not available", "Permission needed: Write a.ts"]);
});

test("drops tokens Expo reports as unregistered; unregister works", async () => {
  const { n, thread, setReply } = setup();
  n.register({ token: "ExponentPushToken[dead]", platform: "android" });
  n.register({ token: "ExponentPushToken[live]", platform: "android" });
  setReply((msgs: any[]) => ({ data: msgs.map((m: any) => (m.to.includes("dead") ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" })) }));
  await n.notify({ type: "needs_input", threadId: "s1", data: { reason: "question" } }, thread, "");
  assert.deepEqual(n.list().map((d) => d.token), ["ExponentPushToken[live]"]);
  n.unregister("ExponentPushToken[live]");
  assert.equal(n.list().length, 0);
  assert.throws(() => n.register({ token: "nope", platform: "android" }), /Expo push token/);
});

test("notify: test push goes only to a registered phone and reports Expo errors", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "afk-n-")), "devices.json");
  const sent: any[] = [];
  let reply: any = { data: [{ status: "ok" }] };
  const n = new Notifier(file, async (_url, body) => {
    sent.push(...JSON.parse(body));
    return reply;
  });
  n.hub = () => ({ id: "h1", name: "Studio" });
  assert.equal((await n.test("ExponentPushToken[nope]")).ok, false);
  assert.equal(sent.length, 0);
  n.register({ token: "ExponentPushToken[abc]", platform: "android" });
  assert.deepEqual(await n.test("ExponentPushToken[abc]"), { ok: true });
  assert.equal(sent[0].to, "ExponentPushToken[abc]");
  assert.equal(sent[0].title, "afk · Studio");
  reply = { data: [{ status: "error", message: "not registered" }] };
  assert.deepEqual(await n.test("ExponentPushToken[abc]"), { ok: false, error: "not registered" });
});
