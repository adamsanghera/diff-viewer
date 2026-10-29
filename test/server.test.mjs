import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { openStore } from "../lib/store.mjs";
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-writes-"));
  const started = await startServer({ dir: repo.dir, port: 4900, store: await openStore(home) });
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

test("static files cannot climb out of their folder", async () => {
  const repo = stackRepo();
  const { get } = await serve(repo);
  assert.equal((await get("/static/..%2f..%2fpackage.json")).status, 404);
  assert.equal((await get("/static/js/main.js")).status, 200);
});
