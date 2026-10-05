import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProgressThrottle, UsageLedger, progressOf, searchEntries } from "../src/hub/extras.ts";
import { permissionButtons, singleTextField } from "../src/hub/notify.ts";

const thread = (over: any = {}) => ({ id: "t1", cwd: "/x/aurora-ui", status: "running", ...over }) as any;

test("progress: plan step wins, then the running tool, then waiting", () => {
  const plan = { seq: 1, kind: "plan", data: [{ content: "Read", status: "completed" }, { content: "Wire theme", status: "in_progress" }, { content: "Test", status: "pending" }] } as any;
  const tool = { seq: 2, kind: "tool_call", title: "npm test", status: "in_progress" } as any;
  assert.deepEqual(progressOf(thread(), [plan, tool], "Dark mode"), { threadId: "t1", title: "Dark mode", project: "aurora-ui", running: true, step: "Wire theme", done: 1, total: 3 });
  assert.equal(progressOf(thread(), [tool], "x").step, "npm test");
  assert.equal(progressOf(thread({ status: "needs_permission" }), [tool], "x").step, "Waiting for you");
  assert.equal(progressOf(thread({ status: "idle" }), [], "x").running, false);
});

test("progress throttle: edges always, changes at most every gap, nothing to clear if never sent", () => {
  const th = new ProgressThrottle(1000);
  const p = (step: string, running = true) => ({ threadId: "t1", title: "", project: "", running, step });
  assert.equal(th.shouldSend(p("a", false), 0), false);
  assert.equal(th.shouldSend(p("a"), 0), true);
  assert.equal(th.shouldSend(p("a"), 10), false); // unchanged
  assert.equal(th.shouldSend(p("b"), 500), false); // too soon
  assert.equal(th.shouldSend(p("b"), 1500), true);
  assert.equal(th.shouldSend(p("b", false), 1600), true); // stopped: always
  assert.equal(th.shouldSend(p("b", false), 1700), false);
});

test("search: case-insensitive, newest thread first, snippets around the match", () => {
  const entries = new Map<string, any[]>([
    ["old", [{ seq: 1, kind: "agent", text: "We use the Billing API here." }]],
    ["new", [{ seq: 1, kind: "user", text: "migrate billing" }, { seq: 2, kind: "tool_call", title: "billing" }]],
  ]);
  const hits = searchEntries(entries, ["new", "old"], "BILLING");
  assert.deepEqual(hits.map((h) => h.threadId), ["new", "old"]);
  assert.equal(hits[1].snippet, "We use the Billing API here.");
  assert.deepEqual(searchEntries(entries, ["new"], "b"), []);
});

test("usage ledger: books cost increases to the day, survives restarts of the agent's count", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "afk-u-")), "usage.json");
  const l = new UsageLedger(file);
  const day1 = new Date(2026, 9, 4, 12).getTime();
  const day2 = new Date(2026, 9, 5, 12).getTime();
  l.seed("a", 1.0); // known before: not booked
  l.observe("a", { amount: 1.5, currency: "USD" }, day1);
  l.observe("a", { amount: 2.0 }, day2);
  l.observe("b", { amount: 0.3 }, day2); // first sight: not booked
  l.observe("b", { amount: 0.1 }, day2); // agent restarted its count
  const s = l.summary(day2);
  assert.equal(s.today, 0.6);
  assert.equal(s.days.at(-2)!.cost, 0.5);
  assert.deepEqual(s.byThread, { a: 1, b: 0.1 });
  l.flush();
  assert.equal(new UsageLedger(file).summary(day2).today, 0.6);
});

test("notification buttons: allow/reject once, single free-text questions", () => {
  assert.deepEqual(permissionButtons([{ optionId: "a1", kind: "allow_always" }, { optionId: "a2", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }]), { allow: "a2", reject: "r" });
  assert.equal(singleTextField({ properties: { answer: { type: "string" } } }), "answer");
  assert.equal(singleTextField({ properties: { pick: { type: "string", enum: ["a", "b"] } } }), undefined);
  assert.equal(singleTextField({ properties: { a: { type: "string" }, b: { type: "string" } } }), undefined);
});
