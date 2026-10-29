import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIFF_ARGS } from "../lib/diff.mjs";
import { openStore, STACK_SNAPSHOT } from "../lib/store.mjs";
import { makeRepo } from "./helpers/repo.mjs";

const HUMAN = { name: "adam", kind: "human" };
const AGENT = { name: "agent", kind: "agent", session: "s1" };
const REPO = "/repos/demo/.git";
const ENTRY = "feat/a";

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "diffview-store-"));
const lines = (...texts) => texts.join("\n") + "\n";

/** A snapshot of the diff from `base` to `head` file contents, as the server would observe it. */
function snapshot(base, head) {
  const repo = makeRepo();
  const from = repo.commit("base", { "app.js": base });
  const to = repo.commit("head", { "app.js": head });
  return { base: from, head: to, workingTree: false, patch: repo.git(...DIFF_ARGS, from, to) + "\n" };
}

const BASE = lines("const a = 1;", "const b = 2;");
const V1 = snapshot(BASE, lines("const a = 1;", "const b = 2;", "const c = a + b;", "export { c };"));
const V2_EDIT_ELSEWHERE = snapshot(BASE, lines("// header", "const a = 1;", "const b = 2;", "const c = a + b;", "export { c };"));
const V3_EDIT_IT = snapshot(BASE, lines("const a = 1;", "const b = 2;", "const c = add(a, b);", "export { c };"));

async function freshStore() {
  return openStore(tempHome());
}

function comment(store, snap = V1, extra = {}) {
  return store.createThread({
    repo: REPO,
    entry: ENTRY,
    snapshot: snap,
    kind: "lines",
    path: "app.js",
    side: "new",
    startLine: 3,
    endLine: 3,
    body: "Why not a helper?",
    author: HUMAN,
    ...extra,
  });
}

test("observing a review without threads records nothing", async () => {
  const store = await freshStore();
  assert.equal(store.observe(REPO, ENTRY, V1), null);
  assert.equal(store.threadsAt(REPO, ENTRY), null);
});

test("a first comment tracks the review, and changed patches add versions", async () => {
  const store = await freshStore();
  comment(store);
  assert.deepEqual(store.versions(REPO, ENTRY).map((v) => v.seq), [1]);
  store.observe(REPO, ENTRY, V1);
  assert.equal(store.versions(REPO, ENTRY).length, 1);
  store.observe(REPO, ENTRY, { ...V1, head: "other-head-same-patch" });
  assert.equal(store.versions(REPO, ENTRY).length, 1);
  store.observe(REPO, ENTRY, V2_EDIT_ELSEWHERE);
  assert.deepEqual(store.versions(REPO, ENTRY).map((v) => v.seq), [2, 1]);
});

test("threads carry over while their lines hold, and go outdated with a guess when they change", async () => {
  const store = await freshStore();
  const id = comment(store);
  store.observe(REPO, ENTRY, V2_EDIT_ELSEWHERE);
  const carried = store.thread(id).thread;
  assert.deepEqual([carried.state, carried.startLine, carried.madeOn.seq], ["carried", 4, 1]);
  assert.deepEqual(carried.excerpt.filter((l) => l.marked).map((l) => l.text), ["const c = a + b;"]);
  store.observe(REPO, ENTRY, V3_EDIT_IT);
  const outdated = store.thread(id).thread;
  assert.equal(outdated.state, "outdated");
  assert.deepEqual([outdated.startLine, outdated.excerpt.find((l) => l.marked).text], [3, "const c = a + b;"]);
  assert.deepEqual(outdated.nowReads, { path: "app.js", startLine: 3, endLine: 3, text: "const c = add(a, b);" });
});

test("threads are located against the version a tab rendered", async () => {
  const store = await freshStore();
  comment(store);
  store.observe(REPO, ENTRY, V3_EDIT_IT);
  const rendered = store.threadsAt(REPO, ENTRY, { sha: createHash("sha256").update(V1.patch).digest("hex") });
  assert.deepEqual([rendered.version.seq, rendered.version.latestSeq, rendered.threads[0].state], [1, 2, "current"]);
  assert.equal(store.threadsAt(REPO, ENTRY).threads[0].state, "outdated");
});

