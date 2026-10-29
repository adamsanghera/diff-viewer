import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIFF_ARGS } from "../lib/diff.mjs";
import { normalizeDescription } from "../lib/descriptions.mjs";
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

/** Writes a description file in a folder of its own and returns its path. */
function descriptionFile(text, name = "description.md") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-desc-")), name);
  fs.writeFileSync(file, text);
  return file;
}

test("a description is the linked file, read as it is now, with its title from front matter", async () => {
  const store = await freshStore();
  assert.equal(store.description(REPO, ENTRY), null);
  const file = descriptionFile(`---\ntitle: Store descriptions\nowner: ignored\n---\n${DESC_V1}`);
  const linked = store.linkDescription(REPO, ENTRY, file, AGENT);
  assert.deepEqual([linked.path, linked.title, linked.body, linked.linkedBy], [file, "Store descriptions", DESC_V1, "agent"]);
  fs.writeFileSync(file, DESC_V1.replace("Add a table", "Add two tables"));
  assert.deepEqual([store.description(REPO, ENTRY).title, store.description(REPO, ENTRY).body.includes("two tables")], [null, true]);
  fs.rmSync(file);
  assert.deepEqual([store.description(REPO, ENTRY).missing, store.description(REPO, ENTRY).reason], [true, "no file there"]);
  const other = descriptionFile("Another file.\n");
  assert.equal(store.linkDescription(REPO, ENTRY, other, AGENT).body, "Another file.\n");
});

test("a comment on a description keeps the text it was made on, and follows its block through edits to the file", async () => {
  const store = await freshStore();
  const file = descriptionFile(DESC_V1);
  const { sha256 } = store.linkDescription(REPO, ENTRY, file, AGENT);
  const id = store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: sha256, quote: "Rebuild threads", body: "Why rebuild?", author: HUMAN });
  let t = store.thread(id).thread;
  assert.deepEqual([t.kind, t.state, t.heading, t.blockText, t.start, t.madeOn.seq], ["description", "current", "How", "- Rebuild threads.", 0, 1]);
  fs.writeFileSync(file, `Intro paragraph.\n\n${DESC_V1}`);
  t = store.thread(id).thread;
  assert.deepEqual([t.state, t.madeOn.seq], ["carried", 1]);
  fs.writeFileSync(file, DESC_V1.replace("Rebuild threads.", "Rebuild the threads table."));
  t = store.thread(id).thread;
  assert.deepEqual([t.state, t.blockText, t.nowReads?.text], ["outdated", "- Rebuild threads.", "- Rebuild the threads table."]);
  assert.equal(store.thread(id).descriptionPath, file);
  const withIntro = normalizeDescription({ title: null, body: `Intro paragraph.\n\n${DESC_V1}` }).sha256;
  assert.throws(
    () => store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: withIntro, quote: "Add a table", body: "x", author: HUMAN }),
    /changed since you opened it/,
    "a page showing text the file no longer holds, and no comment kept, is stale",
  );
  store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: sha256, quote: "Add a table", body: "x", author: HUMAN });
});

test("a stack description is found through any of its branches, as the stack grows on top and merges from the bottom", async () => {
  const store = await freshStore();
  const file = descriptionFile("---\ntitle: Auth rework\n---\nWhy the stack.\n");
  assert.equal(store.stackEntry(REPO, ["feat/a", "feat/b"]), null);
  const linked = store.linkStackDescription(REPO, ["feat/a", "feat/b"], file, AGENT);
  assert.deepEqual([linked.entry, linked.title], ["stack:feat/a", "Auth rework"]);
  assert.equal(store.stackEntry(REPO, ["feat/b"]), "stack:feat/a");

  assert.equal(store.linkStackDescription(REPO, ["feat/a", "feat/b", "feat/c"], file, AGENT).entry, "stack:feat/a");
  store.linkStackDescription(REPO, ["feat/b", "feat/c"], file, AGENT);
  assert.equal(store.stackEntry(REPO, ["feat/b", "feat/c"]), "stack:feat/a");
  assert.equal(store.stackEntry(REPO, ["feat/a"]), null, "a merged branch leaves the stack's members");

  const reused = store.linkStackDescription(REPO, ["feat/a", "feat/z"], descriptionFile("A new stack whose bottom reuses a merged name.\n"), AGENT);
  assert.equal(reused.entry, "stack:feat/a~2");
  assert.equal(store.stackEntry(REPO, ["feat/a", "feat/z"]), "stack:feat/a~2");
  assert.equal(store.stackEntry(REPO, ["feat/c"]), "stack:feat/a");
});

