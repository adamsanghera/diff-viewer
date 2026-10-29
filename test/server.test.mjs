import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { openStore } from "../lib/store.mjs";
import { until } from "./helpers/browser.mjs";
import { makeRepo } from "./helpers/repo.mjs";

/** main <- a <- b, with b checked out. */
function stackRepo() {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "a");
  repo.commit("a", { "a.txt": "one\n" });
  repo.git("checkout", "-q", "-b", "b");
  repo.commit("b", { "a.txt": "one\ntwo\n" });
  return repo;
}

const servers = [];
after(() => Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))));

async function serve(repo) {
  const started = await startServer({ dir: repo.dir, port: 4900 });
  servers.push(started);
  const get = async (path, headers = {}) => {
    const res = await fetch(`${started.url.replace(/\/$/, "")}${path}`, { headers });
    return { status: res.status, headers: res.headers, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  return { ...started, get };
}

test("the stack and a branch's committed diff", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  const stack = await get("/api/stack?branch=b");
  assert.deepEqual(stack.body.entries.map((e) => [e.id, e.parent]), [["a", null], ["b", "a"]]);
  assert.equal(stack.body.checkedOut, "b");
  const diff = await get("/api/diff?branch=a&stack=b");
  assert.deepEqual(diff.body.files.map((f) => [f.path, f.status, f.additions]), [["a.txt", "added", 1]]);
  assert.equal(diff.body.workingTree, false);
});

test("the checked-out branch shows uncommitted and untracked changes", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  const clean = await get("/api/diff?branch=b");
  assert.equal(clean.body.uncommitted, false);
  repo.write("a.txt", "one\ntwo\nthree\n");
  repo.write("new file.txt", "fresh\n");
  const dirty = await get("/api/diff?branch=b");
  assert.equal(dirty.body.uncommitted, true);
  assert.deepEqual(dirty.body.untracked, ["new file.txt"]);
  assert.deepEqual(dirty.body.files.map((f) => [f.path, f.additions]), [["a.txt", 2], ["new file.txt", 1]]);
  assert.notEqual(dirty.body.sha, clean.body.sha);
});

/** fetch() drops a Host header it is given, so a request naming another host goes through http. */
function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/api/info", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
}

