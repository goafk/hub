import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../src/setup/jsonc.ts";

test("parses comments, trailing commas, and keeps // inside strings", () => {
  const text = `// header
{
  /* block
     comment */
  "url": "https://example.com//path", // trailing comment
  "s": "a /* not a comment */ b",
  "esc": "quote \\" // still string",
  "arr": [1, 2, 3,],
  "obj": { "k": true, },
}`;
  assert.deepEqual(parseJsonc(text), {
    url: "https://example.com//path",
    s: "a /* not a comment */ b",
    esc: 'quote " // still string',
    arr: [1, 2, 3],
    obj: { k: true },
  });
});

test("parses plain JSON", () => {
  assert.deepEqual(parseJsonc('{"a":[{"b":null}]}'), { a: [{ b: null }] });
});
