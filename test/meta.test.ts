import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetaStore, pickAllowOption } from "../src/hub/meta.ts";

test("meta: rename/archive/autoApprove persist; clearing removes the entry", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acps-meta-")), "m.json");
  const m = new MetaStore(file);
  m.set("a", { title: "  Better name ", archived: true });
  assert.deepEqual(new MetaStore(file).get("a"), { title: "Better name", archived: true });
  m.set("a", { title: "", archived: false });
  assert.deepEqual(new MetaStore(file).get("a"), {});
});

test("auto-approve picks always > once > any allow", () => {
  assert.equal(pickAllowOption([{ optionId: "reject", kind: "reject_once" }, { optionId: "once", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }]), "always");
  assert.equal(pickAllowOption([{ optionId: "allow-once" }, { optionId: "reject" }]), "allow-once");
  assert.equal(pickAllowOption([{ optionId: "reject", kind: "reject_once" }]), undefined);
});
