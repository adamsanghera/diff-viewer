/**
 * Produces the patch a stack entry shows: its base against its head, and
 * for the checked-out branch, against the working tree instead, untracked
 * files included, so uncommitted edits show up for review.
 */
import { createHash } from "node:crypto";
import { DIFF_ARGS } from "./diff.mjs";
import { git } from "./git.mjs";

// Untracked files are diffed one git process each, so a tree full of build
// output would take minutes. Past these limits the rest are listed by name.
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1024 * 1024;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function untrackedPatch(repo) {
  const files = (await git(repo.top, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  const patches = [];
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    // Exit 1 means the files differ, which is always the case against /dev/null.
    const patch = await git(repo.top, [...DIFF_ARGS, "--no-index", "--", "/dev/null", file], { allowExit: [1] });
    patches.push(patch.length > MAX_UNTRACKED_BYTES ? "" : patch);
  }
  return { patch: patches.join(""), untracked: files, skipped: files.slice(MAX_UNTRACKED_FILES) };
}

/**
 * The patch for `entry`. With `workingTree`, the head side is the files on
 * disk. Returns {patch, sha, uncommitted, untracked}: `uncommitted` says the
 * working tree differs from the branch's head commit, and `untracked` lists
 * the new files git does not track yet, which the patch includes.
 */
export async function branchDiff(repo, entry, { workingTree = false } = {}) {
  if (!workingTree) {
    const patch = await git(repo.top, [...DIFF_ARGS, entry.base, entry.head]);
    return { patch, sha: sha256(patch), uncommitted: false, untracked: [] };
  }
  const [tracked, untracked, changedSinceHead] = await Promise.all([
    git(repo.top, [...DIFF_ARGS, entry.base]),
    untrackedPatch(repo),
    git(repo.top, ["diff", "--name-only", "HEAD"]),
  ]);
  const patch = tracked + untracked.patch;
  const uncommitted = changedSinceHead.trim() !== "" || untracked.untracked.length > 0;
  return { patch, sha: sha256(patch), uncommitted, untracked: untracked.untracked };
}
