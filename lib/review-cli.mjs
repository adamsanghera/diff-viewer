/**
 * `diffview review`: hands the checked-out branch's stack to the human in
 * one command, for an agent to run in a background shell. It says what
 * still lacks a description, makes sure a viewer serves this checkout
 * (starting one that outlives the command, or reusing one), prints a link
 * to the stack, and then waits for comments as `diffview comments wait`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runComments } from "./comments-cli.mjs";
import { git } from "./git.mjs";
import { liveServers } from "./registry.mjs";
import { openRepo } from "./repo.mjs";
import { loadStack, StackError } from "./stack.mjs";
import { openStore, storeHome } from "./store.mjs";

const BIN = fileURLToPath(new URL("../bin/diffview.mjs", import.meta.url));
// A viewer builds its page bundle and the stack before it registers; on a large repo that takes seconds.
const VIEWER_START_TIMEOUT_MS = 60_000;
const VIEWER_POLL_MS = 100;

const USAGE = `Usage: diffview review [repo-dir] [--timeout 4h] [--after <n>] [--no-wait]

Hands the checked-out branch's stack to the human for review. diffview shows
only commits: commit everything first, since edits on disk, staged or not,
and untracked files never appear.

  1. Warns about uncommitted changes in the checkout, and lists the
     branches, and the stack, that have no description yet.
  2. Starts a viewer for this checkout, or finds the one already running,
     and prints a link to the stack (its Overview page when the stack has
     more than one branch). A viewer it starts keeps running afterwards.
  3. Waits for comments as diffview comments wait does, printing them in
     full and the --after to pass next time, unless --no-wait.

Run it in a background shell. It prints the link at once, then a status
line each minute while it waits.

Exit codes: 0 comments arrived (or --no-wait), 1 no viewer or no stack,
2 malformed command, 3 the wait timed out.
`;

function viewerFor(home, top) {
  return liveServers(home).find((s) => s.root === top && !s.source) ?? null;
}

/** Starts a viewer of `top` that outlives this process, and returns its registry entry once it serves. */
async function startViewer(home, top, env) {
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = path.join(logs, `viewer-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, top, "--no-open"], { detached: true, stdio: ["ignore", fd, fd], env });
  child.unref();
  fs.closeSync(fd);
  const deadline = Date.now() + VIEWER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const viewer = viewerFor(home, top);
    if (viewer) return { viewer, log };
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, VIEWER_POLL_MS));
  }
  throw new Error(`the viewer did not start; its output is in ${log}`);
}

/** Runs `diffview review <args>` and returns the exit code. */
export async function runReview(args, { out = process.stdout, err = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        timeout: { type: "string" },
        after: { type: "string" },
        "no-wait": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`diffview review: ${error.message}. See diffview review --help.\n`);
    return 2;
  }
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  const fail = (message, code = 1) => {
    err.write(`diffview review: ${message}\n`);
    return code;
  };
  if (positionals.length > 1) return fail(`takes one repo folder, not ${positionals.length}`, 2);
  const dir = path.resolve(cwd, positionals[0] ?? ".");
  const repo = await openRepo(dir).catch(() => null);
  if (!repo) return fail(`Not inside a git repo: ${dir}`, 2);
  if (!repo.branch) return fail("HEAD is detached. Check out the stack's top branch first.");
  let stack;
  try {
    stack = await loadStack(repo, { entry: repo.branch });
  } catch (error) {
    if (error instanceof StackError) return fail(error.message);
    throw error;
  }
  const branches = stack.entries.map((e) => e.id);
  const home = storeHome(env);

  const dirty = (await git(repo.top, ["status", "--porcelain"])).split("\n").filter(Boolean);
  if (dirty.length) {
    out.write(`Uncommitted changes in ${repo.top} (${dirty.length} ${dirty.length === 1 ? "path" : "paths"}) will not show: diffview shows only commits. Commit them first.\n`);
  }

  const store = await openStore(home);
  const undescribed = branches.filter((b) => !store.description(repo.commonDir, b) || store.description(repo.commonDir, b).missing);
  const stackUndescribed = branches.length > 1 && !store.stackEntry(repo.commonDir, branches);
  store.close();
  for (const branch of undescribed) out.write(`No description yet for ${branch}: diffview describe --branch ${branch} <file>\n`);
  if (stackUndescribed) out.write("No description yet for the stack: diffview describe --stack <file>\n");

  let viewer = viewerFor(home, repo.top);
  if (viewer) {
    out.write(`A viewer already serves ${repo.top} (pid ${viewer.pid}).\n`);
  } else {
    try {
      const started = await startViewer(home, repo.top, env);
      viewer = started.viewer;
      out.write(`Started a viewer of ${repo.top} (pid ${viewer.pid}; output in ${started.log}).\n`);
    } catch (error) {
      return fail(error.message);
    }
  }
  const page = branches.length > 1 ? new URLSearchParams({ stack: repo.branch, overview: "" }) : new URLSearchParams({ branch: repo.branch });
  out.write(`Review the stack of ${repo.branch} at\n  http://127.0.0.1:${viewer.port}/view?${page}\n`);
  if (values["no-wait"]) return 0;

  const waitArgs = ["wait", "-C", repo.top, "--timeout", values.timeout ?? "4h", ...(values.after ? ["--after", values.after] : [])];
  return runComments(waitArgs, { out, err, env });
}