test("a comment on lines the diff does not show is refused", async () => {
  const store = await freshStore();
  assert.throws(() => comment(store, V1, { startLine: 1, endLine: 9 }), /not shown together/);
  assert.throws(() => comment(store, V1, { path: "nope.js" }), /not in this diff/);
  assert.equal(store.trackedEntries(REPO).length, 0, "a refused comment tracks nothing");
});

test("agents suggest resolving, and only humans resolve or reopen", async () => {
  const store = await freshStore();
  const id = comment(store);
  assert.throws(() => store.setStatus(id, "resolved", AGENT), /Only a human resolves/);
  assert.throws(() => store.setStatus(id, "suggested", AGENT), /Say what changed/);
  store.setStatus(id, "suggested", AGENT, "Extracted add().");
  assert.equal(store.thread(id).thread.waitingOn, "human");
  store.reply(id, "Not quite.", HUMAN);
  assert.deepEqual([store.thread(id).thread.status, store.thread(id).thread.waitingOn], ["open", "agent"]);
  store.setStatus(id, "resolved", HUMAN);
  assert.equal(store.thread(id).thread.waitingOn, null);
  store.setStatus(id, "open", HUMAN);
  assert.equal(store.thread(id).thread.messages.at(-1).body, "Reopened.");
});

test("apply answers several threads in one transaction, all or nothing", async () => {
  const store = await freshStore();
  const first = comment(store);
  const second = store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "file", path: "app.js", body: "Rename this file?", author: HUMAN });
  const branch = store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "branch", body: "Split this PR?", author: HUMAN });
  let rings = 0;
  store.onWrite(() => rings++);
  assert.throws(
    () => store.apply([{ reply: first, message: "ok" }, { suggestResolve: 999, message: "x" }], AGENT),
    /No thread #999/,
  );
  assert.equal(store.thread(first).thread.messages.length, 1, "a failed batch writes nothing");
  store.apply(
    [
      { reply: first, message: "Will do." },
      { suggestResolve: second, message: "Renamed." },
      { suggestResolve: branch, message: "Split into two." },
    ],
    AGENT,
  );
  assert.equal(rings, 1);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO }), []);
  assert.deepEqual([first, second, branch].map((id) => store.thread(id).thread.status), ["open", "suggested", "suggested"]);
  assert.throws(() => store.apply([{ resolve: first, message: "x" }], AGENT), /must name a thread/);
});

test("pending comments stay out of agent views until the batch is sent", async () => {
  const store = await freshStore();
  const id = comment(store, V1, { pending: true });
  assert.deepEqual(store.threadsAt(REPO, ENTRY).threads, []);
  assert.throws(() => store.reply(id, "hi", AGENT), /No thread/);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO }), []);
  assert.equal(store.pendingCount(), 1);
  store.sendPending(HUMAN);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO }), [id]);
});

test("waitingOnAgent stays inside its repo and entries", async () => {
  const store = await freshStore();
  const id = comment(store);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO }), [id]);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO, entries: [ENTRY] }), [id]);
  assert.deepEqual(store.waitingOnAgent({ repo: REPO, entries: ["other"] }), []);
  assert.deepEqual(store.waitingOnAgent({ repo: "/repos/other/.git" }), []);
});

test("only a human deletes, and a review's last thread takes its versions along", async () => {
  const store = await freshStore();
  const id = comment(store);
  store.reply(id, "answer", AGENT);
  const reply = store.thread(id).thread.messages[1].id;
  assert.throws(() => store.deleteThread(id, AGENT), /Only a human/);
  assert.throws(() => store.deleteMessage(id, store.thread(id).thread.messages[0].id, HUMAN), /Delete the thread instead/);
  store.deleteMessage(id, reply, HUMAN);
  store.deleteThread(id, HUMAN);
  assert.equal(store.findReview(REPO, ENTRY), undefined);
  assert.deepEqual(store.versions(REPO, ENTRY), []);
});

