import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRepo } from "../lib/repo.mjs";
import { loadStack } from "../lib/stack.mjs";
import { makeRepo } from "./helpers/repo.mjs";

/** main <- a <- b <- c, each branch adding one file. Returns the repo with c checked out. */
function linearStack() {
  const repo = makeRepo();
  for (const [branch, from] of [["a", "main"], ["b", "a"], ["c", "b"]]) {
    repo.git("checkout", "-q", "-b", branch, from);
    repo.commit(branch, { [`${branch}.txt`]: `${branch}\n` });
  }
  return repo;
}

async function stackOf(repo, options) {
  const stack = await loadStack(await openRepo(repo.dir), options);
  return { ...stack, shape: stack.entries.map((e) => [e.id, e.parent, e.source]) };
}

function setOrigin(repo, branch, parent, base, change = 7) {
  repo.git("config", `branch.${branch}.origin-parent`, parent);
  repo.git("config", `branch.${branch}.origin-parent-sha`, base);
  repo.git("config", `branch.${branch}.origin-change`, String(change));
}

function writeGraphiteDb(repo, rows) {
  const db = new DatabaseSync(path.join(repo.commonDir(), ".graphite_metadata.db"));
  db.exec(`CREATE TABLE branch_metadata (branch_name TEXT PRIMARY KEY, parent_branch_name TEXT, parent_branch_revision TEXT,
    last_submitted_version TEXT, state TEXT, children TEXT, branch_revision TEXT, validation_result TEXT, parent_head_revision TEXT)`);
  const insert = db.prepare("INSERT INTO branch_metadata (branch_name, parent_branch_name, parent_branch_revision, validation_result) VALUES (?, ?, ?, ?)");
  for (const [branch, parent, base, validation = "VALID"] of rows) insert.run(branch, parent, base, validation);
  db.close();
}

function writeGhStack(repo, value) {
  fs.writeFileSync(path.join(repo.commonDir(), "gh-stack"), typeof value === "string" ? value : JSON.stringify(value));
}

test("a hand-made stack comes from git history", async () => {
  const repo = linearStack();
  const { trunk, shape, entries } = await stackOf(repo, { entry: "b" });
  assert.equal(trunk, "main");
  assert.deepEqual(shape, [["a", null, "git"], ["b", "a", "git"], ["c", "b", "git"]]);
  assert.equal(entries[1].base, repo.sha("a"));
  assert.deepEqual(entries.map((e) => e.children), [["b"], ["c"], []]);
  assert.ok(entries.every((e) => !e.needsRestack));
});

test("a branch with two children shows both above it", async () => {
  const repo = linearStack();
  repo.git("checkout", "-q", "-b", "b2", "a");
  repo.commit("b2", { "b2.txt": "x\n" });
  const { shape } = await stackOf(repo, { entry: "a" });
  assert.deepEqual(shape, [["a", null, "git"], ["b", "a", "git"], ["c", "b", "git"], ["b2", "a", "git"]]);
});

test("a branch alone on trunk is a one-entry stack based at its merge-base", async () => {
  const repo = makeRepo();
  const root = repo.sha("main");
  repo.git("checkout", "-q", "-b", "solo");
  repo.commit("solo", { "s.txt": "s\n" });
  repo.git("checkout", "-q", "main");
  repo.commit("trunk moves", { "t.txt": "t\n" });
  const { shape, entries } = await stackOf(repo, { entry: "solo" });
  assert.deepEqual(shape, [["solo", null, "git"]]);
  assert.equal(entries[0].base, root);
  assert.equal(entries[0].needsRestack, false);
});

test("merge-bases use the freshest trunk, local or remote", async () => {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "feature");
  repo.commit("feature", { "f.txt": "f\n" });
  repo.git("checkout", "-q", "main");
  const landed = repo.commit("landed upstream", { "u.txt": "u\n" }, { date: Math.floor(Date.now() / 1000) + 3600 });
  repo.git("update-ref", "refs/remotes/upstream/main", landed);
  repo.git("config", "remote.upstream.url", "https://example.com/r.git");
  repo.git("reset", "-q", "--hard", "HEAD~1");
  repo.git("checkout", "-q", "feature");
  repo.git("merge", "-q", "--no-edit", "--no-ff", landed);
  const [feature] = (await stackOf(repo, { entry: "feature" })).entries;
  assert.equal(feature.base, landed);
});

test("two branches at one commit are not each other's parent", async () => {
  const repo = linearStack();
  repo.git("branch", "a-copy", "a");
  const { shape } = await stackOf(repo, { entry: "a" });
  assert.deepEqual(shape.slice(0, 2), [["a", null, "git"], ["b", "a", "git"]]);
});

