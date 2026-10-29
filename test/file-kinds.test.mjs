import { test } from "node:test";
import assert from "node:assert/strict";
import { fileKinds } from "../lib/file-kinds.mjs";
import { makeRepo } from "./helpers/repo.mjs";

const kindsOf = async (repo, paths) => Object.fromEntries(await fileKinds({ top: repo.dir }, paths));

test("tests and generated files are told apart by their paths when .gitattributes says nothing", async () => {
  const repo = makeRepo();
  assert.deepEqual(
    await kindsOf(repo, ["src/app.js", "src/app.test.ts", "src/__tests__/x.js", "pkg/thing_test.go", "tests/test_x.py", "package-lock.json", "api/v1/api.pb.go", "src/__snapshots__/a.snap", "dist/app.min.js", "a b/c d.js"]),
    {
      "src/app.js": null,
      "src/app.test.ts": "test",
      "src/__tests__/x.js": "test",
      "pkg/thing_test.go": "test",
      "tests/test_x.py": "test",
      "package-lock.json": "generated",
      "api/v1/api.pb.go": "generated",
      "src/__snapshots__/a.snap": "generated",
      "dist/app.min.js": "generated",
      "a b/c d.js": null,
    },
  );
  assert.deepEqual(await kindsOf(repo, []), {});
});

test(".gitattributes marks or unmarks files, and wins over the guess", async () => {
  const repo = makeRepo();
  repo.write(".gitattributes", ["docs/api.md linguist-generated", "third_party/** linguist-vendored", "src/gen/** -linguist-generated", "src/keep.test.js -diffview-test", "e2e/** diffview-test", ""].join("\n"));
  repo.write("src/nested/.gitattributes", "schema.json linguist-generated=true\n");
  assert.deepEqual(
    await kindsOf(repo, ["docs/api.md", "third_party/lib.js", "src/gen/generated/x.js", "src/keep.test.js", "e2e/login.js", "src/nested/schema.json"]),
    {
      "docs/api.md": "generated",
      "third_party/lib.js": "generated",
      "src/gen/generated/x.js": null,
      "src/keep.test.js": null,
      "e2e/login.js": "test",
      "src/nested/schema.json": "generated",
    },
  );
});
