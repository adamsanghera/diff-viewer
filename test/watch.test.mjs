import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoredPath } from "../lib/watch.mjs";

test("changes in the common dir that cannot change a diff or a stack are ignored, and ref moves are not", () => {
  const ignored = ["objects/ab/cdef", "logs/HEAD", "logs/refs/heads/feat", "worktrees/ag-1/fsmonitor--daemon/cookies/1234-5", "fsmonitor--daemon/cookies/9"];
  const seen = ["HEAD", "worktrees/ag-1/HEAD", "refs/heads/feat", "packed-refs", "config", ".graphite_metadata.db", "gh-stack"];
  for (const file of ignored) assert.equal(ignoredPath(file), true, file);
  for (const file of seen) assert.equal(ignoredPath(file), false, file);
});
