/**
 * Runs read-only git commands. diffview never writes a repo, so nothing
 * here takes a command that could: callers pass read verbs only, and the
 * repo-unchanged test holds them to it.
 */
import { execFile, execFileSync } from "node:child_process";
import { recordGit } from "./timing.mjs";

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** A git command that failed, with its stderr. `code` is git's exit status. */
export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Runs `git <args>` in `cwd` and resolves with its stdout, writing `input`
 * to its stdin when given. Optional locks are skipped, so a read never
 * contends with the user's own git.
 */
export function git(cwd, args, { allowExit = [], input } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        const elapsed = performance.now() - started;
        recordGit(elapsed);
        if (process.env.DIFFVIEW_TRACE) console.error(`git ${Math.round(elapsed)}ms: ${args.join(" ").slice(0, 160)}`);
        if (!err) return resolve(stdout);
        if (typeof err.code === "number" && allowExit.includes(err.code)) return resolve(stdout);
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new GitError(args, "output too large", `it printed more than ${MAX_OUTPUT_BYTES / 2 ** 20} MB`));
        reject(new GitError(args, err.code, stderr ?? ""));
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * The blob at `rev:filePath`, read synchronously. The comment store locates
 * threads while it holds no async context, and a commit's blob never changes,
 * so callers cache it. Null when the path is not in that commit, or is binary.
 */
export function readBlob(cwd, rev, filePath) {
  if (!cwd || !rev || !filePath) return null;
  try {
    const text = execFileSync("git", ["cat-file", "blob", `${rev}:${filePath}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/** Whether `ancestor` is reachable from `commit`. */
export async function isAncestor(cwd, ancestor, commit) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch (err) {
    if (err instanceof GitError && (err.code === 1 || err.code === 128)) return false;
    throw err;
  }
}
