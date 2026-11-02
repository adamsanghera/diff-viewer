/**
 * diffview's comment store, kept on peanut (~/mono/peanut): one SQLite file
 * in DIFFVIEW_HOME (default ~/.diffview) holding threads on branch diffs,
 * whole stacks, and their descriptions.
 *
 * peanut keeps the threads, messages, statuses, the human's pending batch
 * and the revisions threads were made on (lib/peanut-app.mjs says what
 * diffview's documents are). This module keeps the API the server and CLIs
 * were written against: a review is one stack entry (a branch, a jj change,
 * or a whole stack's description) in one repo, and its threads come back in
 * one list whichever of its two documents (its code, its description) they
 * are on.
 *
 * Nothing can rebuild this data, so it lives outside every repo, and
 * diffview never writes a repo. Deleting is permanent and human-only. A
 * human's pending messages stay hidden from every agent-facing read until
 * the batch is sent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnchorError as PeanutAnchorError, openStore as openPeanut, Registry, StoreError } from "peanut";
import { AnchorError } from "./anchors.mjs";
import { readDescriptionFile } from "./descriptions.mjs";
import {
  BLOCK,
  BRANCH,
  codeExcerpt,
  codeType,
  DESCRIPTION,
  descriptionContent,
  diffviewApp,
  documentKey,
  FILE,
  isStackEntry,
  LINES,
  parseKey,
  repoPrefix,
  STACK,
  WHOLE,
} from "./peanut-app.mjs";

export { isStackEntry, StoreError };

export const STATUS_LABELS = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

const STACK_PREFIX = "stack:";
const KIND_BY_ANCHOR = { [LINES]: "lines", [FILE]: "file", [WHOLE]: "branch", [BLOCK]: "description" };
const ANCHOR_BY_KIND = { lines: LINES, file: FILE, branch: WHOLE };
const DOCUMENT_TYPES = [BRANCH, STACK, DESCRIPTION];

/** The empty diff a stack entry's threads are made on: it has a description and no code of its own. */
export const STACK_SNAPSHOT = Object.freeze({ base: "", head: "", workingTree: false, patch: "" });

/** The folder holding the store: DIFFVIEW_HOME, or ~/.diffview. */
export function storeHome(env = process.env) {
  return env.DIFFVIEW_HOME || path.join(os.homedir(), ".diffview");
}

/** The name the human's messages carry: DIFFVIEW_USER, or the OS username. */
export function humanName(env = process.env) {
  return env.DIFFVIEW_USER || os.userInfo().username;
}

function now() {
  return new Date().toISOString();
}

/** Opens the store in `home`, creating it on first use. */
export async function openStore(home = storeHome()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let store = null;
  const registry = new Registry().register(diffviewApp({ linkedPath: (repo, entry) => store?.linkedPath(repo, entry) ?? null }));
  const peanut = await openPeanut({ registry, dir: home });
  store = new Store(peanut);
  return store;
}

/** A revision's meta, as diffview records it for a branch's patch. */
function snapshotMeta(repo, { base = "", head = "", workingTree = false }) {
  return { repo, base, head, workingTree: Boolean(workingTree) };
}

export class Store {
  #p;

  constructor(peanut) {
    this.#p = peanut;
  }

  close() {
    this.#p.close();
  }

  /** Changes whenever this process or another one writes to the store. */
  changeToken() {
    return this.#p.changeToken();
  }

  /** Calls `listener` after each write this process commits. Returns a function that stops it. */
  onWrite(listener) {
    return this.#p.onWrite(listener);
  }

