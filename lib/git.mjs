/**
 * Runs read-only git commands. diffview never writes a repo, so nothing
 * here takes a command that could: callers pass read verbs only, and the
 * repo-unchanged test holds them to it.
 */
import { execFile } from "node:child_process";

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
 * Runs `git <args>` in `cwd` and resolves with its stdout. Optional
 * locks are skipped, so a read never contends with the user's own git.
 */
export function git(cwd, args, { allowExit = [] } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (process.env.DIFFVIEW_TRACE) console.error(`git ${Math.round(performance.now() - started)}ms: ${args.join(" ").slice(0, 160)}`);
        if (!err) return resolve(stdout);
        if (typeof err.code === "number" && allowExit.includes(err.code)) return resolve(stdout);
        reject(new GitError(args, err.code, stderr ?? ""));
      },
    );
  });
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
