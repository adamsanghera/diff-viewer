/**
 * Origin (`origin stack`) records each branch's parent in git config:
 * branch.<b>.origin-parent, branch.<b>.origin-parent-sha (the base), and
 * branch.<b>.origin-change (its pull request number).
 */
import path from "node:path";
import { git } from "../git.mjs";
import { mtimeOf } from "../repo.mjs";

export const name = "origin";

const KEYS = { "origin-parent": "parent", "origin-parent-sha": "base", "origin-change": "change" };

/** Origin's records for this repo. It records no trunk of its own. */
export async function readRecords(repo) {
  // git config exits 1 when no key matches.
  const out = await git(repo.top, ["config", "--null", "--get-regexp", "^branch\\..*\\.origin-"], { allowExit: [1] });
  const byBranch = new Map();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    // Branch names may hold dots, so the variable is what follows the last one.
    const dot = key.lastIndexOf(".");
    const field = KEYS[key.slice(dot + 1)];
    if (!field) continue;
    const branch = key.slice("branch.".length, dot);
    if (!byBranch.has(branch)) byBranch.set(branch, { branch });
    byBranch.get(branch)[field] = value;
  }
  const recordedAt = mtimeOf(path.join(repo.commonDir, "config"));
  const records = [...byBranch.values()]
    .filter((r) => r.parent && r.base)
    .map(({ change, ...r }) => ({ ...r, source: name, pr: change ? { number: Number(change), url: null } : null, recordedAt }));
  return { trunk: null, records };
}
