import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/hub/store.ts";
import type { Thread } from "../src/hub/interpreter.ts";

test("persists threads and entries across reopen; clearEntries", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acps-db-")), "hub.db");
  const t: Thread = { id: "s1", agentId: "claude", cwd: "/p", title: "T", status: "idle", inFlight: 0, createdAt: 1, updatedAt: 2, pendingPermissions: [], configOptions: [{ id: "model" }] };
  let s = new Store(file);
  s.saveThread(t);
  s.saveEntry("s1", { seq: 1, kind: "user", text: "hi" });
  s.saveEntry("s1", { seq: 2, kind: "agent", text: "he" });
  s.saveEntry("s1", { seq: 2, kind: "agent", text: "hello" }); // upsert
  s.close();
  s = new Store(file);
  const { threads, entries } = s.load();
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].configOptions, [{ id: "model" }]);
  assert.deepEqual(entries.get("s1")!.map((e) => e.text), ["hi", "hello"]);
  s.clearEntries("s1");
  assert.equal(s.load().entries.get("s1")?.length ?? 0, 0);
  s.close();
});
