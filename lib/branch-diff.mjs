/**
 * Produces the patch a stack entry shows: its base commit against its head
 * commit. Only commits are reviewed: edits on disk, staged or not, and
 * untracked files never show, so what the human comments on is exactly
 * what the branch holds.
 */
import { createHash } from "node:crypto";
import { DIFF_ARGS } from "./diff.mjs";
import { git } from "./git.mjs";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The patch for `entry`, from its base to its head: {patch, sha}. */
export async function branchDiff(repo, entry) {
  const patch = await git(repo.top, [...DIFF_ARGS, entry.base, entry.head]);
  return { patch, sha: sha256(patch) };
}
