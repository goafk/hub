import test from "node:test";
import { Pairing } from "../src/hub/pairing.ts";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { FakeZed, startHub, until } from "./helpers.ts";
import { startHttp } from "../src/hub/http.ts";
import { Launcher, keystrokeScript } from "../src/hub/launcher.ts";
import type { Config } from "../src/config.ts";

const CFG: Config = { token: "secret", hubId: "testhub", host: "127.0.0.1", port: 0, zedCli: "/bin/zed-stub", bindings: { fake: { zedName: "Fake (synced)", keys: "ctrl-alt-cmd-z a", name: "Fake" } } };

async function setup(opts: { loopback?: boolean; run?: (c: string, a: string[]) => Promise<string>; timeoutMs?: number; locked?: boolean } = {}) {
  const { hub, home } = await startHub();
  const launcher = new Launcher(hub, () => CFG, { run: opts.run ?? (async () => ""), timeoutMs: opts.timeoutMs ?? 5000, settleMs: 1, isLocked: async () => !!opts.locked });
  const pairing = new Pairing(fs.mkdtempSync(path.join(os.tmpdir(), "acp-pair-")));
  const api = await startHttp(hub, { host: "127.0.0.1", port: 0, cfg: () => CFG, launcher, pairing, isLoopback: () => opts.loopback ?? true });
  const base = `http://127.0.0.1:${api.port}`;
  const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { hub, home, api, base, call, pairing, close: async () => { await api.close(); await hub.stop(); } };
}

test("pairing: one-time code → per-phone key, revocable; master token still works", async () => {
  const s = await setup({ loopback: false });
  try {
    assert.equal((await s.call("GET", "/info")).status, 401);
    const { code } = s.pairing.createCode();
    assert.equal((await s.call("POST", "/pair", { code: "WRONGCODE1", name: "Pixel" })).status, 401);
    const ok = await s.call("POST", "/pair", { code: code.toLowerCase(), name: "Pixel" });
    assert.equal(ok.status, 200);
    assert.match(ok.json.key, /^zt_/);
    assert.equal(ok.json.client.name, "Pixel");
    assert.equal(typeof ok.json.hub.id, "string");
    // Codes are single-use.
    assert.equal((await s.call("POST", "/pair", { code, name: "Again" })).status, 401);
    const auth = { authorization: `Bearer ${ok.json.key}` };
    const info = await s.call("GET", "/info", undefined, auth);
    assert.equal(info.status, 200);
    assert.ok(info.json.name);
    const clients = await s.call("GET", "/clients", undefined, { authorization: "Bearer secret" });
    assert.deepEqual(clients.json.map((c: any) => c.name), ["Pixel"]);
    assert.equal(clients.json[0].keyHash, undefined);
    await s.call("POST", "/clients/revoke", { id: ok.json.client.id }, { authorization: "Bearer secret" });
    assert.equal((await s.call("GET", "/info", undefined, auth)).status, 401);
    // Too many wrong codes lock pairing for a while.
    for (let i = 0; i < 10; i++) await s.call("POST", "/pair", { code: `BAD${i}`, name: "x" });
    const fresh = s.pairing.createCode().code;
    assert.equal((await s.call("POST", "/pair", { code: fresh, name: "x" })).status, 401);
  } finally {
    await s.close();
  }
});

test("keystroke script for a chord", () => {
  assert.deepEqual(keystrokeScript("ctrl-alt-cmd-z a"), [
    'tell application "System Events" to keystroke "z" using {control down, option down, command down}', "delay 0.15",
    'tell application "System Events" to keystroke "a"', "delay 0.15",
  ]);
});

