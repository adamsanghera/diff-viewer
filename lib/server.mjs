import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { branchDiff, sha256 } from "./branch-diff.mjs";
import { parseDiff } from "./diff.mjs";
import { renderCommentBody } from "./render.mjs";
import { humanName, StoreError } from "./store.mjs";
import { git } from "./git.mjs";
import { localBranches, mtimeOf, openRepo } from "./repo.mjs";
import { loadStack, SOURCES, StackError } from "./stack.mjs";
import { VENDOR_DIR } from "./vendor.mjs";
import { watchRepo } from "./watch.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const NODE_MODULES = path.join(PUBLIC_DIR, "..", "node_modules");
// The page's fonts, served from their npm packages. Only these folders, so /fonts/ exposes nothing else under node_modules.
const FONT_DIRS = {
  inter: "@fontsource-variable/inter/files",
  "ibm-plex-mono": "@fontsource/ibm-plex-mono/files",
  "monaspace-neon": "@fontsource/monaspace-neon/files",
};
const HEARTBEAT_MS = 20_000;
const STORE_POLL_MS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const THREAD_ROUTE = /^\/api\/comments\/(\d+)\/(messages|status|delete)$/;
const MESSAGE_DELETE_ROUTE = /^\/api\/comments\/(\d+)\/messages\/(\d+)\/delete$/;
const HUMAN_STATUSES = new Set(["resolved", "open"]);
const PORT_ATTEMPTS = 20;
// Files whose changes mean a stack's records changed. Listed per source in lib/sources/.
const RECORD_FILES = [".graphite_metadata.db", "config", "gh-stack"];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), TYPES[".json"]);
}

/** Serves a file from `dir`, refusing paths that climb out of it. */
async function sendFrom(res, dir, rel, headers = {}) {
  const abs = path.resolve(dir, rel);
  if (path.relative(dir, abs).startsWith("..")) return send(res, 404, "not found");
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return send(res, 404, "not found");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(abs)] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      ...headers,
    });
    createReadStream(abs).pipe(res);
  } catch {
    send(res, 404, "not found");
  }
}

/**
 * The page's Content-Security-Policy. Diffs show other people's code and
 * agents act on comments made here, so only diffview's own scripts run.
 * Pierre's renderer puts its styles inline inside shadow roots, hence
 * 'unsafe-inline' for styles only.
 */