const DESC_V1 = "## Why\n\nThe store keeps every version.\n\n## How\n\n- Add a table.\n- Rebuild threads.\n";

test("a description keeps a version per change, and identical writes add none", async () => {
  const store = await freshStore();
  assert.equal(store.description(REPO, ENTRY), null);
  const v1 = store.setDescription(REPO, ENTRY, { title: "Store descriptions", body: DESC_V1 }, AGENT);
  assert.deepEqual([v1.seq, v1.title, v1.authorKind], [1, "Store descriptions", "agent"]);
  assert.equal(store.setDescription(REPO, ENTRY, { title: "Store descriptions", body: `${DESC_V1}\n\n` }, AGENT).seq, 1);
  store.setDescription(REPO, ENTRY, { title: "Store descriptions", body: DESC_V1.replace("Add a table", "Add two tables") }, AGENT);
  assert.deepEqual([store.description(REPO, ENTRY).seq, store.description(REPO, ENTRY, { seq: 1 }).body], [2, DESC_V1]);
  assert.throws(() => store.setDescription(REPO, ENTRY, { body: "  " }, AGENT), /needs text/);
});

test("a comment on a description follows its block, and goes outdated with a guess when the block changes", async () => {
  const store = await freshStore();
  const v1 = store.setDescription(REPO, ENTRY, { body: DESC_V1 }, AGENT);
  const id = store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: v1.sha256, quote: "Rebuild threads", body: "Why rebuild?", author: HUMAN });
  let t = store.thread(id).thread;
  assert.deepEqual([t.kind, t.state, t.heading, t.blockText, t.start], ["description", "current", "How", "- Rebuild threads.", 0]);
  store.setDescription(REPO, ENTRY, { body: `Intro paragraph.\n\n${DESC_V1}` }, AGENT);
  t = store.thread(id).thread;
  assert.deepEqual([t.state, t.madeOn.seq], ["carried", 1]);
  store.setDescription(REPO, ENTRY, { body: DESC_V1.replace("Rebuild threads.", "Rebuild the threads table.") }, AGENT);
  t = store.thread(id).thread;
  assert.deepEqual([t.state, t.blockText, t.nowReads?.text], ["outdated", "- Rebuild threads.", "- Rebuild the threads table."]);
  assert.throws(
    () => store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: "nope", quote: "x", body: "x", author: HUMAN }),
    /not stored/,
  );
});

test("a stack description is found through any of its branches, as the stack grows on top and merges from the bottom", async () => {
  const store = await freshStore();
  assert.equal(store.stackEntry(REPO, ["feat/a", "feat/b"]), null);
  const v1 = store.setStackDescription(REPO, ["feat/a", "feat/b"], { title: "Auth rework", body: "Why the stack." }, AGENT);
  assert.deepEqual([v1.entry, v1.seq, v1.title], ["stack:feat/a", 1, "Auth rework"]);
  assert.equal(store.stackEntry(REPO, ["feat/b"]), "stack:feat/a");

  const grown = store.setStackDescription(REPO, ["feat/a", "feat/b", "feat/c"], { body: "Why the stack, now with c." }, AGENT);
  assert.deepEqual([grown.entry, grown.seq], ["stack:feat/a", 2]);
  store.setStackDescription(REPO, ["feat/b", "feat/c"], { body: "feat/a merged." }, AGENT);
  assert.equal(store.stackEntry(REPO, ["feat/b", "feat/c"]), "stack:feat/a");
  assert.equal(store.stackEntry(REPO, ["feat/a"]), null, "a merged branch leaves the stack's members");
  assert.equal(store.description(REPO, "stack:feat/a").seq, 3);

  const reused = store.setStackDescription(REPO, ["feat/a", "feat/z"], { body: "A new stack whose bottom reuses a merged name." }, AGENT);
  assert.equal(reused.entry, "stack:feat/a~2");
  assert.equal(store.stackEntry(REPO, ["feat/a", "feat/z"]), "stack:feat/a~2");
  assert.equal(store.stackEntry(REPO, ["feat/c"]), "stack:feat/a");
});