test("list, show, prompt, config, errors", async () => {
  const s = await setup();
  const zed = new FakeZed(s.home.sock);
  try {
    const sid = await zed.open("/tmp");
    await until(() => !!s.hub.interpreter.threads.get(sid)?.conn);
    const list = await s.call("GET", "/threads");
    assert.equal(list.status, 200);
    assert.equal(list.json[0].id, sid);
    assert.equal(list.json[0].online, true);
    const p = await s.call("POST", `/threads/${sid}/prompt`, { text: "hello" });
    assert.equal(p.status, 202);
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "idle" && s.hub.interpreter.entries.get(sid)!.length === 2);
    const show = await s.call("GET", `/threads/${sid}`);
    assert.deepEqual(show.json.entries.map((e: any) => e.text), ["hello", "Hello"]);
    assert.equal(show.json.preview, "Hello");
    assert.equal((await s.call("POST", `/threads/${sid}/config`, { configId: "model", value: "b" })).status, 200);
    assert.equal((await s.call("POST", `/threads/${sid}/config`, { configId: "model", value: "nope" })).status, 400);
    // Boolean options (Fast mode) take a real boolean and update Zed's toggle.
    const fast = await s.call("POST", `/threads/${sid}/config`, { configId: "fast", value: true });
    assert.equal(fast.status, 200);
    assert.equal(fast.json.configOptions.find((o: any) => o.id === "fast").currentValue, true);
    await zed.next((m) => m.method === "session/update" && m.params.update.sessionUpdate === "config_option_update" && m.params.update.configOptions.some((o: any) => o.id === "fast" && o.currentValue === true));
    assert.equal((await s.call("GET", "/threads/missing")).status, 404);
    assert.equal((await s.call("POST", `/threads/${sid}/prompt`, { text: "" })).status, 400);
    assert.equal((await s.call("POST", `/threads/${sid}/permission`, { optionId: "x" })).status, 404);
    const agents = await s.call("GET", "/agents");
    assert.deepEqual(agents.json, [{ agentId: "fake", name: "Fake", zedName: "Fake (synced)", keys: "ctrl-alt-cmd-z a", connections: 1 }]);
  } finally {
    zed.kill();
    await s.close();
  }
});

test("@-mentions: file search for known projects and resource_link blocks in prompts", async () => {
  const s = await setup();
  const zed = new FakeZed(s.home.sock);
  const proj = fs.realpathSync(fs.mkdtempSync("/tmp/acps-proj-"));
  fs.mkdirSync(`${proj}/src`);
  fs.writeFileSync(`${proj}/src/Composer.tsx`, "");
  try {
    const sid = await zed.open(proj);
    await until(() => !!s.hub.interpreter.threads.get(sid)?.conn);
    const f = await s.call("GET", `/files?cwd=${encodeURIComponent(proj)}&q=compo`);
    assert.equal(f.json.files[0].path, "src/Composer.tsx");
    assert.equal((await s.call("GET", `/files?cwd=${encodeURIComponent("/etc")}&q=x`)).status, 400);
    assert.equal((await s.call("POST", `/threads/${sid}/prompt`, { text: "look", mentions: ["../../etc/passwd"] })).status, 400);
    const p = await s.call("POST", `/threads/${sid}/prompt`, { text: "explain", mentions: ["src/Composer.tsx"] });
    assert.equal(p.status, 202);
    const link = await zed.next((m) => m.method === "session/update" && m.params.update.content?.type === "resource_link");
    assert.equal(link.params.update.content.uri, `file://${proj}/src/Composer.tsx`);
    await until(() => (s.hub.interpreter.entries.get(sid) ?? []).some((e) => e.kind === "user" && e.text === "explain @Composer.tsx"));
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "idle");
    // Photos ride along as ACP image blocks.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    assert.equal((await s.call("POST", `/threads/${sid}/prompt`, { text: "what is this", images: [{ mimeType: "text/html", data: "x" }] })).status, 400);
    assert.equal((await s.call("POST", `/threads/${sid}/prompt`, { text: "what is this", images: [{ mimeType: "image/png", data: png }] })).status, 202);
    const img = await zed.next((m) => m.method === "session/update" && m.params.update.content?.type === "image");
    assert.equal(img.params.update.content.data, png);
  } finally {
    zed.kill();
    await s.close();
  }
});

