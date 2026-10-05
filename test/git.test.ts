import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commit, diff, discard, status } from "../src/hub/git.ts";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acps-git-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "gone.txt"), "x\n");
  g("add", ".");
  g("commit", "-qm", "init");
  return { dir, g };
}

test("status lists modified/untracked/deleted with line counts; diff works for both", async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/new.ts"), "export const x = 1;\n");
  fs.rmSync(path.join(dir, "gone.txt"));
  const st = await status(dir);
  assert.equal(st.branch, "main");
  assert.equal(st.upstream, false);
  assert.deepEqual(st.files.map((f) => [f.path, f.status, f.added, f.removed]), [
    ["a.txt", "modified", 2, 1],
    ["gone.txt", "deleted", 0, 1],
    ["src/new.ts", "untracked", 1, 0],
  ]);
  assert.match(await diff(dir, "a.txt"), /-two\n\+TWO\n\+three/);
  assert.match(await diff(dir, "src/new.ts"), /\+export const x = 1;/);
  await assert.rejects(diff(dir, "../etc/passwd"), /outside project/);
});

test("commit selected files; discard restores tracked and deletes untracked", async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "k\n");
  fs.writeFileSync(path.join(dir, "junk.txt"), "j\n");
  const { hash } = await commit(dir, "change a", ["a.txt"]);
  assert.match(hash, /^[0-9a-f]{7,}$/);
  assert.deepEqual((await status(dir)).files.map((f) => f.path), ["junk.txt", "keep.txt"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "again\n");
  await discard(dir, ["a.txt", "junk.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "changed\n");
  assert.equal(fs.existsSync(path.join(dir, "junk.txt")), false);
  assert.deepEqual((await status(dir)).files.map((f) => f.path), ["keep.txt"]);
  await assert.rejects(commit(dir, "  "), /message is required/);
});