function pagePolicy(host) {
  return [
    "default-src 'self'",
    `script-src http://${host}/static/js/ http://${host}/vendor/`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * One repo under review. Stacks are slow to build on large repos, so each
 * is cached under a token that changes when any branch moves or any
 * stacking tool's records change.
 */
class Review {
  #stacks = new Map();

  constructor(repo, { source, store }) {
    this.repo = repo;
    this.source = source;
    this.store = store;
  }

  async #stackToken() {
    const heads = await localBranches(this.repo);
    const tips = [...heads].map(([name, head]) => `${name}=${head.sha}`).join("\n");
    const records = RECORD_FILES.map((file) => mtimeOf(path.join(this.repo.commonDir, file))).join(",");
    return `${tips}\n${records}`;
  }

  /** The branch checked out now; it changes when someone runs git checkout. */
  async checkedOut() {
    return (await git(this.repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] })).trim() || null;
  }

  async stack(branch, source = this.source) {
    const token = await this.#stackToken();
    const key = `${branch}\0${source ?? ""}`;
    const cached = this.#stacks.get(key);
    if (cached?.token === token) return cached.stack;
    const stack = await loadStack(this.repo, { entry: branch, source });
    this.#stacks.set(key, { token, stack });
    return stack;
  }

  async entry(branch, stackOf) {
    const stack = await this.stack(stackOf ?? branch);
    const entry = stack.entries.find((e) => e.id === branch);
    if (!entry) throw new HttpError(404, `${branch} is not in the stack of ${stackOf ?? branch}.`);
    return entry;
  }

  /**
   * A branch's diff as it is now, or its stored version `seq`, with a
   * summary of each file. Reading the current diff of a commented branch
   * records it as a version.
   */
  async diff(branch, stackOf, seq = null) {
    const entry = await this.entry(branch, stackOf);
    if (seq !== null) {
      const stored = this.store?.versionAt(this.repo.commonDir, branch, seq);
      if (!stored) throw new HttpError(404, `No version ${seq} of ${branch} is stored.`);
      const old = { base: stored.base, head: stored.head, patch: stored.patch, sha: stored.sha256, uncommitted: stored.workingTree, untracked: [] };
      return { entry: { ...entry, base: stored.base, head: stored.head }, workingTree: stored.workingTree, version: stored, old: seq !== stored.latestSeq, files: summarize(old.patch), ...old };
    }
    const workingTree = branch === (await this.checkedOut());
    const diff = await branchDiff(this.repo, entry, { workingTree });
    const version = this.#observe(entry, workingTree, diff.patch);
    return { entry, workingTree, version: version && { seq: version.seq, latestSeq: version.seq }, old: false, files: summarize(diff.patch), ...diff };
  }

  /** Threads on a branch, placed against the diff with hash `sha` that the page rendered. */
  comments(branch, sha) {
    const result = this.store.threadsAt(this.repo.commonDir, branch, { sha, includePending: true });
    const threads = (result?.threads ?? []).map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, bodyHtml: renderCommentBody(m.body) })) }));
    return { version: result?.version ?? null, threads, pendingCount: this.store.pendingCount(), viewed: this.store.viewed(this.repo.commonDir, branch) };
  }

  /**
   * Starts a thread on the diff the page rendered, named by its hash: the
   * current diff, or a stored version. A diff that moved on since, on a
   * branch that had no comments yet, is gone, and the page must reload.
   */
  async createThread(body, author) {
    const branch = String(body.branch ?? "");
    const current = await this.diff(branch, body.stack || undefined);
    const patch = current.sha === body.sha ? current.patch : this.store.patchForSha(this.repo.commonDir, branch, String(body.sha ?? ""));
    if (patch === null) throw new HttpError(409, "This branch's diff changed since you opened it.");
    return this.store.createThread({
      repo: this.repo.commonDir,
      entry: branch,
      snapshot: { base: current.entry.base, head: current.entry.head, workingTree: current.workingTree, patch },
      kind: body.kind,
      path: body.path ?? null,
      side: body.side ?? "new",
      startLine: body.startLine ?? null,
      endLine: body.endLine ?? null,
      quote: String(body.quote ?? ""),
      body: String(body.body ?? ""),
      author,
      pending: body.pending === true,
    });
  }

  /** Records a commented branch's patch as a version and returns it, logging instead of failing the page when the store cannot. */
  #observe(entry, workingTree, patch) {
    try {
      return this.store?.observe(this.repo.commonDir, entry.id, { base: entry.base, head: entry.head, workingTree, patch })?.version ?? null;
    } catch (err) {
      console.error(`diffview: could not record a version of ${entry.id}: ${err.message}`);
      return null;
    }
  }
}

/**
 * Each file in a patch, for the file list and headers. `sha` hashes what
 * the diff shows of the file, so a "viewed" mark can tell when it changed.
 */
function summarize(patch) {
  return parseDiff(patch).map((f) => ({
    path: f.newPath ?? f.oldPath,
    oldPath: f.oldPath,
    status: f.status,
    binary: f.binary,
    additions: f.additions,
    deletions: f.deletions,
    firstLine: f.hunks.flatMap((h) => h.lines).find((l) => l.kind !== "context")?.new ?? f.hunks[0]?.newStart ?? 1,
    sha: sha256(JSON.stringify([f.oldPath, f.newPath, f.status, f.oldMode, f.newMode, f.hunks.map((h) => h.lines.map((l) => l.kind[0] + l.text))])),
  }));
}

/**
 * Refuses writes that did not come from diffview's own page. Browsers send
 * Origin on every POST, and a cross-site JSON POST needs a CORS preflight
 * that diffview never approves, so together the two checks stop any other
 * site from posting comments through the browser, which agents would act on.
 */