test("mid-turn prompts queue and send when the turn ends; offline → 409", async () => {
  const s = await setup();
  const zed = new FakeZed(s.home.sock);
  try {
    const sid = await zed.open("/tmp");
    await until(() => !!s.hub.interpreter.threads.get(sid)?.conn);
    const turn = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "SLOW" }] });
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "running");
    const q1 = await s.call("POST", `/threads/${sid}/prompt`, { text: "first queued" });
    assert.equal(q1.status, 202);
    assert.equal(q1.json.queued.text, "first queued");
    await s.call("POST", `/threads/${sid}/prompt`, { text: "second queued" });
    const thread = await s.call("GET", `/threads/${sid}`);
    assert.deepEqual(thread.json.queued.map((q: any) => q.text), ["first queued", "second queued"]);
    // Edit and remove work on queued items.
    const second = thread.json.queued[1].id;
    await s.call("POST", `/threads/${sid}/queue`, { action: "edit", id: second, text: "second, edited" });
    assert.equal((await s.call("GET", `/threads/${sid}`)).json.queued[1].text, "second, edited");
    await turn;
    // Turn over: the queue drains one message per turn, in order.
    await until(() => (s.hub.interpreter.entries.get(sid) ?? []).some((e) => e.kind === "user" && e.text === "first queued"));
    await until(() => (s.hub.interpreter.entries.get(sid) ?? []).some((e) => e.kind === "user" && e.text === "second, edited"));
    await until(() => s.hub.queue.list(sid).length === 0 && s.hub.interpreter.threads.get(sid)!.status === "idle");
    zed.kill();
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "offline");
    assert.equal((await s.call("POST", `/threads/${sid}/prompt`, { text: "x" })).json.error.code, "offline");
  } finally {
    zed.kill();
    await s.close();
  }
});

test("send now stops the current turn and sends the queued message", async () => {
  const s = await setup();
  const zed = new FakeZed(s.home.sock);
  try {
    const sid = await zed.open("/tmp");
    await until(() => !!s.hub.interpreter.threads.get(sid)?.conn);
    const turn = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "SLOW" }] });
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "running");
    await s.call("POST", `/threads/${sid}/prompt`, { text: "keep waiting" });
    const urgent = (await s.call("POST", `/threads/${sid}/prompt`, { text: "urgent" })).json.queued.id;
    assert.equal((await s.call("POST", `/threads/${sid}/queue`, { action: "send_now", id: urgent })).status, 200);
    assert.equal((await turn).result.stopReason, "cancelled");
    await until(() => (s.hub.interpreter.entries.get(sid) ?? []).some((e) => e.kind === "user" && e.text === "urgent"));
    // "Send now" jumped the line; the other message goes after it.
    await until(() => (s.hub.interpreter.entries.get(sid) ?? []).some((e) => e.kind === "user" && e.text === "keep waiting"));
    // Stopping a turn by hand holds the queue.
    const t2 = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "SLOW again" }] });
    await until(() => s.hub.interpreter.threads.get(sid)!.status === "running");
    await s.call("POST", `/threads/${sid}/prompt`, { text: "held" });
    await s.call("POST", `/threads/${sid}/cancel`);
    assert.equal((await t2).result.stopReason, "cancelled");
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(s.hub.queue.list(sid).map((q) => q.text), ["held"]);
    await s.call("POST", `/threads/${sid}/queue`, { action: "clear" });
    assert.equal(s.hub.queue.list(sid).length, 0);
  } finally {
    zed.kill();
    await s.close();
  }
});

test("SSE streams events for a thread", async () => {
  const s = await setup();
  const zed = new FakeZed(s.home.sock);
  try {
    const sid = await zed.open("/tmp");
    await until(() => !!s.hub.interpreter.threads.get(sid)?.conn);
    const got: string[] = [];
    const req = http.get(`${s.base}/events?thread=${sid}`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d: string) => got.push(d));
    });
    await until(() => got.join("").includes(": connected"));
    await s.call("POST", `/threads/${sid}/prompt`, { text: "hello" });
    await until(() => got.join("").includes("event: needs_input"));
    const all = got.join("");
    assert.match(all, /event: entry.upserted/);
    assert.match(all, /"reason":"turn_ended"/);
    req.destroy();
  } finally {
    zed.kill();
    await s.close();
  }
});

test("token required off-loopback", async () => {
  const s = await setup({ loopback: false });
  try {
    assert.equal((await s.call("GET", "/threads")).status, 401);
    assert.equal((await s.call("GET", "/threads", undefined, { authorization: "Bearer secret" })).status, 200);
    assert.equal((await s.call("GET", "/threads?token=secret")).status, 200);
  } finally {
    await s.close();
  }
});

