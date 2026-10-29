import { test } from "node:test";
import assert from "node:assert/strict";
import { DIFF_ARGS, parseDiff, splitRows, unquotePath } from "../lib/diff.mjs";
import { makeRepo } from "./helpers/repo.mjs";

/** Commits `before`, then `after`, and parses the diff between them. */
function diffOf(before, after) {
  const repo = makeRepo();
  const base = repo.commit("before", before);
  const head = repo.commit("after", after);
  return parseDiff(repo.git(...DIFF_ARGS, base, head) + "\n");
}

const byPath = (files, p) => files.find((f) => (f.newPath ?? f.oldPath) === p);

test("a modified file has hunks with old and new line numbers", () => {
  const [file] = diffOf({ "a.txt": "one\ntwo\nthree\n" }, { "a.txt": "one\n2\nthree\nfour\n" });
  assert.equal(file.status, "modified");
  assert.deepEqual([file.oldPath, file.newPath, file.additions, file.deletions], ["a.txt", "a.txt", 2, 1]);
  assert.deepEqual(
    file.hunks[0].lines.map((l) => [l.kind, l.old, l.new, l.text]),
    [
      ["context", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["add", null, 2, "2"],
      ["context", 3, 3, "three"],
      ["add", null, 4, "four"],
    ],
  );
});

test("added and deleted files have one side only", () => {
  const files = diffOf({ "gone.txt": "bye\n" }, { "gone.txt": null, "new.txt": "hi\n" });
  const added = byPath(files, "new.txt");
  const deleted = byPath(files, "gone.txt");
  assert.deepEqual([added.status, added.oldPath, added.newMode], ["added", null, "100644"]);
  assert.deepEqual(added.hunks[0].lines.map((l) => [l.kind, l.new]), [["add", 1]]);
  assert.deepEqual([deleted.status, deleted.newPath], ["deleted", null]);
  assert.deepEqual(deleted.hunks[0].lines.map((l) => [l.kind, l.old]), [["del", 1]]);
});

test("an empty new file has no hunks", () => {
  const [file] = diffOf({}, { "empty.txt": "" });
  assert.deepEqual([file.status, file.newPath, file.hunks.length], ["added", "empty.txt", 0]);
});

test("a rename keeps both paths and its similarity", () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const [file] = diffOf({ "old name.txt": body }, { "old name.txt": null, "new name.txt": body.replace("line 3", "line three") });
  assert.deepEqual([file.status, file.oldPath, file.newPath], ["renamed", "old name.txt", "new name.txt"]);
  assert.ok(file.similarity > 50);
  assert.equal(file.additions, 1);
});

test("binary files are flagged and have no hunks", () => {
  const [file] = diffOf({ "img.bin": "\0\x01\x02" }, { "img.bin": "\0\x01\x03" });
  assert.deepEqual([file.binary, file.hunks.length, file.newPath], [true, 0, "img.bin"]);
});

test("a missing newline at the end of the file marks the line", () => {
  const [file] = diffOf({ "a.txt": "a\nb" }, { "a.txt": "a\nc" });
  const lines = file.hunks[0].lines;
  assert.deepEqual(lines.filter((l) => l.noNewline).map((l) => [l.kind, l.text]), [["del", "b"], ["add", "c"]]);
});

test("paths with spaces and unusual characters survive", () => {
  const files = diffOf({}, { "dir with space/a b.txt": "x\n", "tab\there.txt": "y\n", "café.txt": "z\n" });
  assert.deepEqual(files.map((f) => f.newPath).sort(), ["café.txt", "dir with space/a b.txt", "tab\there.txt"]);
});

test("a removed line that looks like a file header stays a removed line", () => {
  const [file] = diffOf({ "a.md": "keep\n-- note\n" }, { "a.md": "keep\n" });
  assert.deepEqual(file.hunks[0].lines.map((l) => [l.kind, l.text]), [["context", "keep"], ["del", "-- note"]]);
});

test("mode changes are recorded", () => {
  const repo = makeRepo();
  const base = repo.commit("a", { "run.sh": "echo hi\n" });
  repo.git("update-index", "--chmod=+x", "run.sh");
  repo.git("commit", "-q", "-m", "chmod");
  const [file] = parseDiff(repo.git(...DIFF_ARGS, base, "HEAD"));
  assert.deepEqual([file.oldMode, file.newMode, file.hunks.length], ["100644", "100755", 0]);
});

test("unquotePath decodes git's C-style escapes", () => {
  assert.equal(unquotePath('"a/tab\\there"'), "a/tab\there");
  assert.equal(unquotePath('"caf\\303\\251"'), "café");
  assert.equal(unquotePath("plain"), "plain");
});

const del = (old, text = `-${old}`) => ({ kind: "del", old, new: null, text });
const add = (n, text = `+${n}`) => ({ kind: "add", old: null, new: n, text });
const ctx = (old, n) => ({ kind: "context", old, new: n, text: "ctx" });
const shape = (rows) => rows.map((r) => [r.old?.kind ?? null, r.old?.old ?? null, r.new?.kind ?? null, r.new?.new ?? null]);

test("splitRows pairs removals with additions, as GitHub does", () => {
  const cases = [
    ["removals only", [del(1), del(2)], [["del", 1, null, null], ["del", 2, null, null]]],
    ["additions only", [add(1), add(2)], [[null, null, "add", 1], [null, null, "add", 2]]],
    ["more removals", [del(1), del(2), add(1)], [["del", 1, "add", 1], ["del", 2, null, null]]],
    ["more additions", [del(1), add(1), add(2)], [["del", 1, "add", 1], [null, null, "add", 2]]],
    [
      "two runs split by context",
      [del(1), add(1), ctx(2, 2), del(3), add(3)],
      [["del", 1, "add", 1], ["context", 2, "context", 2], ["del", 3, "add", 3]],
    ],
    ["an addition then a removal", [add(1), del(1)], [[null, null, "add", 1], ["del", 1, null, null]]],
  ];
  for (const [name, lines, expected] of cases) assert.deepEqual(shape(splitRows(lines)), expected, name);
});
