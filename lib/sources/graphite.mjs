/**
 * Graphite (`gt`) records each branch's parent in SQLite,
 * <common dir>/.graphite_metadata.db. Older versions kept a ref per branch,
 * refs/branch-metadata/<branch>, pointing at a JSON blob with the same
 * fields in camelCase; those still fill in branches the database lacks.
 * Only rows Graphite itself marks VALID count.
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "../git.mjs";
import { mtimeOf } from "../repo.mjs";

export const name = "graphite";

const DB_FILE = ".graphite_metadata.db";
const CONFIG_FILE = ".graphite_repo_config";
const PR_INFO_FILE = ".graphite_pr_info";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function fromDatabase(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT branch_name, parent_branch_name, parent_branch_revision FROM branch_metadata WHERE validation_result = 'VALID'")
      .all()
      .map((row) => ({ branch: row.branch_name, parent: row.parent_branch_name, base: row.parent_branch_revision }));
  } finally {
    db.close();
  }
}

/** Legacy refs, read in one call: %(raw) prints each blob, NUL-delimited. */
async function fromRefs(repo) {
  const out = await git(repo.top, ["for-each-ref", "refs/branch-metadata", "--format=%(refname)%00%(raw)%00"]);
  const parts = out.split("\0");
  const records = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const ref = parts[i].trim();
    let meta;
    try {
      meta = JSON.parse(parts[i + 1]);
    } catch {
      continue;
    }
    if (meta.validationResult && meta.validationResult !== "VALID") continue;
    records.push({ branch: ref.slice("refs/branch-metadata/".length), parent: meta.parentBranchName, base: meta.parentBranchRevision });
  }
  return records;
}

function pullRequests(repo) {
  const info = readJson(path.join(repo.commonDir, PR_INFO_FILE));
  const byBranch = new Map();
  for (const pr of info?.prInfos ?? []) {
    if (pr.headRefName) byBranch.set(pr.headRefName, { number: pr.prNumber, url: pr.url ?? null });
  }
  return byBranch;
}

/** Graphite's records for this repo, and its trunk. */
export async function readRecords(repo) {
  const dbFile = path.join(repo.commonDir, DB_FILE);
  const fromDb = mtimeOf(dbFile) === null ? [] : await fromDatabase(dbFile);
  const seen = new Set(fromDb.map((r) => r.branch));
  const legacy = (await fromRefs(repo)).filter((r) => !seen.has(r.branch));
  const prs = pullRequests(repo);
  const recordedAt = mtimeOf(dbFile);
  const records = [...fromDb, ...legacy]
    .filter((r) => r.parent && r.base)
    .map((r) => ({ ...r, source: name, pr: prs.get(r.branch) ?? null, recordedAt }));
  return { trunk: readJson(path.join(repo.commonDir, CONFIG_FILE))?.trunk ?? null, records };
}
