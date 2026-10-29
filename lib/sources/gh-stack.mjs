/**
 * GitHub's `gh stack` extension (github/gh-stack) keeps every stack in one
 * JSON file, <common dir>/gh-stack: each stack is a trunk and an ordered
 * list of branches, each with `base`, its parent's head at the last sync.
 */
import fs from "node:fs";
import path from "node:path";
import { mtimeOf } from "../repo.mjs";

export const name = "gh-stack";

const STACK_FILE = "gh-stack";
const SCHEMA_VERSION = 1;

/** gh stack's records for this repo, and the trunk of its first stack. */
export async function readRecords(repo) {
  const file = path.join(repo.commonDir, STACK_FILE);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { trunk: null, records: [] };
    throw err;
  }
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error(`${file} has schema version ${data.schemaVersion}, not ${SCHEMA_VERSION}`);
  const recordedAt = mtimeOf(file);
  const records = [];
  for (const stack of data.stacks ?? []) {
    let parent = stack.trunk.branch;
    for (const b of stack.branches) {
      if (b.base) {
        const pr = b.pullRequest ? { number: b.pullRequest.number, url: b.pullRequest.url ?? null } : null;
        records.push({ branch: b.branch, parent, base: b.base, source: name, pr, recordedAt });
      }
      parent = b.branch;
    }
  }
  return { trunk: data.stacks?.[0]?.trunk.branch ?? null, records };
}