test("requests naming another host, or other methods, are refused", async () => {
  const repo = stackRepo();
  const { get, url, port } = await serve(repo);
  assert.equal(await statusWithHost(port, "evil.example"), 403);
  assert.equal((await fetch(`${url}api/info`, { method: "PUT" })).status, 405);
  const unknown = await get("/api/diff?branch=nope");
  assert.deepEqual([unknown.status, unknown.body.error], [400, "No local branch named nope."]);
  const page = await get("/view");
  assert.match(page.headers.get("content-security-policy"), /script-src http:\/\/127\.0\.0\.1:\d+\/static\/js\/ http:\/\/127\.0\.0\.1:\d+\/vendor\//);
});

/** A server with a store of its own, and a post() that writes the way the page does. */
async function serveWithStore(repo) {
  return serveWithStoreAndHandle(repo);
}

/** As serveWithStore, also handing back the store, for writes an agent would make. */
async function serveWithStoreAndHandle(repo) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-writes-"));
  const store = await openStore(home);
  const started = { ...(await startServer({ dir: repo.dir, port: 4900, store })), store };
  servers.push(started);
  const origin = started.url.replace(/\/$/, "");
  const post = async (route, body, headers = { origin, "content-type": "application/json" }) => {
    const res = await fetch(`${origin}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (route) => (await fetch(`${origin}${route}`)).json();
  return { ...started, post, get, origin };
}

test("the page comments on lines, replies, resolves and marks files viewed", async () => {
  const repo = stackRepo();
  const { post, get } = await serveWithStore(repo);
  const diff = await get("/api/diff?branch=b");
  const created = await post("/api/comments", { branch: "b", sha: diff.sha, kind: "lines", path: "a.txt", side: "new", startLine: 2, endLine: 2, body: "Why **two**?" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { threads, pendingCount } = await get(`/api/comments?branch=b&sha=${diff.sha}`);
  assert.deepEqual([threads.length, threads[0].state, threads[0].startLine, pendingCount], [1, "current", 2, 0]);
  assert.match(threads[0].messages[0].bodyHtml, /<strong>two<\/strong>/);
  assert.equal((await post(`/api/comments/${created.body.id}/messages`, { body: "Pending reply", pending: true })).status, 200);
  assert.equal((await get(`/api/comments?branch=b&sha=${diff.sha}`)).pendingCount, 1);
  assert.equal((await post("/api/comments/batch/send", {})).body.sent, 1);
  assert.equal((await post(`/api/comments/${created.body.id}/status`, { status: "resolved" })).status, 200);
  await post("/api/viewed", { branch: "b", path: "a.txt", fileSha: diff.files[0].sha });
  assert.deepEqual((await get(`/api/comments?branch=b&sha=${diff.sha}`)).viewed, { "a.txt": diff.files[0].sha });
  await post("/api/viewed", { branch: "b", path: "a.txt", fileSha: null });
  assert.deepEqual((await get(`/api/comments?branch=b&sha=${diff.sha}`)).viewed, {});
});

test("writes from anywhere but the page, or not in JSON, are refused", async () => {
  const repo = stackRepo();
  const { post, get, origin } = await serveWithStore(repo);
  const diff = await get("/api/diff?branch=b");
  const body = { branch: "b", sha: diff.sha, kind: "branch", body: "hi" };
  assert.equal((await post("/api/comments", body, { "content-type": "application/json" })).status, 403);
  assert.equal((await post("/api/comments", body, { origin: "http://evil.example", "content-type": "application/json" })).status, 403);
  assert.equal((await post("/api/comments", body, { origin, "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/api/comments", { ...body, sha: "stale" })).status, 409);
  assert.equal((await post("/api/comments", { ...body, kind: "lines", path: "a.txt", startLine: 9 })).status, 400);
});

test("a stored version can be read back while the branch moves on", async () => {
  const repo = stackRepo();
  const { post, get } = await serveWithStore(repo);
  const v1 = await get("/api/diff?branch=b");
  await post("/api/comments", { branch: "b", sha: v1.sha, kind: "branch", body: "hi" });
  repo.write("a.txt", "one\ntwo\nthree\n");
  const now = await get("/api/diff?branch=b");
  assert.deepEqual(now.version, { seq: 2, latestSeq: 2 });
  const old = await get("/api/diff?branch=b&v=1");
  assert.deepEqual([old.sha, old.old, old.version.seq], [v1.sha, true, 1]);
  assert.deepEqual((await get("/api/versions?branch=b")).versions.map((v) => v.seq), [2, 1]);
});

test("a description renders from its file without raw HTML, and the page comments on its text", async () => {
  const repo = stackRepo();
  const { post, get, store, repo: served } = await serveWithStoreAndHandle(repo);
  assert.equal((await get("/api/description?branch=b")).description, null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-desc-")), "b.md");
  fs.writeFileSync(file, "---\ntitle: Two\n---\n## Why\n\nWe need *two*.\n\n<script>alert(1)</script>\n");
  const written = store.linkDescription(served.commonDir, "b", file, { name: "agent", kind: "agent" });
  const { description } = await get("/api/description?branch=b");
  assert.deepEqual([description.title, description.path], ["Two", file]);
  assert.match(description.html, /<h2 data-block="0">Why<\/h2>/);
  assert.match(description.html, /<p data-block="1">We need <em>two<\/em>\.<\/p>/);
  assert.doesNotMatch(description.html, /<script>/);
  const diff = await get("/api/diff?branch=b");
  const created = await post("/api/comments", { branch: "b", sha: diff.sha, kind: "description", descriptionSha: written.sha256, blockIndex: 1, quote: "need two", start: 3, body: "Why two?" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { threads } = await get(`/api/comments?branch=b&sha=${diff.sha}&descriptionSha=${written.sha256}`);
  assert.deepEqual([threads[0].kind, threads[0].state, threads[0].blockIndex, threads[0].start], ["description", "current", 1, 3]);
  assert.equal((await post("/api/comments", { branch: "b", sha: diff.sha, kind: "description", descriptionSha: "stale", blockIndex: 1, body: "x" })).status, 400);

  fs.rmSync(file);
  const missing = (await get("/api/description?branch=b")).description;
  assert.deepEqual([missing.missing, missing.reason, missing.html], [true, "no file there", undefined]);
});

test("an edit to a description file outside the repo reaches the page's live-reload stream", async () => {
  const repo = stackRepo();
  const { get, store, repo: served, port } = await serveWithStoreAndHandle(repo);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-desc-")), "b.md");
  fs.writeFileSync(file, "First.\n");
  store.linkDescription(served.commonDir, "b", file, { name: "agent", kind: "agent" });
  await get("/api/description?branch=b");
  const events = http.get({ host: "127.0.0.1", port, path: "/api/events" });
  try {
    const res = await new Promise((resolve) => events.on("response", resolve));
    let seen = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => (seen += chunk));
    fs.writeFileSync(file, "Second.\n");
    await until(() => seen.includes("event: change"), { what: "a change event for the description file" });
    assert.match((await get("/api/description?branch=b")).description.html, /Second\./);
  } finally {
    events.destroy();
  }
});

test("the doorbell rings when another process writes to the store", async () => {
  const repo = stackRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-doorbell-"));
  const started = await startServer({ dir: repo.dir, port: 4900, store: await openStore(home) });
  servers.push(started);
  const rang = new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: started.port, path: "/api/store-events" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => chunk.includes("event: change") && (res.destroy(), resolve(Date.now())));
    }).on("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const other = await openStore(home);
  const { patch } = await (await fetch(`${started.url}api/diff?branch=b`)).json();
  const wrote = Date.now();
  other.createThread({ repo: started.repo.commonDir, entry: "b", snapshot: { base: "x", head: "y", patch }, kind: "branch", body: "hi", author: { name: "adam", kind: "human" } });
  assert.ok((await rang) - wrote < 500);
});

test("API responses say how long their git commands and the whole request took", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  const timing = (await get("/api/diff?branch=a&stack=b")).headers.get("server-timing");
  const [, gitMs, calls, totalMs] = /^git;dur=([\d.]+);desc="(\d+) git calls", total;dur=([\d.]+)/.exec(timing) ?? [];
  assert.ok(Number(calls) > 0 && Number(gitMs) > 0 && Number(totalMs) > 0, timing);
  assert.match((await get("/api/info")).headers.get("server-timing"), /git;dur=[\d.]+;desc="1 git call"/);
});

/** Fetches a route and returns its Server-Timing's diff-cache result and git call count. */
async function cacheOf(url) {
  const timing = (await fetch(url)).headers.get("server-timing");
  return { cache: /diff-cache;desc="(\w+)"/.exec(timing)?.[1], gitCalls: Number(/(\d+) git call/.exec(timing)?.[1]) };
}

test("the checked-out branch's stack and diffs are computed at start, before any page asks", async () => {
  const repo = stackRepo();
  const { url, warmed } = await serve(repo);
  await warmed;
  for (const diff of [`${url}api/diff?branch=b`, `${url}api/diff?branch=a&stack=b`]) {
    assert.equal((await cacheOf(diff)).cache, "hit", diff);
  }
});

test("once warm, the stack carries each branch's size, so the sidebar needs no second request", async () => {
  const repo = stackRepo();
  const { url, warmed } = await serve(repo);
  await warmed;
  const { sizes } = await (await fetch(`${url}api/stack?branch=b`)).json();
  assert.deepEqual(Object.keys(sizes).sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(sizes.b).sort(), ["additions", "changed", "deletions", "files", "viewed"]);
});

test("after a file changes, the checked-out branch's diff is computed again ahead of the page", async () => {
  const repo = stackRepo();
  const { url, warmed } = await serve(repo);
  await warmed;
  repo.write("a.txt", "one\ntwo\nthree\n");
  const diff = `${url}api/diff?branch=b`;
  await until(async () => (await cacheOf(diff)).cache === "hit" && (await (await fetch(diff)).json()).files[0].additions === 2, {
    what: "the edited diff, computed ahead",
  });
});

test("requests that arrive while a diff is computed share that computation", async () => {
  const repo = stackRepo();
  repo.git("checkout", "-q", "-b", "elsewhere", "main");
  repo.commit("elsewhere", { "e.txt": "e\n" });
  repo.git("checkout", "-q", "b");
  const { url, warmed } = await serve(repo);
  await warmed;
  const diff = `${url}api/diff?branch=elsewhere`;
  const results = await Promise.all([cacheOf(diff), cacheOf(diff), cacheOf(diff)]);
  assert.deepEqual(results.map((r) => r.cache).sort(), ["hit", "hit", "miss"]);
});

test("fonts come from their packages, and /fonts/ serves nothing else", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  const font = await get("/fonts/inter/inter-latin-wght-normal.woff2");
  assert.deepEqual([font.status, font.headers.get("content-type")], [200, "font/woff2"]);
  assert.equal((await get("/fonts/express/index.js")).status, 404);
  assert.equal((await get("/fonts/inter/..%2F..%2F..%2Fpackage.json")).status, 404);
});

test("static files cannot climb out of their folder", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  assert.equal((await get("/static/..%2f..%2fpackage.json")).status, 404);
  assert.equal((await get("/static/js/main.js")).status, 200);
});
