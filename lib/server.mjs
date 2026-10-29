import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { branchDiff } from "./branch-diff.mjs";
import { parseDiff } from "./diff.mjs";
import { git } from "./git.mjs";
import { localBranches, mtimeOf, openRepo } from "./repo.mjs";
import { loadStack, SOURCES, StackError } from "./stack.mjs";
import { VENDOR_DIR } from "./vendor.mjs";
import { watchRepo } from "./watch.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const HEARTBEAT_MS = 20_000;
const STORE_POLL_MS = 100;
const PORT_ATTEMPTS = 20;
// Files whose changes mean a stack's records changed. Listed per source in lib/sources/.
const RECORD_FILES = [".graphite_metadata.db", "config", "gh-stack"];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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

  async diff(branch, stackOf) {
    const stack = await this.stack(stackOf ?? branch);
    const entry = stack.entries.find((e) => e.id === branch);
    if (!entry) throw new HttpError(404, `${branch} is not in the stack of ${stackOf ?? branch}.`);
    const workingTree = branch === (await this.checkedOut());
    const diff = await branchDiff(this.repo, entry, { workingTree });
    this.#observe(entry, workingTree, diff.patch);
    const files = parseDiff(diff.patch).map((f) => ({
      path: f.newPath ?? f.oldPath,
      oldPath: f.oldPath,
      status: f.status,
      binary: f.binary,
      additions: f.additions,
      deletions: f.deletions,
      firstLine: f.hunks.flatMap((h) => h.lines).find((l) => l.kind !== "context")?.new ?? f.hunks[0]?.newStart ?? 1,
    }));
    return { entry, workingTree, files, ...diff };
  }

  /** Records a commented branch's patch as a version, logging instead of failing the page when the store cannot. */
  #observe(entry, workingTree, patch) {
    try {
      this.store?.observe(this.repo.commonDir, entry.id, { base: entry.base, head: entry.head, workingTree, patch });
    } catch (err) {
      console.error(`diffview: could not record a version of ${entry.id}: ${err.message}`);
    }
  }
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
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    const url = new URL(req.url, "http://localhost");
    const { pathname, searchParams } = url;

    if (pathname === "/") {
      res.writeHead(302, { Location: "/view" });
      return res.end();
    }
    if (pathname === "/view") {
      return sendFrom(res, PUBLIC_DIR, "index.html", { "Content-Security-Policy": pagePolicy(req.headers.host) });
    }
    if (pathname.startsWith("/static/")) return sendFrom(res, PUBLIC_DIR, pathname.slice("/static/".length));
    if (pathname.startsWith("/vendor/")) return sendFrom(res, VENDOR_DIR, pathname.slice("/vendor/".length));
    if (pathname === "/api/info") {
      return sendJson(res, 200, {
        repo: path.basename(review.repo.top),
        top: review.repo.top,
        checkedOut: await review.checkedOut(),
        initialBranch,
        sources: SOURCES.map((s) => s.name),
      });
    }
    if (pathname === "/api/stack") {
      const branch = searchParams.get("branch");
      if (!branch) throw new HttpError(400, "Name a branch.");
      const source = searchParams.get("source") || undefined;
      return sendJson(res, 200, { ...(await review.stack(branch, source)), checkedOut: await review.checkedOut() });
    }
    if (pathname === "/api/diff") {
      const branch = searchParams.get("branch");
      if (!branch) throw new HttpError(400, "Name a branch.");
      return sendJson(res, 200, await review.diff(branch, searchParams.get("stack") || undefined));
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
          const status = err instanceof HttpError ? err.status : err instanceof StackError ? 400 : 500;
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
