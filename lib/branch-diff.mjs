/**
 * Produces the patch a stack entry shows: its base commit against its head
 * commit. Only commits are reviewed: edits on disk, staged or not, and
 * untracked files never show, so what the human comments on is exactly
 * what the branch holds.
 */
import { createHash } from "node:crypto";
import { DIFF_ARGS } from "./diff.mjs";
import { git } from "./git.mjs";

// Past this many changed files a diff cannot be reviewed in a browser, and in practice its base is wrong.
export const MAX_DIFF_FILES = 3000;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The patch for `entry`, from its base to its head: {patch, sha}. When it
 * changes more than `maxFiles` files it is not computed, and the result is
 * {tooLarge: {files, commits, base, head}} instead. Counting names first
 * compares trees without reading any file, so a base thousands of commits
 * too low costs seconds instead of gigabytes of patch.
 */
export async function branchDiff(repo, entry, { maxFiles = MAX_DIFF_FILES } = {}) {
  const names = await git(repo.top, ["diff", "--name-only", "-z", "--no-renames", entry.base, entry.head]);
  const files = names.split("\0").filter(Boolean).length;
  if (files > maxFiles) {
    const commits = Number((await git(repo.top, ["rev-list", "--count", `${entry.base}..${entry.head}`])).trim());
    return { tooLarge: { files, commits, base: entry.base, head: entry.head } };
  }
  const patch = await git(repo.top, [...DIFF_ARGS, entry.base, entry.head]);
  return { patch, sha: sha256(patch) };
}