test("a thread on a stack's description sits on its empty diff, and the whole stack takes comments", async () => {
  const store = await freshStore();
  const { entry, sha256 } = store.linkStackDescription(REPO, ["feat/a", "feat/b"], descriptionFile("## Why\n\nShip auth in pieces.\n"), AGENT);
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

test("a branch's viewed mark is its own: set with its files, taken away without them", async () => {
  const store = await freshStore();
  assert.equal(store.branchViewedOn(REPO, ENTRY), null);
  store.setViewed(REPO, ENTRY, "app.js", "file-sha");
  assert.equal(store.branchViewedOn(REPO, ENTRY), null, "viewing a file does not mark the branch");
  store.setBranchViewed(REPO, ENTRY, { diffSha: "diff-1", files: [{ path: "app.js", sha: "file-sha-2" }, { path: "b.js", sha: "b-sha" }] });
  assert.equal(store.branchViewedOn(REPO, ENTRY), "diff-1");
  assert.deepEqual(store.viewed(REPO, ENTRY), { "app.js": "file-sha-2", "b.js": "b-sha" });
  store.setBranchViewed(REPO, ENTRY, null);
  assert.equal(store.branchViewedOn(REPO, ENTRY), null);
  assert.deepEqual(store.viewed(REPO, ENTRY), { "app.js": "file-sha-2", "b.js": "b-sha" }, "the files keep their marks");
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
  const { sha256 } = store.linkDescription(REPO, ENTRY, descriptionFile(DESC_V1), AGENT);
  store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: sha256, quote: "Add a table", body: "ok", author: HUMAN });
});

test("a version 3 store moves its descriptions into files and links them, and comments on them stay put", async () => {
  const home = tempHome();
  const before = await openStore(home);
  const { sha256 } = before.linkDescription(REPO, ENTRY, descriptionFile(DESC_V1), AGENT);
  const id = before.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: sha256, quote: "Add a table", body: "ok", author: HUMAN });
  before.close();
  // What a version 3 store held: descriptions as rows, and no links.
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(path.join(home, "diffview.sqlite3"));
  old.exec(`UPDATE descriptions SET title = 'Store descriptions', sha256 = '${normalizeDescription({ title: "Store descriptions", body: DESC_V1 }).sha256}';
    INSERT INTO descriptions (repo, entry, seq, title, body, sha256, author, author_kind, created_at)
      VALUES ('${REPO}', 'stack:${ENTRY}', 1, NULL, 'The stack.', 'x', 'agent', 'agent', 'x');
    DELETE FROM description_links;
    PRAGMA user_version = 3;`);
  old.close();

  const store = await openStore(home);
  const exported = path.join(home, "descriptions", "demo", "branches", "feat", "a.md");
  assert.equal(fs.readFileSync(exported, "utf8"), `---\ntitle: Store descriptions\n---\n\n${DESC_V1}`);
  assert.equal(store.description(REPO, ENTRY).path, exported);
  assert.equal(store.description(REPO, `stack:${ENTRY}`).path, path.join(home, "descriptions", "demo", "stacks", "feat", "a.md"));
  assert.equal(store.thread(id).thread.state, "current", "the exported file reads as the snapshot the comment was made on");
  store.close();
  assert.equal((await openStore(home)).description(REPO, ENTRY).path, exported, "a second open exports nothing again");
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
