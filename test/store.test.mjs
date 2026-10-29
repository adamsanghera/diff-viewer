import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIFF_ARGS } from "../lib/diff.mjs";
import { openStore } from "../lib/store.mjs";
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
