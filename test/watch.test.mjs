import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoredPath } from "../lib/watch.mjs";

test("changes that cannot change a diff are ignored, and edits are not", () => {
  const ignored = [
    "node_modules/x/index.js",
    ".git/objects/ab/cdef",
    ".git/logs/HEAD",
    "worktrees/ag-1/fsmonitor--daemon/cookies/1234-5",
    ".git/fsmonitor--daemon/cookies/9",
  ];
  const seen = ["src/app.js", ".git/HEAD", "refs/heads/feat", "config", ".graphite_metadata.db", "docs/node_modules.md"];
  for (const file of ignored) assert.equal(ignoredPath(file), true, file);
  for (const file of seen) assert.equal(ignoredPath(file), false, file);
});
