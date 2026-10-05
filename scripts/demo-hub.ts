// Dev aid: a throwaway hub on :47999 with the fake ACP agent and one thread that asks a question.
// Point the app at http://127.0.0.1:47999 to try UI flows without touching real Zed threads.
import { FakeZed, startHub, until } from "../test/helpers.ts";
import { startHttp } from "../src/hub/http.ts";
import { Launcher } from "../src/hub/launcher.ts";

const prompt = process.argv[2] ?? "ASK3";
const { hub, home } = await startHub();
const cfg = { token: "", host: "127.0.0.1", port: 47999, bindings: {} };
await startHttp(hub, { host: "127.0.0.1", port: 47999, cfg: () => cfg, launcher: new Launcher(hub, () => cfg) });
const zed = new FakeZed(home.sock);
const sid = await zed.open("/tmp/demo");
await until(() => !!hub.interpreter.threads.get(sid)?.conn);
zed.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: prompt }] });
hub.on("event", (e: any) => {
  if (e.type === "entry.upserted" && e.data.kind === "agent") console.log("agent:", e.data.text);
});
console.log(`demo hub on http://127.0.0.1:47999 · thread ${sid}`);