  /** {repo, entry} when the entry has threads on its code or its description, else undefined. */
  findReview(repo, entry) {
    const key = documentKey(repo, entry);
    return DOCUMENT_TYPES.some((type) => this.#p.document(type, key)) ? { repo, entry } : undefined;
  }

  /** The entries with threads in `repo`, sorted. */
  trackedEntries(repo) {
    const prefix = repoPrefix(repo);
    return this.#p.db
      .prepare(
        `SELECT DISTINCT json_extract(key, '$[1]') AS entry FROM documents
         WHERE substr(key, 1, length(?)) = ? AND type IN (?, ?, ?) ORDER BY entry`,
      )
      .all(prefix, prefix, ...DOCUMENT_TYPES)
      .map((row) => row.entry);
  }

  /**
   * Records a tracked entry's `snapshot` ({base, head, workingTree, patch})
   * as a new version when its patch changed, and its description file as a
   * new description version when that changed. Returns {review, version},
   * or null for an entry whose code has no threads.
   */
  observe(repo, entry, snapshot) {
    const key = documentKey(repo, entry);
    const code = this.#p.observe(codeType(entry), key, { content: snapshot.patch, meta: snapshotMeta(repo, snapshot) });
    this.#p.observe(DESCRIPTION, key);
    return code ? { review: { repo, entry }, version: this.#versionInfo(code.revision, code.revision.seq) } : null;
  }

  /** The stored patch with hash `sha` for a tracked entry, or null. */
  patchForSha(repo, entry, sha) {
    return this.#p.contentForSha(codeType(entry), documentKey(repo, entry), sha);
  }

  /**
   * Starts a thread on what the commenter saw and returns its id. `kind` is
   * "lines" (with path, side, startLine, endLine) or "file" (with path) on
   * `snapshot`'s patch, "branch" for the whole entry, or "description" for
   * a block of the description that hashed to `descriptionSha` (by
   * `blockIndex`, or the one block holding `quote`). A `pending` thread stays
   * hidden from agents until the human sends the batch.
   */
  createThread({ repo, entry, snapshot, kind, path, side = "new", startLine, endLine, quote = "", start, descriptionSha, blockIndex, body, author, pending = false }) {
    if (!body?.trim()) throw new StoreError("A comment needs a message.");
    const key = documentKey(repo, entry);
    try {
      if (kind === "description") {
        return this.#p.createThread({
          type: DESCRIPTION,
          key,
          content: this.#descriptionSeen(repo, entry, descriptionSha),
          meta: { path: this.linkedPath(repo, entry) },
          anchorType: BLOCK,
          spec: { blockIndex, quote, start },
          body,
          author,
          pending,
        });
      }
      const anchorType = ANCHOR_BY_KIND[kind];
      if (!anchorType) throw new StoreError(`Unknown comment kind "${kind}".`);
      // A stack has no code of its own, so it holds no lines or files.
      if (isStackEntry(entry) && kind !== "branch") throw new StoreError(`${path} is not in this diff.`);
      return this.#p.createThread({
        type: codeType(entry),
        key,
        content: snapshot.patch,
        meta: snapshotMeta(repo, snapshot),
        anchorType,
        spec: { path, side, startLine, endLine, quote },
        body,
        author,
        pending,
      });
    } catch (err) {
      if (err instanceof AnchorError || err instanceof PeanutAnchorError) throw new StoreError(err.message);
      throw err;
    }
  }

  /** See peanut's Store.reply: a human reply to a suggested thread reopens it, and a reply to a draft joins the draft. */
  reply(threadId, body, author, options = {}) {
    this.#p.reply(threadId, body, author, options);
  }

  /** See peanut's Store.setStatus: agents suggest resolving, humans resolve and reopen. */
  setStatus(threadId, status, author, body, options = {}) {
    this.#p.setStatus(threadId, status, author, body, options);
  }

  /** Applies {reply: id, message} and {suggestResolve: id, message} actions in one transaction, all or none. */
  apply(actions, author) {
    this.#p.apply(actions, author);
  }

  /** How many messages wait in the human's unsent batch, across all reviews. */
  pendingCount() {
    return this.#p.pendingCount();
  }

  sendPending(author) {
    return this.#p.sendPending(author);
  }

  discardPending(author) {
    return this.#p.discardPending(author);
  }

  deleteThread(threadId, author) {
    this.#p.deleteThread(threadId, author);
  }

  deleteMessage(threadId, messageId, author) {
    this.#p.deleteMessage(threadId, messageId, author);
  }

  /**
   * Makes the Markdown file at `path` (absolute) an entry's description,
   * replacing any file linked before. Returns the description as the file
   * reads now.
   */
  linkDescription(repo, entry, path, author) {
    this.#p.write((db) => this.#link(db, repo, entry, path, author));
    return this.description(repo, entry);
  }

  /**
   * The entry of the stack description for a stack whose branches (bottom
   * first) are `branches`: the most recently linked one sharing any of them,
   * or null when none does.
   */
  stackEntry(repo, branches) {
    const row = this.#p.db
      .prepare(
        `SELECT m.stack FROM diffview_stack_members m JOIN diffview_description_links l ON l.repo = m.repo AND l.entry = m.stack
         WHERE m.repo = ? AND m.branch IN (SELECT value FROM json_each(?))
         ORDER BY l.linked_at DESC LIMIT 1`,
      )
      .get(repo, JSON.stringify(branches));
    return row?.stack ?? null;
  }

  /**
   * Links the file at `path` as the description of the stack made of
   * `branches` (bottom first), under the entry stackEntry() finds for them,
   * or a new one named for the bottom branch. Its members become `branches`.
   * Returns the description, with its `entry`.
   */
  linkStackDescription(repo, branches, path, author) {
    if (!branches.length) throw new StoreError("A stack needs at least one branch.");
    const entry = this.#p.write((db) => {
      const found = this.stackEntry(repo, branches) ?? this.#newStackEntry(repo, branches[0]);
      this.#link(db, repo, found, path, author);
      db.prepare("DELETE FROM diffview_stack_members WHERE repo = ? AND stack = ?").run(repo, found);
      const insert = db.prepare("INSERT INTO diffview_stack_members (repo, stack, branch) VALUES (?, ?, ?)");
      for (const branch of branches) insert.run(repo, found, branch);
      return found;
    });
    return { ...this.description(repo, entry), entry };
  }

  /**
   * An entry's description as its file reads now: {path, title, body,
   * sha256, editedAt, linkedBy, linkedAt}, or {path, missing, reason, ...}
   * when the file cannot be read; null when none is linked.
   */
  description(repo, entry) {
    const link = this.#p.db.prepare("SELECT * FROM diffview_description_links WHERE repo = ? AND entry = ?").get(repo, entry);
    if (!link) return null;
    return { ...readDescriptionFile(link.path), linkedBy: link.linked_by, linkedByKind: link.linked_by_kind, linkedAt: link.linked_at };
  }

  /** The absolute path of an entry's description file, or null when none is linked. */
  linkedPath(repo, entry) {
    return this.#p.db.prepare("SELECT path FROM diffview_description_links WHERE repo = ? AND entry = ?").get(repo, entry)?.path ?? null;
  }

  /** Per entry in `repo`: how many threads are unresolved, and how many of those wait on the human. Drafts count as unresolved. */
  countsByEntry(repo) {
    const prefix = repoPrefix(repo);
    const rows = this.#p.db
      .prepare(
        `SELECT json_extract(d.key, '$[1]') AS entry, sum(t.status != 'resolved') AS unresolved, sum(coalesce(f.waiting_on = 'human', 0)) AS your_turn
         FROM threads t JOIN thread_facts f ON f.thread_id = t.id JOIN documents d ON d.id = t.document_id
         WHERE substr(d.key, 1, length(?)) = ? AND d.type IN (?, ?, ?) GROUP BY entry`,
      )
      .all(prefix, prefix, ...DOCUMENT_TYPES);
    return Object.fromEntries(rows.map((row) => [row.entry, { unresolved: row.unresolved, yourTurn: row.your_turn }]));
  }

  /** Marks a file viewed as its diff reads now (`fileSha`), or with null, not viewed. */
  setViewed(repo, entry, path, fileSha) {
    this.#p.write((db) => {
      if (fileSha) {
        db.prepare(
          "INSERT INTO diffview_viewed_files (repo, entry, path, file_sha, viewed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET file_sha = excluded.file_sha, viewed_at = excluded.viewed_at",
        ).run(repo, entry, path, fileSha, now());
      } else {
        db.prepare("DELETE FROM diffview_viewed_files WHERE repo = ? AND entry = ? AND path = ?").run(repo, entry, path);
      }
    });
  }

  /**
   * Marks a branch viewed as a whole on the diff hashing to `diffSha`, or
   * with null, takes the mark away. The branch's files keep their own marks
   * either way.
   */
  setBranchViewed(repo, entry, diffSha) {
    this.#p.write((db) => {
      if (diffSha) {
        db.prepare(
          "INSERT INTO diffview_viewed_branches (repo, entry, diff_sha, viewed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET diff_sha = excluded.diff_sha, viewed_at = excluded.viewed_at",
        ).run(repo, entry, diffSha, now());
      } else {
        db.prepare("DELETE FROM diffview_viewed_branches WHERE repo = ? AND entry = ?").run(repo, entry);
      }
    });
  }

  /** The hash of the diff a branch was marked viewed on, or null when it is not marked. */
  branchViewedOn(repo, entry) {
    return this.#p.db.prepare("SELECT diff_sha FROM diffview_viewed_branches WHERE repo = ? AND entry = ?").get(repo, entry)?.diff_sha ?? null;
  }

  /** The files marked viewed on an entry: path to the file's diff hash when it was marked. */
  viewed(repo, entry) {
    const rows = this.#p.db.prepare("SELECT path, file_sha FROM diffview_viewed_files WHERE repo = ? AND entry = ?").all(repo, entry);
    return Object.fromEntries(rows.map((row) => [row.path, row.file_sha]));
  }

  /** One stored version of a tracked entry's code, with its patch, or null. */
  versionAt(repo, entry, seq) {
    const type = codeType(entry);
    const key = documentKey(repo, entry);
    const revision = this.#p.revisionAt(type, key, seq);
    return revision ? { ...this.#versionInfo(revision, this.#latestSeq(type, key)), patch: revision.content } : null;
  }

  /** A tracked entry's code versions, newest first, with how many threads each one started. */
  versions(repo, entry) {
    return this.#p.revisions(codeType(entry), documentKey(repo, entry)).map((r) => ({
      seq: r.seq,
      base: r.meta.base ?? "",
      head: r.meta.head ?? "",
      workingTree: Boolean(r.meta.workingTree),
      observedAt: r.observedAt,
      threads: r.threads,
    }));
  }

  /**
   * Ids of threads waiting on an agent in `repo`, on `entries` when given,
   * else on any entry, and with a sent message newer than message id `after`
   * when given. Cheap enough to run on every doorbell ring.
   */
  waitingOnAgent({ repo, entries = null, after = 0 }) {
    const filter = entries
      ? entries.flatMap((entry) => [
          { type: codeType(entry), key: documentKey(repo, entry) },
          { type: DESCRIPTION, key: documentKey(repo, entry) },
        ])
      : DOCUMENT_TYPES.map((type) => ({ type, keyPrefix: repoPrefix(repo) }));
    return this.#p.waitingOnAgent({ filter, after });
  }

  /**
   * Every thread on an entry: those on its code placed in the version whose
   * patch hashes to `sha` (or the latest), and those on its description in
   * the description that hashed to `descriptionSha` (or the file as it reads
   * now). Threads made after either are left out, and so are pending messages
   * unless `includePending` (the viewer) asks for them. Returns null when the
   * entry has no threads, or no version hashing to `sha`.
   */
  threadsAt(repo, entry, { sha, descriptionSha, includePending = false } = {}) {
    const key = documentKey(repo, entry);
    const type = codeType(entry);
    const code = this.#p.threadsAt(type, key, { sha, includePending });
    if (!code && sha && this.#p.document(type, key)) return null;
    const description = this.#descriptionThreads(repo, entry, descriptionSha, includePending);
    if (!code && !description) return null;
    const threads = [
      ...(code ? code.threads.map((t) => this.#codeView(t, code.revision, type, key)) : []),
      ...(description ? description.threads.map((t) => descriptionView(t)) : []),
    ].sort((a, b) => a.id - b.id);
    return {
      repo,
      entry,
      version: code ? this.#versionInfo(code.revision, this.#latestSeq(type, key)) : null,
      descriptionPath: this.linkedPath(repo, entry),
      threads,
    };
  }

  /** One thread, placed against its entry's latest version or its description as it reads now. A draft does not exist for agents. */
  thread(threadId, { includePending = false } = {}) {
    const { type, key } = this.#p.documentOf(threadId);
    const { repo, entry } = parseKey(key);
    const codeKind = codeType(entry);
    let view;
    if (type === DESCRIPTION) {
      this.#p.observe(DESCRIPTION, key);
      view = descriptionView(this.#p.thread(threadId, { includePending, excerpts: true }).thread);
    } else {
      const found = this.#p.thread(threadId, { includePending });
      view = this.#codeView(found.thread, found.revision, type, key);
    }
    const latestSeq = this.#latestSeq(codeKind, key);
    const latest = latestSeq === null ? null : this.#p.revisionAt(codeKind, key, latestSeq);
    return {
      repo,
      entry,
      version: latest ? this.#versionInfo(latest, latest.seq) : null,
      descriptionPath: this.linkedPath(repo, entry),
      thread: view,
    };
  }

  /** The repo and entry a thread belongs to, so callers can observe it before acting. */
  reviewOf(threadId) {
    return parseKey(this.#p.documentOf(threadId).key);
  }

  #link(db, repo, entry, path, author) {
    db.prepare(
      `INSERT INTO diffview_description_links (repo, entry, path, linked_by, linked_by_kind, linked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET path = excluded.path, linked_by = excluded.linked_by, linked_by_kind = excluded.linked_by_kind, linked_at = excluded.linked_at`,
    ).run(repo, entry, path, author.name, author.kind, now());
  }

  /** An entry for a new stack description: "stack:<bottom>", or "stack:<bottom>~2" and on when a merged stack had that bottom. */
  #newStackEntry(repo, bottom) {
    const taken = (entry) =>
      this.#p.db.prepare("SELECT 1 FROM diffview_description_links WHERE repo = ? AND entry = ?").get(repo, entry) || this.findReview(repo, entry);
    let entry = `${STACK_PREFIX}${bottom}`;
    for (let n = 2; taken(entry); n++) entry = `${STACK_PREFIX}${bottom}~${n}`;
    return entry;
  }

  /**
   * The description a new comment was typed against, as a revision's
   * content: the stored one hashing to `sha`, or else the file, which must
   * still read that way.
   */
  #descriptionSeen(repo, entry, sha) {
    const stored = sha && this.#p.contentForSha(DESCRIPTION, documentKey(repo, entry), sha);
    if (stored) return stored;
    const current = this.description(repo, entry);
    if (!current || current.missing || current.sha256 !== sha) throw new StoreError("The description changed since you opened it. Reload and select the text again.");
    return descriptionContent(current);
  }

  /**
   * Threads on an entry's description, placed in the stored description
   * hashing to `sha` (what a page rendered), else in the file as it reads
   * now (recorded first, if it changed), else, when the file cannot be read,
   * in the latest stored one.
   */
  #descriptionThreads(repo, entry, sha, includePending) {
    const key = documentKey(repo, entry);
    if (!this.#p.document(DESCRIPTION, key)) return null;
    const stored = sha && this.#p.contentForSha(DESCRIPTION, key, sha) !== null;
    if (!stored) this.#p.observe(DESCRIPTION, key);
    return this.#p.threadsAt(DESCRIPTION, key, { sha: stored ? sha : undefined, includePending, excerpts: true });
  }

  /** The newest revision's number for a document, or null for an untracked one. Reads no content. */
  #latestSeq(type, key) {
    return (
      this.#p.db
        .prepare("SELECT max(r.seq) AS seq FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.type = ? AND d.key = ?")
        .get(type, key)?.seq ?? null
    );
  }

  #versionInfo(revision, latestSeq) {
    return {
      seq: revision.seq,
      sha256: revision.sha256,
      base: revision.meta.base ?? "",
      head: revision.meta.head ?? "",
      workingTree: Boolean(revision.meta.workingTree),
      observedAt: revision.observedAt,
      latestSeq,
    };
  }

  /** A thread on an entry's code, in the shape the server and CLI read: placed in `revision`, or shown where it was when outdated. */
  #codeView(t, revision, type, key) {
    const kind = KIND_BY_ANCHOR[t.anchorType];
    const anchor = t.anchor;
    if (kind === "branch") {
      return {
        ...common(t, kind),
        side: null,
        path: null,
        startLine: null,
        endLine: null,
        state: t.state,
        madeOn: { seq: t.madeOn.seq, path: null, startLine: null, endLine: null },
        excerpt: [],
        nowReads: null,
      };
    }
    // An outdated thread is shown as it was, in the version it was made on.
    const shown = t.placement
      ? { revision, path: t.placement.path, startLine: t.placement.startLine, endLine: t.placement.endLine }
      : { revision: this.#p.revisionAt(type, key, t.madeOn.seq), path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine };
    return {
      ...common(t, kind),
      side: anchor.side,
      path: shown.path,
      startLine: shown.startLine,
      endLine: shown.endLine,
      state: t.state,
      madeOn: { seq: t.madeOn.seq, path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine },
      excerpt: shown.revision ? codeExcerpt(anchor, shown, shown.revision) : [],
      nowReads: t.state === "outdated" ? (t.nowReads?.placement ?? null) : null,
    };
  }
}

