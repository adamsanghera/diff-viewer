/**
 * Builds the stack a branch belongs to, whichever tool made it.
 *
 * Each stacking tool records, per branch, a parent branch and a base: the
 * parent commit the branch was last rebased onto. A branch can carry
 * records from several tools, and some of them go stale when another tool
 * rebases it. The record that counts is the one whose tool touched the
 * branch last. No tool timestamps its records per branch, so "last" is read
 * from the commits: a rebase drops the old base out of the branch's
 * history, which invalidates every other tool's record, and among records
 * still valid, the base nearest the branch's tip is the latest rebase.
 * Ties give the same diff; they go to the record whose file changed last,
 * then to SOURCE_ORDER.
 *
 * Branches with no valid record fall back to their git history: the
 * nearest commit below the tip that another local branch points at is the
 * parent, else the branch sits on trunk at its merge-base.
 *
 * Every git call here is bounded by a branch's own commits. Large repos
 * can hold hundreds of thousands of remote refs and hundreds of packs, so
 * listing refs by glob, decorating log output, or walking all branches
 * against trunk each took 20 s or more on a real monorepo.
 */
import { CommitReader } from "./commits.mjs";
import { git } from "./git.mjs";
import { localBranches } from "./repo.mjs";
import * as ghStack from "./sources/gh-stack.mjs";
import * as graphite from "./sources/graphite.mjs";
import * as origin from "./sources/origin.mjs";

export const SOURCES = [origin, ghStack, graphite];
const SOURCE_ORDER = SOURCES.map((s) => s.name);
const DEFAULT_TRUNKS = ["main", "master"];
// Bounds on the walk that finds branches stacked above another: no stack is
// this deep, and committer clocks on one machine disagree by less than this.
const MAX_WALK = 1000;
const CLOCK_SLACK_SECONDS = 86_400;

const warned = new Set();

/** A stack that cannot be built from what was asked for, worded for the person who asked. */
export class StackError extends Error {}

/** Reads every source's records. A source that fails is skipped with one warning per process. */
async function readAllRecords(repo, only) {
  const results = [];
  for (const source of SOURCES) {
    if (only && source.name !== only) continue;
    try {
      results.push(await source.readRecords(repo));
    } catch (err) {
      if (!warned.has(source.name)) console.error(`diffview: skipping ${source.name}'s stack records: ${err.message}`);
      warned.add(source.name);
    }
  }
  return results;
}

async function trunkName(repo, recorded, heads) {
  if (recorded) return recorded;
  const remoteHead = (await git(repo.top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowExit: [1, 128] })).trim();
  const fromRemote = remoteHead.replace(/^origin\//, "");
  if (fromRemote && heads.has(fromRemote)) return fromRemote;
  return DEFAULT_TRUNKS.find((name) => heads.has(name)) ?? null;
}

/**
 * The freshest copy of trunk: the local branch or any remote's, whichever
 * was committed last. A local trunk is often days behind, and merge-bases
 * against it would claim commits that already landed.
 */
