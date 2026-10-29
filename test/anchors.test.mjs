import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorFor, anchoredTexts, AnchorError, locate, nowReads } from "../lib/anchors.mjs";
import { DIFF_ARGS, parseDiff } from "../lib/diff.mjs";
import { makeRepo } from "./helpers/repo.mjs";

/** Parses the diff from a commit of `base` to a commit of `head` ({path: content}). */
function diffOf(base, head) {
  const repo = makeRepo();
  const from = repo.commit("base", base);
  for (const file of Object.keys(base)) if (!(file in head)) head[file] = null;
  const to = repo.commit("head", head);
  return parseDiff(repo.git(...DIFF_ARGS, from, to) + "\n");
}

const lines = (...texts) => texts.join("\n") + "\n";
const numbered = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

// v1 adds a function after five unchanged lines; the comment is on its body (new lines 7-8).
const BASE = lines(...numbered(5));
const V1 = lines(...numbered(5), "function f() {", "  return compute(1);", "  // done", "}");
const COMMENT = { kind: "lines", path: "a.js", side: "new", startLine: 7, endLine: 8 };

test("carry-over follows a comment's text into later versions", async (t) => {
  const v1 = diffOf({ "a.js": BASE }, { "a.js": V1 });
  const anchor = anchorFor(v1, COMMENT);
  const cases = [
    ["the diff is unchanged", { "a.js": BASE }, { "a.js": V1 }, { state: "attached", startLine: 7, endLine: 8 }],
    [
      "a rebase adds lines above, shifting it down",
      { "a.js": lines("new 1", "new 2", "new 3", ...numbered(5)) },
      { "a.js": lines("new 1", "new 2", "new 3", ...numbered(5), "function f() {", "  return compute(1);", "  // done", "}") },
      { state: "attached", startLine: 10, endLine: 11 },
    ],
    [
      "a line next to it changes",
      { "a.js": BASE },
      { "a.js": lines(...numbered(5), "function f(x) {", "  return compute(1);", "  // done", "}") },
      { state: "attached", startLine: 7, endLine: 8 },
    ],
    ["a line inside it changes", { "a.js": BASE }, { "a.js": lines(...numbered(5), "function f() {", "  return compute(2);", "  // done", "}") }, { state: "outdated" }],
    ["its lines are deleted", { "a.js": BASE }, { "a.js": lines(...numbered(5), "function f() {", "}") }, { state: "outdated" }],
    ["the change is reverted, so the file leaves the diff", { "a.js": BASE, "b.js": "x\n" }, { "a.js": BASE, "b.js": "y\n" }, { state: "outdated" }],
  ];
  for (const [name, base, head, expected] of cases) {
    await t.test(name, () => {
      const hit = locate(anchor, diffOf(base, head));
      assert.deepEqual({ state: hit.state, startLine: hit.startLine, endLine: hit.endLine }, { startLine: undefined, endLine: undefined, ...expected });
    });
  }
});

test("a renamed file keeps its comments", () => {
  const body = lines(...numbered(20));
  const anchor = anchorFor(diffOf({ "old.js": body }, { "old.js": body.replace("line 10", "line ten") }), {
    kind: "lines",
    path: "old.js",
    side: "new",
    startLine: 10,
    endLine: 10,
  });
  const renamed = diffOf({ "old.js": body }, { "new.js": body.replace("line 10", "line ten") });
  assert.deepEqual(locate(anchor, renamed), { state: "attached", path: "new.js", startLine: 10, endLine: 10 });
});

test("a comment on a repeated line stays on the same repeat", () => {
  const head = ["a() {", "}", "b() {", "}", "c() {", "}"];
  const anchor = anchorFor(diffOf({ "x.js": "" }, { "x.js": lines(...head) }), { kind: "lines", path: "x.js", side: "new", startLine: 4, endLine: 4 });
  assert.deepEqual([anchor.ordinal, anchor.repeats], [1, 3]);
  // Same number of repeats: the second "}" is still the second, however far it moved.
  const shifted = diffOf({ "x.js": "" }, { "x.js": lines("// one", "// two", "// three", ...head) });
  assert.deepEqual(locate(anchor, shifted), { state: "attached", path: "x.js", startLine: 7, endLine: 7 });
  // A "}" added above changes the count, so the nearest one wins.
  const added = diffOf({ "x.js": "" }, { "x.js": lines("z() {", "}", ...head) });
  assert.deepEqual(locate(anchor, added), { state: "attached", path: "x.js", startLine: 4, endLine: 4 });
});

test("a comment on removed lines anchors to the old side", () => {
  const base = lines(...numbered(5), "obsolete();", ...numbered(3, "tail"));
  const head = lines(...numbered(5), ...numbered(3, "tail"));
  const v1 = diffOf({ "a.js": base }, { "a.js": head });
  const anchor = anchorFor(v1, { kind: "lines", path: "a.js", side: "old", startLine: 6, endLine: 6 });
  assert.equal(locate(anchor, v1).state, "attached");
  assert.equal(locate(anchor, diffOf({ "a.js": base }, { "a.js": base })).state, "outdated");
});

test("file and branch comments attach while their file, or always", () => {
  const v1 = diffOf({ "a.js": BASE }, { "a.js": V1 });
  const file = anchorFor(v1, { kind: "file", path: "a.js" });
  const branch = anchorFor(v1, { kind: "branch" });
  assert.equal(locate(file, v1).state, "attached");
  assert.equal(locate(file, diffOf({ "b.js": "1\n" }, { "b.js": "2\n" })).state, "outdated");
  assert.equal(locate(branch, []).state, "attached");
});

test("anchors refuse lines the diff does not show together", () => {
  const files = diffOf({ "a.js": lines(...numbered(40)) }, { "a.js": lines(...numbered(40)).replace("line 2\n", "two\n").replace("line 38\n", "thirty-eight\n") });
  assert.throws(() => anchorFor(files, { kind: "lines", path: "a.js", side: "new", startLine: 2, endLine: 38 }), AnchorError);
  assert.throws(() => anchorFor(files, { kind: "lines", path: "nope.js", side: "new", startLine: 1 }), /not in this diff/);
  assert.throws(() => anchorFor(files, { kind: "lines", path: "a.js", side: "new", startLine: 3, endLine: 1 }), /not a line range/);
});

test("an outdated comment's lines are guessed in their new form", () => {
  const v1 = diffOf({ "a.js": BASE }, { "a.js": V1 });
  const anchor = anchorFor(v1, COMMENT);
  const texts = anchoredTexts(anchor, v1);
  assert.deepEqual(texts, ["  return compute(1);", "  // done"]);
  const edited = diffOf({ "a.js": BASE }, { "a.js": lines(...numbered(5), "function f() {", "  return compute(1, { cache: true });", "  // done", "}") });
  assert.deepEqual(nowReads(anchor, texts, edited), { path: "a.js", startLine: 7, endLine: 8, text: "  return compute(1, { cache: true });\n  // done" });
  const rewritten = diffOf({ "a.js": BASE }, { "a.js": lines(...numbered(5), "export const g = () => 42;") });
  assert.equal(nowReads(anchor, texts, rewritten), null);
});