function checkWriteRequest(req, allowedHosts) {
  let origin;
  try {
    origin = new URL(req.headers.origin ?? "");
  } catch {
    throw new HttpError(403, "Writes must come from diffview's own page.");
  }
  if (origin.protocol !== "http:" || !allowedHosts.has(origin.host)) throw new HttpError(403, "Writes must come from diffview's own page.");
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "Writes must be JSON.");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, "That request is too large."));
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new HttpError(400, "The request body is not JSON."));
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return reject(new HttpError(400, "The request body must be a JSON object."));
      resolve(body);
    });
    req.on("error", reject);
  });
}

async function handleWrite(req, res, pathname, { review, allowedHosts }) {
  if (!review.store) throw new HttpError(503, "Comments are off because the comment store did not open.");
  checkWriteRequest(req, allowedHosts);
  const body = await readJsonBody(req);
  const author = { name: humanName(), kind: "human", session: null };
  const store = review.store;

  if (pathname === "/api/comments") return sendJson(res, 201, { id: await review.createThread(body, author) });
  if (pathname === "/api/comments/batch/send") return sendJson(res, 200, { sent: store.sendPending(author) });
  if (pathname === "/api/comments/batch/discard") return sendJson(res, 200, { discarded: store.discardPending(author) });
  if (pathname === "/api/viewed") {
    if (typeof body.branch !== "string" || typeof body.path !== "string") throw new HttpError(400, "Name a branch and a path.");
    store.setViewed(review.repo.commonDir, body.branch, body.path, typeof body.fileSha === "string" ? body.fileSha : null);
    return sendJson(res, 200, {});
  }
  const messageMatch = MESSAGE_DELETE_ROUTE.exec(pathname);
  if (messageMatch) {
    store.deleteMessage(messageMatch[1], messageMatch[2], author);
    return sendJson(res, 200, { id: Number(messageMatch[1]) });
  }
  const match = THREAD_ROUTE.exec(pathname);
  if (!match) throw new HttpError(404, "not found");
  const [, id, action] = match;
  const pending = body.pending === true;
  if (action === "messages") store.reply(id, String(body.body ?? ""), author, { pending });
  else if (action === "delete") store.deleteThread(id, author);
  else {
    if (!HUMAN_STATUSES.has(body.status)) throw new HttpError(400, 'status must be "resolved" or "open".');
    store.setStatus(id, body.status, author, undefined, { pending });
  }
  return sendJson(res, 200, { id: Number(id) });
}

function changeTokenOf(store) {
  try {
    return store?.changeToken() ?? null;
  } catch {
    return null;
  }
}

/**
 * Rings every listener when the store changes: right after this viewer's own
 * writes, and within STORE_POLL_MS of writes from other processes, which
 * SQLite reports through PRAGMA data_version. It polls only while someone is
 * listening.
 */
function createDoorbell(store) {
  const listeners = new Set();
  let token = null;
  let timer = null;
  const ring = () => {
    token = changeTokenOf(store);
    for (const listener of listeners) listener();
  };
  store.onWrite(ring);
  return {
    listen(listener) {
      listeners.add(listener);
      if (!timer) {
        token = changeTokenOf(store);
        timer = setInterval(() => {
          if (changeTokenOf(store) !== token) ring();
        }, STORE_POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

/**
 * Streams a bare "change" event whenever the repo or the comment store may
 * have changed. Pages refetch what they show, and `diffview comments wait`
 * re-checks the store.
 */
function streamChanges(req, res, changes) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write("retry: 1500\n\n");
  const stop = changes.listen(() => res.write("event: change\ndata: \n\n"));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    stop();
    clearInterval(heartbeat);
  });
}

/** Watches the repo only while a page listens. */
function createChanges(repo) {
  const listeners = new Set();
  let stopWatching = null;
  return {
    listen(listener) {
      listeners.add(listener);
      stopWatching ??= watchRepo(repo, () => {
        for (const l of listeners) l();
      });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stopWatching();
          stopWatching = null;
        }
      };
    },
  };
}