async function freshestTrunkRef(repo, trunk) {
  const remotes = (await git(repo.top, ["remote"])).split("\n").filter(Boolean);
  const refs = [`refs/heads/${trunk}`, ...remotes.map((r) => `refs/remotes/${r}/${trunk}`)];
  const out = await git(repo.top, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(refname)", ...refs]);
  return out.trim() || null;
}

/** How far `base` sits below `tip`, or null when it is not in tip's history. */
async function distanceBelow(repo, base, tip) {
  try {
    const [behind, ahead] = (await git(repo.top, ["rev-list", "--left-right", "--count", `${base}...${tip}`])).trim().split(/\s+/).map(Number);
    return behind === 0 ? ahead : null;
  } catch {
    return null;
  }
}

/** Picks the record that touched the branch last, per the rule above, or null. */
async function pickRecord(repo, records, tip) {
  const valid = [];
  for (const record of records) {
    const distance = await distanceBelow(repo, record.base, tip);
    if (distance !== null) valid.push({ record, distance });
  }
  valid.sort(
    (a, b) =>
      a.distance - b.distance ||
      (b.record.recordedAt ?? 0) - (a.record.recordedAt ?? 0) ||
      SOURCE_ORDER.indexOf(a.record.source) - SOURCE_ORDER.indexOf(b.record.source),
  );
  return valid[0]?.record ?? null;
}

/**
 * The parent and base git history implies: the nearest commit below the tip
 * that another branch points at, searched down to the merge-base with
 * trunk. A branch found below another in its history shares that branch's
 * merge-base, so `mergeBase` can be passed in instead of computed; on a
 * repo with hundreds of packs each merge-base costs about a second.
 */
async function parentFromHistory(repo, { branch, tip, trunk, trunkRef, branchesAt, mergeBase }) {
  mergeBase ??= trunkRef ? (await git(repo.top, ["merge-base", tip, trunkRef], { allowExit: [1] })).trim() : "";
  const range = mergeBase ? [`${mergeBase}..${tip}`] : [tip];
  const commits = (await git(repo.top, ["log", "--first-parent", "--format=%H", ...range])).split("\n").filter(Boolean);
  for (const sha of commits.slice(1)) {
    const names = (branchesAt.get(sha) ?? []).filter((name) => name !== branch && name !== trunk);
    if (names.length) return { parent: names.sort()[0], base: sha, mergeBase };
  }
  return { parent: null, base: mergeBase || commits.at(-1), mergeBase };
}

/**
 * Loads the stack around `entry` (default: the checked-out branch). With
 * `source`, only that tool's records count. Returns {trunk, entries}, the
 * entries ordered bottom-up: ancestors from trunk, the branch, then every
 * branch stacked above it, depth first. Each entry is
 * {id, parent, base, head, source, needsRestack, pr, children}, with
 * `parent` null for a branch on trunk and `source` "git" for one placed by
 * its history. `needsRestack` says a branch's base is no longer its parent
 * branch's tip; branches on trunk never report it, since trunk moves all
 * day in a busy repo.
 */
export async function loadStack(repo, options = {}) {
  const reader = new CommitReader(repo.top);
  try {
    return await buildStack(repo, reader, options);
  } finally {
    reader.close();
  }
}

async function buildStack(repo, reader, { entry = repo.branch, source = null }) {
  if (!entry) throw new StackError("HEAD is detached. Check out a branch, or name one with --branch.");
  const heads = await localBranches(repo);
  if (!heads.has(entry)) throw new StackError(`No local branch named ${entry}.`);
  const results = await readAllRecords(repo, source);
  const trunk = await trunkName(repo, results.find((r) => r.trunk)?.trunk, heads);
  if (entry === trunk) throw new StackError(`${entry} is the trunk, so it has no diff of its own. Check out a branch stacked on it.`);
  const trunkRef = trunk && (await freshestTrunkRef(repo, trunk));

  const branchesAt = new Map();
  for (const [name, { sha }] of heads) {
    if (!branchesAt.has(sha)) branchesAt.set(sha, []);
    branchesAt.get(sha).push(name);
  }
  const recordsByBranch = new Map();
  const childrenNamed = new Map();
  for (const record of results.flatMap((r) => r.records)) {
    if (!heads.has(record.branch)) continue;
    if (!recordsByBranch.has(record.branch)) recordsByBranch.set(record.branch, []);
    recordsByBranch.get(record.branch).push(record);
    if (!childrenNamed.has(record.parent)) childrenNamed.set(record.parent, new Set());
    childrenNamed.get(record.parent).add(record.branch);
  }

  /**
   * Walks first parents down from `tip` to the first commit a local branch
   * other than trunk points at, giving up past commits older than `since`
   * or after MAX_WALK commits. Returns that commit, or null.
   */
  const firstBranchCommitBelow = async (tip, since) => {
    let commit = await reader.read(tip);
    for (let steps = 0; commit?.parents.length && steps < MAX_WALK; steps++) {
      commit = await reader.read(commit.parents[0]);
      if (!commit || commit.committedAt < since - CLOCK_SLACK_SECONDS) return null;
      if ((branchesAt.get(commit.sha) ?? []).some((name) => name !== trunk)) return commit.sha;
    }
    return null;
  };

  const resolved = new Map();
  const mergeBaseOf = new Map();
  const resolve = async (branch) => {
    if (resolved.has(branch)) return resolved.get(branch);
    const tip = heads.get(branch).sha;
    const record = await pickRecord(repo, recordsByBranch.get(branch) ?? [], tip);
    const fromHistory = !record && (await parentFromHistory(repo, { branch, tip, trunk, trunkRef, branchesAt, mergeBase: mergeBaseOf.get(branch) }));
    if (fromHistory) mergeBaseOf.set(branch, fromHistory.mergeBase);
    if (fromHistory?.parent && !mergeBaseOf.has(fromHistory.parent)) mergeBaseOf.set(fromHistory.parent, fromHistory.mergeBase);
    const placed = record ?? { ...fromHistory, source: "git", pr: null };
    const parent = placed.parent === trunk || !heads.has(placed.parent) ? null : placed.parent;
    const result = {
      id: branch,
      parent,
      base: placed.base,
      head: tip,
      source: placed.source,
      needsRestack: parent !== null && placed.base !== heads.get(parent).sha,
      pr: placed.pr,
      children: [],
    };
    resolved.set(branch, result);
    return result;
  };

  const ancestors = [];
  const seen = new Set([entry]);
  for (let at = (await resolve(entry)).parent; at && !seen.has(at); at = (await resolve(at)).parent) {
    seen.add(at);
    ancestors.unshift(await resolve(at));
  }

  // A child names this branch in a record, or its history reaches this
  // branch's tip before any other branch's. Only a branch committed no
  // earlier than this tip can have it in its history.
  const childrenOf = async (branch) => {
    const { sha, committedAt } = heads.get(branch);
    const candidates = new Set(childrenNamed.get(branch) ?? []);
    for (const [name, head] of heads) {
      if (head.committedAt >= committedAt && head.sha !== sha && (await firstBranchCommitBelow(head.sha, committedAt)) === sha) {
        candidates.add(name);
        if (mergeBaseOf.has(branch) && !mergeBaseOf.has(name)) mergeBaseOf.set(name, mergeBaseOf.get(branch));
      }
    }
    const children = [];
    for (const name of [...candidates].sort()) {
      if (name === branch || name === trunk || seen.has(name)) continue;
      if ((await resolve(name)).parent === branch) children.push(name);
    }
    return children;
  };

  const above = [];
  const climb = async (branch) => {
    const node = await resolve(branch);
    node.children = await childrenOf(branch);
    for (const child of node.children) {
      seen.add(child);
      above.push(await resolve(child));
      await climb(child);
    }
  };
  // Below the entry the stack is one path; an ancestor's other children belong to other stacks.
  const path = [...ancestors, await resolve(entry)];
  for (let i = 0; i + 1 < path.length; i++) path[i].children = [path[i + 1].id];
  await climb(entry);

  return { trunk, entries: [...path, ...above] };
}