test("requests relayed by a local proxy (tailscale serve) need the token even from loopback", async () => {
  const s = await setup({ loopback: true });
  try {
    assert.equal((await s.call("GET", "/threads")).status, 200);
    assert.equal((await s.call("GET", "/threads", undefined, { "x-forwarded-for": "100.64.0.9" })).status, 401);
    assert.equal((await s.call("GET", "/threads", undefined, { "tailscale-user-login": "me@x" })).status, 401);
    assert.equal((await s.call("GET", "/threads", undefined, { "x-forwarded-for": "100.64.0.9", authorization: "Bearer secret" })).status, 200);
  } finally {
    await s.close();
  }
});

test("launch: runs zed + keystroke, waits for the new session, sends first prompt", async () => {
  let zed: FakeZed | undefined;
  const calls: string[][] = [];
  const s = await setup({
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "osascript") {
        // Simulate Zed reacting to the keybinding by starting a session in that project.
        zed = new FakeZed(s.home.sock);
        zed.open(fs.realpathSync("/tmp"));
      }
      return "";
    },
  });
  try {
    const r = await s.call("POST", "/threads", { cwd: "/tmp", agentId: "fake", prompt: "first" });
    assert.equal(r.status, 201);
    assert.equal(calls[0][0], "/bin/zed-stub");
    assert.deepEqual(calls[0].slice(1), ["-e", fs.realpathSync("/tmp")]);
    assert.ok(calls[1].join(" ").includes('keystroke "z" using {control down, option down, command down}'));
    await zed!.next((m) => m.method === "session/update" && m.params.update.content?.text === "first");
    await until(() => s.hub.interpreter.entries.get(r.json.id)?.length === 2);
    assert.equal((await s.call("POST", "/threads", { cwd: "/nope/x", agentId: "fake" })).status, 400);
    assert.equal((await s.call("POST", "/threads", { cwd: "/tmp", agentId: "ghost" })).status, 400);
  } finally {
    zed?.kill();
    await s.close();
  }
});

test("launch via key helper app: writes script, opens app, reports helper errors", async () => {
  const { hub, home } = await startHub();
  const app = `${home.dir}/AcpSyncKeys.app`;
  const cfg: Config = { ...CFG, keyHelper: app };
  let zed: FakeZed | undefined;
  let fail = false;
  const calls: string[][] = [];
  const launcher = new Launcher(hub, () => cfg, {
    settleMs: 1,
    timeoutMs: 5000,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "open") {
        const script = fs.readFileSync(`${home.dir}/keys.applescript`, "utf8");
        assert.match(script, /keystroke "a"/);
        if (fail) fs.writeFileSync(`${home.dir}/keys.result`, "error: not allowed assistive access");
        else {
          fs.writeFileSync(`${home.dir}/keys.result`, "ok");
          zed = new FakeZed(home.sock);
          zed.open(fs.realpathSync("/tmp"));
        }
      }
      return "";
    },
  });
  try {
    const t = await launcher.launch({ cwd: "/tmp", agentId: "fake" });
    assert.equal(t.agentId, "fake");
    assert.deepEqual(calls[1], ["open", "-W", "-g", "-a", app]);
    fail = true;
    await assert.rejects(launcher.launch({ cwd: "/tmp", agentId: "fake" }), /AcpSyncKeys: not allowed assistive access.*Accessibility/);
  } finally {
    zed?.kill();
    await hub.stop();
  }
});

test("launch times out when Zed never starts a session", async () => {
  const s = await setup({ timeoutMs: 300 });
  try {
    const r = await s.call("POST", "/threads", { cwd: "/tmp", agentId: "fake" });
    assert.equal(r.status, 504);
  } finally {
    await s.close();
  }
});

test("new thread: a locked Mac screen is reported right away, without pressing keys", async () => {
  const calls: string[] = [];
  const s = await setup({ locked: true, run: async (c) => (calls.push(c), "") });
  try {
    const r = await s.call("POST", "/threads", { cwd: os.tmpdir(), agentId: "fake", prompt: "hi" });
    assert.equal(r.status, 409);
    assert.match(r.json.error?.message ?? r.json.message ?? JSON.stringify(r.json), /locked/);
    assert.deepEqual(calls, []);
  } finally {
    await s.close();
  }
});
