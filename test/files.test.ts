import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fuzzyScore, searchFiles } from "../src/hub/files.ts";

test("fuzzy: basename prefix beats substring beats subsequence; no match is -1", () => {
  assert.ok(fuzzyScore("src/components/Composer.tsx", "comp") > fuzzyScore("src/compiler/x.ts", "comp") - 1000);
  assert.ok(fuzzyScore("a/Composer.tsx", "composer") > fuzzyScore("composer-old/readme.md", "composer"));
  assert.ok(fuzzyScore("src/components/ThreadView.tsx", "thrv") > 0);
  assert.equal(fuzzyScore("src/a.ts", "zzz"), -1);
  // Letters that land in the file name beat letters spread over folders.
  assert.ok(fuzzyScore("docs/workflow-builder-next.md", "workflowbuil") > fuzzyScore(".github/workflows/build.yml", "workflowbuil"));
});

test("searchFiles walks a non-git folder, skips node_modules, finds files and folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acps-files-"));
  for (const f of ["src/app/index.tsx", "src/components/Composer.tsx", "node_modules/x/index.js", "README.md"]) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "");
  }
  const r = searchFiles(root, "compo");
  assert.equal(r[0].path, "src/components/Composer.tsx");
  assert.ok(searchFiles(root, "components").some((x) => x.dir && x.path === "src/components/"));
  assert.ok(!searchFiles(root, "index").some((x) => x.path.includes("node_modules")));
});