test("each tool's records are read", async (t) => {
  await t.test("origin", async () => {
    const repo = linearStack();
    setOrigin(repo, "b", "a", repo.sha("a"), 1234);
    const { entries } = await stackOf(repo, { entry: "b" });
    const b = entries.find((e) => e.id === "b");
    assert.deepEqual([b.source, b.parent, b.pr], ["origin", "a", { number: 1234, url: null }]);
  });
  await t.test("gh stack", async () => {
    const repo = linearStack();
    writeGhStack(repo, {
      schemaVersion: 1,
      stacks: [{ trunk: { branch: "main" }, branches: [
        { branch: "a", base: repo.sha("main") },
        { branch: "b", base: repo.sha("a"), pullRequest: { number: 9, url: "https://github.com/o/r/pull/9" } },
      ] }],
    });
    const { shape, entries } = await stackOf(repo, { entry: "b" });
    assert.deepEqual(shape.slice(0, 2), [["a", null, "gh-stack"], ["b", "a", "gh-stack"]]);
    assert.equal(entries[1].pr.url, "https://github.com/o/r/pull/9");
  });
  await t.test("graphite's database, skipping rows it marks invalid", async () => {
    const repo = linearStack();
    writeGraphiteDb(repo, [["a", "main", repo.sha("main")], ["b", "a", repo.sha("a")], ["c", "b", repo.sha("b"), "BAD_PARENT_NAME"]]);
    const { shape } = await stackOf(repo, { entry: "b" });
    assert.deepEqual(shape, [["a", null, "graphite"], ["b", "a", "graphite"], ["c", "b", "git"]]);
  });
  await t.test("graphite's legacy refs fill in branches the database lacks", async () => {
    const repo = linearStack();
    writeGraphiteDb(repo, [["a", "main", repo.sha("main")]]);
    repo.writeRefBlob("refs/branch-metadata/b", JSON.stringify({ parentBranchName: "a", parentBranchRevision: repo.sha("a"), validationResult: "VALID" }));
    const { shape } = await stackOf(repo, { entry: "b" });
    assert.deepEqual(shape.slice(0, 2), [["a", null, "graphite"], ["b", "a", "graphite"]]);
  });
});

test("a record whose parent was amended says the branch needs a restack", async () => {
  const repo = linearStack();
  const oldA = repo.sha("a");
  setOrigin(repo, "b", "a", oldA);
  repo.git("checkout", "-q", "a");
  repo.git("commit", "-q", "--amend", "-m", "a, amended");
  const { entries } = await stackOf(repo, { entry: "b" });
  const b = entries.find((e) => e.id === "b");
  assert.deepEqual([b.parent, b.base, b.needsRestack], ["a", oldA, true]);
});

test("when two tools record a branch, the one that touched it last wins", async (t) => {
  await t.test("a rebase by one tool leaves the other's base out of the history", async () => {
    const repo = linearStack();
    writeGraphiteDb(repo, [["b", "a", repo.sha("a")]]);
    repo.git("checkout", "-q", "a");
    repo.commit("a moves", { "a2.txt": "x\n" });
    repo.git("checkout", "-q", "b");
    repo.git("rebase", "-q", "--onto", "a", "HEAD~1");
    setOrigin(repo, "b", "a", repo.sha("a"));
    const b = (await stackOf(repo, { entry: "b" })).entries.find((e) => e.id === "b");
    assert.deepEqual([b.source, b.needsRestack], ["origin", false]);
  });
  await t.test("among valid records, the base nearest the tip wins", async () => {
    const repo = linearStack();
    setOrigin(repo, "b", "main", repo.sha("main"));
    writeGraphiteDb(repo, [["b", "a", repo.sha("a")]]);
    const b = (await stackOf(repo, { entry: "b" })).entries.find((e) => e.id === "b");
    assert.deepEqual([b.source, b.parent], ["graphite", "a"]);
  });
  await t.test("a tie goes to the record that changed last", async () => {
    const repo = linearStack();
    repo.git("branch", "a-alias", "a");
    setOrigin(repo, "b", "a-alias", repo.sha("a"));
    writeGraphiteDb(repo, [["b", "a", repo.sha("a")]]);
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(path.join(repo.commonDir(), ".graphite_metadata.db"), later, later);
    const b = (await stackOf(repo, { entry: "b" })).entries.find((e) => e.id === "b");
    assert.deepEqual([b.source, b.parent], ["graphite", "a"]);
  });
  await t.test("--stack-source picks one tool", async () => {
    const repo = linearStack();
    setOrigin(repo, "b", "main", repo.sha("main"));
    writeGraphiteDb(repo, [["b", "a", repo.sha("a")]]);
    const b = (await stackOf(repo, { entry: "b", source: "origin" })).entries.find((e) => e.id === "b");
    assert.deepEqual([b.source, b.parent], ["origin", null]);
  });
});

test("a malformed record file is skipped, and the next source takes over", async () => {
  const repo = linearStack();
  writeGhStack(repo, "{ not json");
  const { shape } = await stackOf(repo, { entry: "b" });
  assert.deepEqual(shape[1], ["b", "a", "git"]);
});

test("loading a stack leaves the repo untouched", async () => {
  const repo = linearStack();
  setOrigin(repo, "b", "a", repo.sha("a"));
  writeGraphiteDb(repo, [["a", "main", repo.sha("main")]]);
  repo.write("dirty.txt", "uncommitted\n");
  const snapshot = () => ({
    refs: repo.git("for-each-ref"),
    config: fs.readFileSync(path.join(repo.commonDir(), "config"), "utf8"),
    index: fs.readFileSync(path.join(repo.commonDir(), "index")).toString("base64"),
    status: repo.git("status", "--porcelain"),
    files: fs.readdirSync(repo.commonDir()).sort(),
  });
  const before = snapshot();
  await stackOf(repo, { entry: "b" });
  assert.deepEqual(snapshot(), before);
});

test("the trunk and a detached HEAD are refused with a reason", async () => {
  const repo = linearStack();
  await assert.rejects(stackOf(repo, { entry: "main" }), /is the trunk/);
  repo.git("checkout", "-q", "--detach");
  await assert.rejects(stackOf(repo), /HEAD is detached/);
});