function createHandler({ review, allowedHosts, initialBranch }) {
  const changes = createChanges(review.repo);
  const doorbell = review.store && createDoorbell(review.store);
  return async function handle(req, res) {
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, "forbidden host");
    const url = new URL(req.url, "http://localhost");
    const { pathname, searchParams } = url;
    if (req.method === "POST") return handleWrite(req, res, pathname, { review, allowedHosts });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");

    if (pathname === "/") {
      res.writeHead(302, { Location: "/view" });
      return res.end();
    }
    if (pathname === "/view") {
      return sendFrom(res, PUBLIC_DIR, "index.html", { "Content-Security-Policy": pagePolicy(req.headers.host) });
    }
    if (pathname.startsWith("/static/")) return sendFrom(res, PUBLIC_DIR, pathname.slice("/static/".length));
    if (pathname.startsWith("/vendor/")) return sendFrom(res, VENDOR_DIR, pathname.slice("/vendor/".length));
    if (pathname.startsWith("/fonts/")) {
      const [, , family, file] = pathname.split("/");
      if (!FONT_DIRS[family] || !file?.endsWith(".woff2")) return send(res, 404, "not found");
      return sendFrom(res, path.join(NODE_MODULES, FONT_DIRS[family]), file);
    }
    if (pathname === "/api/info") {
      return sendJson(res, 200, {
        repo: path.basename(review.repo.top),
        top: review.repo.top,
        checkedOut: await review.checkedOut(),
        initialBranch,
        sources: SOURCES.map((s) => s.name),
        comments: Boolean(review.store),
        user: review.store ? humanName() : null,
      });
    }
    if (pathname === "/api/stack") {
      const branch = searchParams.get("branch");
      if (!branch) throw new HttpError(400, "Name a branch.");
      const source = searchParams.get("source") || undefined;
      const comments = review.store?.countsByEntry(review.repo.commonDir) ?? {};
      return sendJson(res, 200, { ...(await review.stack(branch, source)), checkedOut: await review.checkedOut(), comments });
    }
    if (pathname === "/api/diff") {
      const branch = searchParams.get("branch");
      if (!branch) throw new HttpError(400, "Name a branch.");
      const seq = searchParams.get("v") ? Number(searchParams.get("v")) : null;
      return sendJson(res, 200, await review.diff(branch, searchParams.get("stack") || undefined, seq));
    }
    if (pathname === "/api/comments") {
      const branch = searchParams.get("branch");
      if (!branch) throw new HttpError(400, "Name a branch.");
      if (!review.store) return sendJson(res, 200, { version: null, threads: [], pendingCount: 0, viewed: {}, off: true });
      return sendJson(res, 200, review.comments(branch, searchParams.get("sha") || undefined));
    }
    if (pathname === "/api/versions") {
      const branch = searchParams.get("branch");
      return sendJson(res, 200, { versions: review.store && branch ? review.store.versions(review.repo.commonDir, branch) : [] });
    }
    if (pathname === "/api/events") return streamChanges(req, res, changes);
    if (pathname === "/api/store-events") {
      if (!doorbell) return send(res, 404, "comments are off");
      return streamChanges(req, res, doorbell);
    }
    return send(res, 404, "not found");
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Serves the review of the repo holding `dir` on 127.0.0.1, starting at
 * `port` and moving up past ports in use. The page opens on
 * `initialBranch`, by default the checked-out branch. Without a comment
 * `store`, the viewer is read-only.
 */
export async function startServer({ dir, initialBranch = null, source = null, port = 4645, store = null }) {
  const repo = await openRepo(dir);
  const review = new Review(repo, { source, store });
  const allowedHosts = new Set();
  const server = http.createServer();
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const candidate = port + attempt;
    try {
      await listen(server, candidate);
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${host}:${candidate}`);
      const handler = createHandler({ review, allowedHosts, initialBranch: initialBranch ?? repo.branch });
      server.on("request", (req, res) => {
        handler(req, res).catch((err) => {
          const status = err instanceof HttpError ? err.status : err instanceof StackError || err instanceof StoreError ? 400 : 500;
          if (!res.headersSent) sendJson(res, status, { error: String(err?.message ?? err) });
          else res.end();
        });
      });
      return { server, port: candidate, url: `http://127.0.0.1:${candidate}/`, repo };
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No free port in ${port}-${port + PORT_ATTEMPTS - 1}`);
}
