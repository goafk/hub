import test from "node:test";
import assert from "node:assert/strict";
import { FakeZed, startHub, until } from "./helpers.ts";

// The same behaviors as the proxy, but with the relay loaded inside the agent's own process.
test("in-process preload: discovery, injected prompt, question answer, no leaks", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock, {}, true);
  try {
    const sid = await zed.open("/proj");
    await until(() => !!hub.interpreter.threads.get(sid)?.conn);
    assert.equal(hub.interpreter.threads.get(sid)!.agentId, "fake");
    await hub.command(sid, { cmd: "prompt", text: "from phone" });
    await zed.next((m) => m.method === "session/update" && m.params.update.content?.text === "from phone");
    await zed.next((m) => m.method === "session/update" && m.params.update.content?.text === "lo");
    await until(() => hub.interpreter.threads.get(sid)!.status === "idle" && hub.interpreter.entries.get(sid)!.length === 2);
    const turn = zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "ASK" }] });
    const req = await zed.next((m) => m.method === "elicitation/create");
    await until(() => hub.interpreter.threads.get(sid)!.pendingElicitations.length === 1);
    await hub.command(sid, { cmd: "elicitation", requestId: req.id, action: "accept", content: { question_0: "A" } });
    zed.write({ jsonrpc: "2.0", id: req.id, result: { action: "decline" } }); // Zed's late answer is dropped
    await zed.next((m) => m.method === "session/update" && m.params.update.content?.text === 'ask:accept:{"question_0":"A"}');
    await turn;
    const leaked = zed.received.filter((m) => typeof m.id === "string");
    assert.deepEqual(leaked, [], "no sync-* responses reach Zed");
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("preload scrubs its env so processes the agent spawns never load it", async () => {
  const path = await import("node:path");
  const preload = path.join(import.meta.dirname, "..", "src/proxy/preload.ts");
  const script = 'const r = require("child_process").execSync("node -p \\"JSON.stringify([process.env.NODE_OPTIONS, process.env.ACP_SYNC_AGENT])\\"").toString(); require("fs").writeSync(2, r);';
  const res = (await import("node:child_process")).spawnSync(process.execPath, ["--no-warnings", "-e", script], {
    env: { ...process.env, NODE_OPTIONS: `--import=${preload} --max-old-space-size=4096`, ACP_SYNC_AGENT: "probe", ACP_SYNC_HOME: "/tmp/acps-none" },
  });
  // Other user options survive; ours (and the agent marker) are gone.
  assert.deepEqual(JSON.parse(res.stderr.toString().trim().split("\n").pop()!), ["--max-old-space-size=4096", null]);
});

test("resume: the hub loads a thread Zed hasn't opened into a running agent, then it can be continued", async () => {
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock, {}, true);
  try {
    await zed.open("/proj"); // some other thread keeps the agent process running
    await until(() => hub.agents().length === 1);
    const t = await hub.resume("old-thread", "fake", "/proj");
    assert.equal(t.id, "old-thread");
    await until(() => hub.interpreter.entries.get("old-thread")?.length === 2);
    assert.deepEqual(hub.interpreter.entries.get("old-thread")!.map((e) => e.text), ["old question", "old answer"]);
    await hub.command("old-thread", { cmd: "prompt", text: "continue from phone" });
    await until(() => hub.interpreter.entries.get("old-thread")!.some((e) => e.text === "Hello"));
    await assert.rejects(hub.resume("x", "nobody", "/proj"), (e: any) => e.code === "offline");
  } finally {
    zed.kill();
    await hub.stop();
  }
});

test("phone-only thread: the hub starts a session Zed never sees; files, terminals and permissions are handled without Zed", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { hub, home } = await startHub();
  const zed = new FakeZed(home.sock, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-phone-"));
  fs.writeFileSync(path.join(dir, "hello.txt"), "hi from disk");
  try {
    await zed.open("/proj"); // keeps the agent process running
    await until(() => hub.agents().length === 1);
    const seen = zed.received.length;
    const t = await hub.startHeadless("fake", dir);
    assert.equal(t.cwd, dir);
    await hub.command(t.id, { cmd: "prompt", text: `FILE:${path.join(dir, "hello.txt")}` });
    await until(() => hub.interpreter.entries.get(t.id)!.some((e) => e.text === "file:hi from disk"));
    await until(() => hub.interpreter.threads.get(t.id)!.status === "idle");
    await hub.command(t.id, { cmd: "prompt", text: "RUN:echo afk-ok" });
    await until(() => hub.interpreter.entries.get(t.id)!.some((e) => e.text === "run:0:afk-ok"));
    await until(() => hub.interpreter.threads.get(t.id)!.status === "idle");
    await hub.command(t.id, { cmd: "prompt", text: "PERM" });
    await until(() => hub.interpreter.threads.get(t.id)!.pendingPermissions.length === 1);
    const req = hub.interpreter.threads.get(t.id)!.pendingPermissions[0];
    await hub.command(t.id, { cmd: "permission", requestId: req.requestId, optionId: "allow" });
    await until(() => hub.interpreter.entries.get(t.id)!.some((e) => e.text === "perm:allow"));
    // Zed received nothing about this session.
    const leaked = zed.received.slice(seen).filter((m) => JSON.stringify(m).includes(t.id));
    assert.deepEqual(leaked, []);
    await assert.rejects(hub.startHeadless("nobody", dir), (e: any) => e.code === "offline");
  } finally {
    zed.kill();
    await hub.stop();
  }
});
