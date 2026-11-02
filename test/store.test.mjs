import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIFF_ARGS } from "../lib/diff.mjs";
import { normalizeDescription } from "../lib/descriptions.mjs";
import { openStore, STACK_SNAPSHOT } from "../lib/store.mjs";
import { openStore as openLegacyStore } from "./helpers/legacy-store.mjs";
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

test("a comment on unmodified lines follows the file's text into a later version", async () => {
  const repo = makeRepo();
  const baseText = lines(...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`));
  const headText = baseText.replace("line 38\n", "thirty-eight\n");
  const base = repo.commit("base", { "app.js": baseText });
  const head = repo.commit("head", { "app.js": headText });
  const snap = { base, head, workingTree: false, patch: repo.git(...DIFF_ARGS, base, head) + "\n" };
  const store = await freshStore();
  const common = repo.commonDir();
  const id = store.createThread({
    repo: common,
    entry: ENTRY,
    snapshot: snap,
    kind: "lines",
    path: "app.js",
    side: "new",
    startLine: 20,
    endLine: 20,
    body: "Leave this.",
    author: HUMAN,
  });
  assert.deepEqual(store.thread(id).thread.excerpt.filter((l) => l.marked).map((l) => l.text), ["line 20"]);
  const head2 = repo.commit("shift", { "app.js": `intro\n${headText}` });
  store.observe(common, ENTRY, { base, head: head2, workingTree: false, patch: repo.git(...DIFF_ARGS, base, head2) + "\n" });
  const carried = store.thread(id).thread;
  assert.deepEqual([carried.state, carried.startLine, carried.excerpt.find((l) => l.marked).text], ["carried", 21, "line 20"]);
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
  // A version read while the description was tracked is kept, as a branch's diff versions are, so a page that showed it can still comment on it.
  const withIntro = normalizeDescription({ title: null, body: `Intro paragraph.\n\n${DESC_V1}` }).sha256;
  store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: withIntro, quote: "Intro paragraph", body: "x", author: HUMAN });
  const neverRead = normalizeDescription({ title: null, body: "Text the file never held.\n" }).sha256;
  assert.throws(
    () => store.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: neverRead, quote: "Add a table", body: "x", author: HUMAN }),
    /changed since you opened it/,
    "a page showing text the store never saw and the file does not hold is stale",
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

test("a branch's viewed mark and its files' marks are independent", async () => {
  const store = await freshStore();
  assert.equal(store.branchViewedOn(REPO, ENTRY), null);
  store.setViewed(REPO, ENTRY, "app.js", "file-sha");
  assert.equal(store.branchViewedOn(REPO, ENTRY), null, "viewing a file does not mark the branch");
  store.setBranchViewed(REPO, ENTRY, "diff-1");
  assert.equal(store.branchViewedOn(REPO, ENTRY), "diff-1");
  assert.deepEqual(store.viewed(REPO, ENTRY), { "app.js": "file-sha" }, "marking the branch marks no file");
  store.setBranchViewed(REPO, ENTRY, null);
  assert.equal(store.branchViewedOn(REPO, ENTRY), null);
  assert.deepEqual(store.viewed(REPO, ENTRY), { "app.js": "file-sha" }, "the file keeps its mark");
});

/**
 * Fills a store kept by diffview before peanut with one of everything:
 * line threads outdated by later versions, a file thread,
 * a whole-branch thread, description threads across two snapshots, a stack
 * with a whole thread, a human's unsent batch, and viewed marks. Returns
 * what the old store said about it, to hold the import to.
 */
async function legacyStore(home) {
  const old = await openLegacyStore(home);
  const file = path.join(home, "feat-a.md");
  fs.writeFileSync(file, DESC_V1);
  const { sha256 } = old.linkDescription(REPO, ENTRY, file, AGENT);
  const ids = {
    sum: old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "lines", path: "app.js", side: "new", startLine: 3, endLine: 3, body: "Name it?", author: HUMAN }),
    exported: old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "lines", path: "app.js", side: "new", startLine: 4, endLine: 4, body: "Export more?", author: HUMAN }),
    file: old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "file", path: "app.js", body: "Split this file.", author: HUMAN }),
    branch: old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "branch", body: "Ship it?", author: HUMAN }),
    description: old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: sha256, quote: "Rebuild threads", body: "Why rebuild?", author: HUMAN }),
  };
  old.reply(ids.sum, "Sure.", AGENT);
  old.setStatus(ids.file, "suggested", AGENT, "Split it.");
  old.observe(REPO, ENTRY, V2_EDIT_ELSEWHERE);
  old.observe(REPO, ENTRY, { ...V3_EDIT_IT, patch: V3_EDIT_IT.patch.replace("export { c };", "export { c, a };") });
  fs.writeFileSync(file, `Intro paragraph.\n\n${DESC_V1}`);
  const later = normalizeDescription({ title: null, body: `Intro paragraph.\n\n${DESC_V1}` }).sha256;
  ids.later = old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "description", descriptionSha: later, quote: "Intro paragraph", body: "Needed?", author: HUMAN });
  old.reply(ids.description, "Still?", HUMAN, { pending: true });

  const stack = old.linkStackDescription(REPO, [ENTRY, "feat/b"], descriptionFile("## Why\n\nShip auth in pieces.\n"), AGENT);
  ids.stack = old.createThread({ repo: REPO, entry: stack.entry, snapshot: STACK_SNAPSHOT, kind: "branch", body: "Ship the stack.", author: HUMAN });
  old.setViewed(REPO, ENTRY, "app.js", "file-sha");
  old.setBranchViewed(REPO, ENTRY, "diff-sha");

  const said = {
    ids,
    stackEntry: stack.entry,
    branch: old.threadsAt(REPO, ENTRY, { includePending: true }),
    stack: old.threadsAt(REPO, stack.entry, { includePending: true }),
    waiting: old.waitingOnAgent({ repo: REPO }),
    counts: old.countsByEntry(REPO),
    viewed: old.viewed(REPO, ENTRY),
    branchViewed: old.branchViewedOn(REPO, ENTRY),
    pending: old.pendingCount(),
    versions: old.versions(REPO, ENTRY),
  };
  old.close();
  return said;
}

/**
 * A thread as both stores agree to show it. A message on a description
 * thread used to name the diff's version, and now names the description's,
 * so its seq is left out there.
 */
function comparable(t) {
  return { ...t, messages: t.messages.map((m) => (t.kind === "description" ? { ...m, versionSeq: undefined } : m)) };
}

test("a store kept before peanut is copied in once, with its ids, and reads as it did", async () => {
  const home = tempHome();
  const said = await legacyStore(home);
  const legacyFile = path.join(home, "diffview.sqlite3");
  const before = fs.readFileSync(legacyFile);

  const store = await openStore(home);
  const branch = store.threadsAt(REPO, ENTRY, { includePending: true });
  assert.deepEqual(branch.threads.map(comparable), said.branch.threads.map(comparable));
  assert.deepEqual(branch.version, said.branch.version);
  assert.deepEqual(branch.threads.map((t) => [t.id, t.kind, t.state]), [
    [said.ids.sum, "lines", "outdated"],
    [said.ids.exported, "lines", "outdated"],
    [said.ids.file, "file", "carried"],
    [said.ids.branch, "branch", "carried"],
    [said.ids.description, "description", "carried"],
    [said.ids.later, "description", "current"],
  ]);
  assert.deepEqual(store.threadsAt(REPO, said.stackEntry, { includePending: true }).threads.map(comparable), said.stack.threads.map(comparable));
  assert.deepEqual(store.waitingOnAgent({ repo: REPO }), said.waiting);
  assert.deepEqual(store.countsByEntry(REPO), said.counts);
  assert.deepEqual(store.viewed(REPO, ENTRY), said.viewed);
  assert.equal(store.branchViewedOn(REPO, ENTRY), said.branchViewed);
  assert.equal(store.pendingCount(), said.pending);
  // A diff version counts the threads made on the diff; description threads are on the description now, so they no longer count there.
  const descriptionThreads = [said.ids.description, said.ids.later].length;
  assert.deepEqual(
    store.versions(REPO, ENTRY),
    said.versions.map((v) => (v.seq === 1 ? { ...v, threads: v.threads - descriptionThreads } : v)),
  );
  assert.equal(store.stackEntry(REPO, ["feat/b"]), said.stackEntry);

  // New threads and messages take ids after the old ones.
  const next = comment(store);
  assert.ok(next > Math.max(...Object.values(said.ids)));
  store.close();

  assert.deepEqual(fs.readFileSync(legacyFile), before, "the old file is only read");
  const reopened = await openStore(home);
  assert.equal(reopened.threadsAt(REPO, ENTRY).threads.filter((t) => t.id === next).length, 1, "the import ran once");
});

test("when only the old store changed after the move, the move runs again and loses nothing", async () => {
  const home = tempHome();
  const said = await legacyStore(home);
  const first = await openStore(home);
  // Reading records revisions; that is not writing, and does not stop a second import.
  first.observe(REPO, ENTRY, V2_EDIT_ELSEWHERE);
  first.close();

  // An older diffview keeps writing the old file: a new thread, and a resolve.
  const old = await openLegacyStore(home);
  const late = old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "branch", body: "Made after the move.", author: HUMAN });
  old.setStatus(said.ids.file, "resolved", HUMAN);
  old.close();

  const warnings = [];
  const store = await openStore(home, { warn: (text) => warnings.push(text) });
  const threads = store.threadsAt(REPO, ENTRY).threads;
  assert.ok(threads.some((t) => t.id === late), "the thread made after the move came over, with its id");
  assert.equal(threads.find((t) => t.id === said.ids.file).status, "resolved");
  assert.match(warnings.join("\n"), /copied again/);
});

test("when both stores changed after the move, it says so and copies neither over the other", async () => {
  const home = tempHome();
  await legacyStore(home);
  const store = await openStore(home);
  const mine = comment(store);
  store.close();
  const old = await openLegacyStore(home);
  old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "branch", body: "Made after the move.", author: HUMAN });
  old.close();

  const warnings = [];
  const reopened = await openStore(home, { warn: (text) => warnings.push(text) });
  assert.ok(reopened.threadsAt(REPO, ENTRY).threads.some((t) => t.id === mine), "this store's own thread stays");
  assert.match(warnings.join("\n"), /has changed since too, so neither was copied/);
});

test("an import recorded without fingerprints runs again only when that loses nothing", async () => {
  const forget = async (home) => {
    // As an import made before fingerprints were recorded left it.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(home, "peanut.sqlite3"));
    db.exec("UPDATE diffview_imports SET legacy_mark = NULL, own_mark = NULL");
    db.close();
  };
  const grow = async (home) => {
    const old = await openLegacyStore(home);
    const id = old.createThread({ repo: REPO, entry: ENTRY, snapshot: V1, kind: "branch", body: "Made after the move.", author: HUMAN });
    old.close();
    return id;
  };

  const clean = tempHome();
  await legacyStore(clean);
  (await openStore(clean)).close();
  await forget(clean);
  const late = await grow(clean);
  assert.ok((await openStore(clean, { warn() {} })).threadsAt(REPO, ENTRY).threads.some((t) => t.id === late), "nothing was written here, so it imports again");

  const written = tempHome();
  await legacyStore(written);
  const store = await openStore(written);
  const mine = comment(store);
  store.close();
  await forget(written);
  await grow(written);
  const warnings = [];
  const reopened = await openStore(written, { warn: (text) => warnings.push(text) });
  assert.ok(reopened.threadsAt(REPO, ENTRY).threads.some((t) => t.id === mine), "a thread only this store has stays");
  assert.match(warnings.join("\n"), /neither was copied/);
});

test("a store from before version 5, or a peanut store that already has comments, is not imported into", async () => {
  const home = tempHome();
  const old = new (await import("node:sqlite")).DatabaseSync(path.join(home, "diffview.sqlite3"));
  old.exec("PRAGMA user_version = 3");
  old.close();
  await assert.rejects(openStore(home), /older diffview \(store version 3\)/);

  const busy = tempHome();
  const store = await openStore(busy);
  comment(store);
  store.close();
  await legacyStore(busy);
  await assert.rejects(openStore(busy), /already holds comments/);
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