/** A thread's fields that do not depend on where it sits. */
function common(t, kind) {
  return {
    id: t.id,
    kind,
    status: t.status,
    pending: t.pending,
    waitingOn: t.waitingOn,
    quote: t.quote,
    statusBy: t.statusBy,
    statusAt: t.statusAt,
    createdAt: t.createdAt,
    messages: t.messages.map((m) => ({
      id: m.id,
      author: m.author,
      authorKind: m.authorKind,
      session: m.session,
      body: m.body,
      versionSeq: m.revisionSeq,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      pending: m.pending,
    })),
  };
}

/** A thread on a description, in the shape the server and CLI read, from a peanut view made with excerpts. */
function descriptionView(t) {
  const shown = t.placement ?? t.madeOn.placement;
  const made = t.madeOn.placement;
  const next = t.nowReads?.placement;
  return {
    ...common(t, "description"),
    path: null,
    side: null,
    start: t.anchor.start ?? null,
    excerpt: [],
    state: t.state,
    blockIndex: t.placement?.blockIndex ?? null,
    startLine: shown?.lines[0] ?? null,
    endLine: shown?.lines[1] ?? null,
    heading: shown ? shown.heading : null,
    blockText: t.excerpt?.text ?? null,
    madeOn: { seq: t.madeOn.seq, description: true, startLine: made?.lines[0] ?? null, endLine: made?.lines[1] ?? null },
    nowReads: next ? { blockIndex: next.blockIndex, startLine: next.lines[0], endLine: next.lines[1], text: t.nowReads.excerpt } : null,
  };
}