test("a thread on a stack's description sits on its empty diff, and the whole stack takes comments", async () => {
  const store = await freshStore();
  const { entry, sha256 } = store.setStackDescription(REPO, ["feat/a", "feat/b"], { body: "## Why\n\nShip auth in pieces.\n" }, AGENT);
  const onText = store.createThread({ repo: REPO, entry, snapshot: STACK_SNAPSHOT, kind: "description", descriptionSha: sha256, quote: "in pieces", body: "How many?", author: HUMAN });
  const onStack = store.createThread({ repo: REPO, entry, snapshot: STACK_SNAPSHOT, kind: "branch", body: "Ship it.", author: HUMAN });
  const { threads } = store.threadsAt(REPO, entry);
  assert.deepEqual(
    threads.map((t) => [t.id, t.kind, t.state, t.heading ?? null]),
    [
      [onText, "description", "current", "Why"],
      [onStack, "branch", "current", null],
    ],
  );
  assert.deepEqual(store.waitingOnAgent({ repo: REPO, entries: [entry] }), [onText, onStack]);
});

test("a version 2 store gains description threads, keeping its threads, after a backup", async () => {
  const home = tempHome();
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(path.join(home, "diffview.sqlite3"));
  old.exec(`CREATE TABLE reviews (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, entry TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (repo, entry));
    CREATE TABLE versions (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, seq INTEGER NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL, working_tree INTEGER NOT NULL, sha256 TEXT NOT NULL, patch TEXT NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE threads (id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id), version_id INTEGER NOT NULL REFERENCES versions(id),
      kind TEXT NOT NULL CHECK (kind IN ('lines', 'file', 'branch')), path TEXT, side TEXT, start_line INTEGER, end_line INTEGER, lines_sha TEXT,
      ordinal INTEGER NOT NULL, repeats INTEGER NOT NULL, quote TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', status_by TEXT, status_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id), author TEXT NOT NULL, author_kind TEXT NOT NULL, body TEXT NOT NULL,
      version_id INTEGER NOT NULL, session TEXT, created_at TEXT NOT NULL, sent_at TEXT, pending INTEGER GENERATED ALWAYS AS (sent_at IS NULL) VIRTUAL);
    INSERT INTO reviews VALUES (1, '${REPO}', '${ENTRY}', 'x');
    INSERT INTO versions VALUES (1, 1, 1, 'b', 'h', 0, 'sha', ${JSON.stringify(V1.patch).replace(/^"|"$/g, "'").replace(/\\n/g, "\n")}, 'x');
    INSERT INTO threads (id, review_id, version_id, kind, ordinal, repeats, quote, created_at) VALUES (1, 1, 1, 'branch', 0, 0, '', 'x');
    INSERT INTO messages (thread_id, author, author_kind, body, version_id, created_at, sent_at) VALUES (1, 'adam', 'human', 'kept?', 1, 'x', 'x');
    PRAGMA user_version = 2;`);
  old.close();
  const store = await openStore(home);
  assert.equal(store.thread(1).thread.messages[0].body, "kept?");
  assert.equal(fs.readdirSync(path.join(home, "backups")).length, 1);
  const v1 = store.setDescription(REPO, ENTRY, { body: DESC_V1 }, AGENT);
  store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: v1.sha256, quote: "Add a table", body: "ok", author: HUMAN });
});

test("the change token moves on writes from any process, and not on reads", async () => {
  const home = tempHome();
  const viewer = await openStore(home);
  const cli = await openStore(home);
  const before = viewer.changeToken();
  viewer.threadsAt(REPO, ENTRY);
  assert.equal(viewer.changeToken(), before);
  comment(cli);
  assert.notEqual(viewer.changeToken(), before);
});
