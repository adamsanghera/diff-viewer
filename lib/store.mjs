/**
 * The comment store: one SQLite file per user holding threads on branch
 * diffs and the versions of those diffs they were made on.
 *
 * It follows mdview's comment store (~/code/mdview/lib/store.mjs), with a
 * branch's diff where mdview has a Markdown doc. A review is one stack
 * entry (a branch, a jj change, or a whole stack's description, whose diff
 * is always empty) in one repo, keyed by the repo's git
 * common dir and the entry's id, so every worktree of a repo shares it. A
 * review becomes tracked with its first thread. From then on, every
 * observe() records the entry's patch as a new version when it changed, so
 * each thread can say which version it was made on. Where a thread lands in
 * a later version is computed on read by locate(), never stored.
 *
 * Nothing can rebuild this data, so it lives outside every repo (in
 * DIFFVIEW_HOME, default ~/.diffview), and diffview never writes a repo.
 *
 * The viewer and any number of CLI processes share the file. WAL mode and a
 * busy timeout serialize their writes, and BEGIN IMMEDIATE keeps two writers
 * from claiming the same version number.
 *
 * Deleting is permanent and human-only. The CLI agents use has no delete
 * verb, so in practice only the viewer deletes.
 *
 * A human's messages can be pending, like comments in a GitHub review that is
 * not yet submitted: stored and shown in the viewer, but hidden from every
 * agent-facing read until the human sends the batch. A pending message has no
 * sent_at yet. Sending stamps them all in one transaction, so an agent sees
 * the whole batch at once. A thread is a draft while its first message is
 * pending, and anything added to a draft joins it.
 *
 * What is derived from messages (whether a thread is a draft, and whose turn
 * it is) is defined once, in the thread_facts view, and every reader uses it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anchoredTexts, anchorFor, AnchorError, excerpt, locate, nowReads } from "./anchors.mjs";
import { locate as locateBlock, normalizeText } from "./blocks.mjs";
import { formatDescription, readDescriptionFile } from "./descriptions.mjs";
import { parseDiff } from "./diff.mjs";
import { parseBlocks } from "./render.mjs";

const SCHEMA_VERSION = 4;
// The version that moved descriptions into files (exportDescriptions).
const FILE_DESCRIPTIONS_VERSION = 4;
const BUSY_TIMEOUT_MS = 5000;

// A thread is on a diff's lines, a file, the whole branch, or a block of the
// branch's description. Description threads anchor as mdview's do: the
// block's text hash and ordinal, and the quote with its offset.
const THREADS_TABLE = `CREATE TABLE threads (
  id             INTEGER PRIMARY KEY,
  review_id      INTEGER NOT NULL REFERENCES reviews(id),
  version_id     INTEGER NOT NULL REFERENCES versions(id),
  kind           TEXT NOT NULL CHECK (kind IN ('lines', 'file', 'branch', 'description')),
  path           TEXT,
  side           TEXT CHECK (side IN ('new', 'old')),
  start_line     INTEGER,
  end_line       INTEGER,
  lines_sha      TEXT,
  ordinal        INTEGER NOT NULL,   -- which repeat of identical lines, of how many (lib/anchors.mjs)
  repeats        INTEGER NOT NULL,
  quote          TEXT NOT NULL,
  description_id INTEGER REFERENCES descriptions(id),
  block_sha      TEXT,
  block_ordinal  INTEGER,
  quote_start    INTEGER,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'suggested', 'resolved')),
  status_by      TEXT,
  status_at      TEXT,
  created_at     TEXT NOT NULL
)`;
const V2_THREAD_COLUMNS = "id, review_id, version_id, kind, path, side, start_line, end_line, lines_sha, ordinal, repeats, quote, status, status_by, status_at, created_at";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,          -- realpath of the repo's git common dir
  entry      TEXT NOT NULL,          -- the branch name, or a jj change id
  created_at TEXT NOT NULL,
  UNIQUE (repo, entry)
);
CREATE TABLE IF NOT EXISTS versions (
  id           INTEGER PRIMARY KEY,
  review_id    INTEGER NOT NULL REFERENCES reviews(id),
  seq          INTEGER NOT NULL,     -- the "v7" people see
  base         TEXT NOT NULL,
  head         TEXT NOT NULL,
  working_tree INTEGER NOT NULL,     -- 1 when the head side was the files on disk
  sha256       TEXT NOT NULL,        -- of the patch
  patch        TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  UNIQUE (review_id, seq)
);
CREATE INDEX IF NOT EXISTS versions_by_sha ON versions (review_id, sha256);
${THREADS_TABLE.replace("CREATE TABLE threads", "CREATE TABLE IF NOT EXISTS threads")};
CREATE INDEX IF NOT EXISTS threads_by_review ON threads (review_id);
-- Where each entry's description lives: a Markdown file the agent owns and
-- edits (lib/descriptions.mjs). The store never writes it.
CREATE TABLE IF NOT EXISTS description_links (
  repo           TEXT NOT NULL,
  entry          TEXT NOT NULL,
  path           TEXT NOT NULL,      -- absolute
  linked_by      TEXT NOT NULL,
  linked_by_kind TEXT NOT NULL CHECK (linked_by_kind IN ('human', 'agent')),
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (repo, entry)
);
-- Snapshots of description files as they read when someone commented on
-- them, so a comment can say what its paragraph read and find it again after
-- edits. Before version 4 descriptions lived here, one row per write.
CREATE TABLE IF NOT EXISTS descriptions (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,
  entry       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  title       TEXT,
  body        TEXT NOT NULL,         -- Markdown
  sha256      TEXT NOT NULL,         -- of the title and body
  author      TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  session     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (repo, entry, seq)
);
-- The branches a stack description was written for, as of its latest write.
-- Stacks have no id in any tool, and they grow on top and merge from the
-- bottom, so a stack's description is found through any branch it shares.
CREATE TABLE IF NOT EXISTS stack_members (
  repo   TEXT NOT NULL,
  stack  TEXT NOT NULL,              -- the description's entry, "stack:<bottom branch when first written>"
  branch TEXT NOT NULL,
  PRIMARY KEY (repo, stack, branch)
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  author      TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  body        TEXT NOT NULL,
  version_id  INTEGER NOT NULL REFERENCES versions(id),
  session     TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,                  -- null while pending in the human's batch
  pending     INTEGER GENERATED ALWAYS AS (sent_at IS NULL) VIRTUAL
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (thread_id);
-- Files the human marked viewed. Keyed by repo and entry, not by review,
-- because marking a file viewed is not a comment and must not make a
-- review keep copies of its diff.
CREATE TABLE IF NOT EXISTS viewed_files (
  repo      TEXT NOT NULL,
  entry     TEXT NOT NULL,
  path      TEXT NOT NULL,
  file_sha  TEXT NOT NULL,           -- of the file's diff when it was marked viewed
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (repo, entry, path)
);

-- A thread's first message is the comment itself. Its turn goes by the last
-- sent word, except that a suggested thread waits on the human.
CREATE VIEW IF NOT EXISTS thread_facts AS
SELECT t.id AS thread_id,
       first.id AS first_message_id,
       first.sent_at IS NULL AS draft,
       CASE
         WHEN first.sent_at IS NULL OR t.status = 'resolved' OR last.author_kind IS NULL THEN NULL
         WHEN t.status = 'suggested' THEN 'human'
         WHEN last.author_kind = 'human' THEN 'agent'
         ELSE 'human'
       END AS waiting_on
FROM threads t
JOIN messages first ON first.id = (SELECT min(id) FROM messages WHERE thread_id = t.id)
LEFT JOIN messages last ON last.id = (
  SELECT id FROM messages WHERE thread_id = t.id AND sent_at IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT 1
);
`;
const THREAD_ROW = "SELECT t.*, f.first_message_id, f.draft, f.waiting_on FROM threads t JOIN thread_facts f ON f.thread_id = t.id";

// The statuses each kind of author may move a thread to, and from which.
// Agents can only say a thread is done. Humans resolve and reopen.
const TRANSITIONS = {
  agent: { suggested: ["open"] },
  human: { resolved: ["open", "suggested"], open: ["suggested", "resolved"] },
};

export const STATUS_LABELS = { open: "open", suggested: "suggested resolved", resolved: "resolved" };

// A stack's description and its threads live under an entry no branch can
// have, since git refuses ":" in ref names.
const STACK_PREFIX = "stack:";

/** Whether an entry is a stack's, not a branch's. */
export function isStackEntry(entry) {
  return entry.startsWith(STACK_PREFIX);
}

/** The empty diff a stack entry's threads are made on: it has a description and no code of its own. */
export const STACK_SNAPSHOT = Object.freeze({ base: "", head: "", workingTree: false, patch: "" });

/** A request the store refuses, worded for the person or agent who made it. */
export class StoreError extends Error {}

/** The folder holding the store: DIFFVIEW_HOME, or ~/.diffview. */
export function storeHome(env = process.env) {
  return env.DIFFVIEW_HOME || path.join(os.homedir(), ".diffview");
}

/** The name the human's messages carry: DIFFVIEW_USER, or the OS username. */
export function humanName(env = process.env) {
  return env.DIFFVIEW_USER || os.userInfo().username;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Opens the store in `home`, creating it on first use. node:sqlite loads
 * lazily, so a Node without it fails here instead of at import time.
 */
export async function openStore(home = storeHome()) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, "diffview.sqlite3"));
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db, home);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  if (userVersion(db) < FILE_DESCRIPTIONS_VERSION) exportDescriptions(db, home);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return new Store(db);
}

/** Where version 4 put the descriptions earlier versions stored: <home>/descriptions/<repo>/{branches,stacks}/<name>.md. */
function exportedDescriptionPath(home, repo, entry) {
  const repoName = path.basename(path.basename(repo) === ".git" ? path.dirname(repo) : repo);
  const [folder, name] = isStackEntry(entry) ? ["stacks", entry.slice(STACK_PREFIX.length)] : ["branches", entry];
  return path.join(home, "descriptions", repoName, folder, `${name}.md`);
}

/**
 * Version 4 moved descriptions out of the store into files. Each entry's
 * latest stored description is written to a file under <home>/descriptions
 * and linked; the stored rows stay, as the snapshots older comments were
 * made on. Under the write lock, re-checking, so two processes export once.
 */
function exportDescriptions(db, home) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const latest = db
      .prepare(
        `SELECT d.* FROM descriptions d
         WHERE d.seq = (SELECT max(seq) FROM descriptions WHERE repo = d.repo AND entry = d.entry)
           AND NOT EXISTS (SELECT 1 FROM description_links l WHERE l.repo = d.repo AND l.entry = d.entry)`,
      )
      .all();
    for (const row of latest) {
      const file = exportedDescriptionPath(home, row.repo, row.entry);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, formatDescription({ title: row.title, body: row.body }));
      db.prepare("INSERT INTO description_links (repo, entry, path, linked_by, linked_by_kind, linked_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        row.repo, row.entry, file, row.author, row.author_kind, now(),
      );
    }
    db.exec("COMMIT");
    if (latest.length) console.error(`diffview: descriptions now live in files; ${latest.length} moved to ${path.join(home, "descriptions")}`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const userVersion = (db) => db.prepare("PRAGMA user_version").get().user_version;

/**
 * Brings a store made by an older diffview up to SCHEMA_VERSION. Version 1
 * had a `viewed` table nothing wrote to. Version 3 widened the threads
 * table's kind CHECK, which SQLite cannot alter, so the table is rebuilt,
 * after a backup to <home>/backups when it holds threads. Runs with foreign
 * keys off, as SQLite's table-rebuild procedure requires, and under the
 * write lock, re-checking, so two processes migrate once.
 */
function migrate(db, home) {
  if (userVersion(db) >= SCHEMA_VERSION) return;
  const hasThreads = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get().n > 0;
  if (!hasThreads) return;
  const columns = db.prepare("SELECT name FROM pragma_table_info('threads')").all().map((c) => c.name);
  if (columns.includes("description_id")) return;
  if (db.prepare("SELECT count(*) AS n FROM threads").get().n > 0) backUp(db, home);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT name FROM pragma_table_info('threads')").all().some((c) => c.name === "description_id")) {
      db.exec("DROP TABLE IF EXISTS viewed");
      db.exec("DROP VIEW IF EXISTS thread_facts");
      db.exec(THREADS_TABLE.replace("CREATE TABLE threads", "CREATE TABLE threads_v3"));
      db.exec(`INSERT INTO threads_v3 (${V2_THREAD_COLUMNS}) SELECT ${V2_THREAD_COLUMNS} FROM threads`);
      db.exec("DROP TABLE threads");
      db.exec("ALTER TABLE threads_v3 RENAME TO threads");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function backUp(db, home) {
  const dir = path.join(home, "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `diffview-before-v${SCHEMA_VERSION}-${now().replace(/[:.]/g, "-")}.sqlite3`);
  db.prepare("VACUUM INTO ?").run(file);
  console.error(`diffview: upgrading the comment store; a copy of it is at ${file}`);
}

function now() {
  return new Date().toISOString();
}

// How alike (Dice coefficient over word sets) a new block must be to an
// outdated thread's old block to count as that block, edited. mdview's value.
const SUCCESSOR_SIMILARITY = 0.5;

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Guesses what an outdated description thread's block became: the most
 * similar block of the same kind among those new since its version, or
 * null when nothing is similar enough. From mdview's store.
 */
function successor(block, oldBlocks, newBlocks) {
  const kept = new Set(oldBlocks.map((b) => b.sha));
  const words = wordSet(block.text);
  let best = null;
  let bestScore = 0;
  for (const candidate of newBlocks) {
    if (candidate.kind !== block.kind || kept.has(candidate.sha)) continue;
    const other = wordSet(candidate.text);
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    const score = (2 * shared) / (words.size + other.size || 1);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= SUCCESSOR_SIMILARITY ? best : null;
}

function sourceLines(body, block) {
  return body.split("\n").slice(block.startLine - 1, block.endLine).join("\n");
}

function headingAbove(blocks, index) {
  for (let i = index - 1; i >= 0; i--) if (blocks[i].kind === "heading") return blocks[i].text;
  return null;
}

/** The block a CLI comment names: by index, or the one block holding `quote`. */
function pickBlock(blocks, { blockIndex, quote }) {
  if (Number.isInteger(blockIndex)) {
    const block = blocks[blockIndex];
    if (!block) throw new StoreError(`The description has no block ${blockIndex}.`);
    return block;
  }
  const needle = normalizeText(quote ?? "");
  if (!needle) throw new StoreError("Name the description's block by its index, or by a quote from it.");
  const hits = blocks.filter((b) => b.text.includes(needle));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new StoreError("The quote is not in the description.");
  throw new StoreError(`The quote appears in ${hits.length} blocks of the description. Quote more of it.`);
}

export class Store {
  #db;
  #writes = 0;
  #listeners = new Set();
  #parsed = new Map();

  constructor(db) {
    this.#db = db;
  }

  close() {
    this.#db.close();
  }

  /** Changes whenever this process or another one writes to the store. */
  changeToken() {
    return `${this.#db.prepare("PRAGMA data_version").get().data_version}:${this.#writes}`;
  }

  /** Calls `listener` after each write this process commits. Returns a function that stops it. */
  onWrite(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  findReview(repo, entry) {
    return this.#db.prepare("SELECT * FROM reviews WHERE repo = ? AND entry = ?").get(repo, entry);
  }

  /** The entries with threads in `repo`, sorted. */
  trackedEntries(repo) {
    return this.#db
      .prepare("SELECT entry FROM reviews WHERE repo = ? ORDER BY entry")
      .all(repo)
      .map((row) => row.entry);
  }

  /**
   * Records a tracked review's `snapshot` ({base, head, workingTree, patch})
   * as a new version when its patch changed. Returns {review, version}, or
   * null for an entry without threads.
   */
  observe(repo, entry, snapshot) {
    const review = this.findReview(repo, entry);
    if (!review) return null;
    return this.#transaction(() => ({ review, version: this.#recordVersion(review.id, snapshot) }));
  }

  /** The stored patch with hash `sha` for a tracked review, or null. */
  patchForSha(repo, entry, sha) {
    const review = this.findReview(repo, entry);
    return (review && this.#versionBySha(review.id, sha)?.patch) ?? null;
  }

  /**
   * Starts a thread on what the commenter saw, `snapshot` ({base, head,
   * workingTree, patch}), and returns its id. `kind` is "lines" (with
   * path, side, startLine, endLine), "file" (with path), or "branch". The
   * review becomes tracked if it was not already. A `pending` thread stays
   * hidden from agents until the human sends the batch.
   */
  createThread({ repo, entry, snapshot, kind, path, side = "new", startLine, endLine, quote = "", start, descriptionSha, blockIndex, body, author, pending = false }) {
    if (!body?.trim()) throw new StoreError("A comment needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    return this.#transaction(() => {
      const review = this.#findOrInsertReview(repo, entry);
      const version = this.#versionBySha(review.id, sha256(snapshot.patch)) ?? this.#recordVersion(review.id, snapshot);
      let anchor;
      let onDescription = { id: null, blockSha: null, blockOrdinal: null, start: null };
      if (kind === "description") {
        const description = this.#descriptionSnapshot(repo, entry, descriptionSha);
        const block = pickBlock(this.#descriptionBlocks(description), { blockIndex, quote });
        const offset = Number.isInteger(start) ? start : Math.max(0, block.text.indexOf(normalizeText(quote)));
        onDescription = { id: description.id, blockSha: block.sha, blockOrdinal: block.ordinal, start: offset };
        anchor = { kind, path: null, side: null, startLine: null, endLine: null, linesSha: null, ordinal: 0, repeats: 0 };
      } else {
        try {
          anchor = anchorFor(this.#filesOf(version), { kind, path, side, startLine, endLine });
        } catch (err) {
          if (err instanceof AnchorError) throw new StoreError(err.message);
          throw err;
        }
      }
      const thread = this.#db
        .prepare(
          `INSERT INTO threads (review_id, version_id, kind, path, side, start_line, end_line, lines_sha, ordinal, repeats, quote,
                                description_id, block_sha, block_ordinal, quote_start, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          review.id, version.id, anchor.kind, anchor.path, anchor.side, anchor.startLine, anchor.endLine, anchor.linesSha, anchor.ordinal, anchor.repeats, quote,
          onDescription.id, onDescription.blockSha, onDescription.blockOrdinal, onDescription.start, now(),
        );
      this.#insertMessage(thread.id, version.id, body, author, pending);
      this.#writes++;
      return thread.id;
    });
  }

  /**
   * Adds a message. A human reply to a suggested thread reopens it at once;
   * if the reply is `pending`, the thread still waits on the human until the
   * batch is sent. A reply to a draft thread is pending too, so no agent ever
   * sees a reply before the comment it answers.
   */
  reply(threadId, body, author, { pending = false } = {}) {
    if (!body?.trim()) throw new StoreError("A reply needs a message.");
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    this.#transaction(() => {
      const thread = this.#visibleThreadRow(threadId, author);
      this.#insertMessage(thread.id, this.#latestVersion(thread.review_id).id, body, author, pending || Boolean(thread.draft));
      if (author.kind === "human" && thread.status === "suggested") this.#updateStatus(thread.id, "open", author);
      this.#writes++;
    });
  }

  /**
   * Moves a thread to `status` if `author` may: agents suggest resolving,
   * which needs a message saying what changed, and humans resolve or reopen.
   * An optional `body` is added as a message first. A reopen without one
   * records "Reopened." so the thread shows it waits on the agent again.
   * With `pending`, that message joins the human's batch.
   */
  setStatus(threadId, status, author, body, { pending = false } = {}) {
    this.#transaction(() => this.#setStatus(threadId, status, author, body, { pending }));
  }

  #setStatus(threadId, status, author, body, { pending }) {
    if (pending && author.kind !== "human") throw new StoreError("Only a human batches comments.");
    if (!Object.hasOwn(STATUS_LABELS, status)) throw new StoreError(`Unknown status "${status}".`);
    const allowedFrom = TRANSITIONS[author.kind]?.[status];
    if (!allowedFrom) {
      throw new StoreError(
        author.kind === "agent"
          ? "Only a human resolves or reopens a thread. Use suggest-resolve to say it is done."
          : "Suggesting is for agents. Resolve the thread instead.",
      );
    }
    if (status === "suggested" && !body?.trim()) throw new StoreError("Say what changed when suggesting a thread is resolved.");
    const thread = this.#visibleThreadRow(threadId, author);
    if (thread.status === status) throw new StoreError(`Thread #${thread.id} is already ${STATUS_LABELS[status]}.`);
    if (!allowedFrom.includes(thread.status)) {
      throw new StoreError(`Thread #${thread.id} is ${STATUS_LABELS[thread.status]}, so it cannot become ${STATUS_LABELS[status]}.`);
    }
    const message = body?.trim() || (status === "open" ? "Reopened." : "");
    if (message) this.#insertMessage(thread.id, this.#latestVersion(thread.review_id).id, message, author, pending || Boolean(thread.draft));
    this.#updateStatus(thread.id, status, author);
    this.#writes++;
  }

  /**
   * Applies a list of agent actions in one transaction, all or none:
   * {reply: id, message} and {suggestResolve: id, message}. One write wakes
   * the viewer once, however many threads it answers.
   */
  apply(actions, author) {
    if (!Array.isArray(actions) || !actions.length) throw new StoreError("Give a non-empty list of actions.");
    this.#transaction(() => {
      actions.forEach((action, i) => {
        const where = `Action ${i + 1}`;
        if (typeof action?.message !== "string" || !action.message.trim()) throw new StoreError(`${where} needs a message.`);
        if (Number.isInteger(action.reply)) {
          const thread = this.#visibleThreadRow(action.reply, author);
          this.#insertMessage(thread.id, this.#latestVersion(thread.review_id).id, action.message, author, false);
          this.#writes++;
        } else if (Number.isInteger(action.suggestResolve)) {
          this.#setStatus(action.suggestResolve, "suggested", author, action.message, { pending: false });
        } else {
          throw new StoreError(`${where} must name a thread with "reply" or "suggestResolve".`);
        }
      });
    });
  }

  /** How many messages wait in the human's unsent batch, across all reviews. */
  pendingCount() {
    return this.#db.prepare("SELECT count(*) AS n FROM messages WHERE sent_at IS NULL").get().n;
  }

  /**
   * Sends every pending message in one transaction and returns how many went.
   * Each takes a send time later than every sent message, so a reply drafted
   * before an agent's answer still reads as the latest word, even when both
   * land in the same millisecond.
   */
  sendPending(author) {
    if (author.kind !== "human") throw new StoreError("Only a human sends a batch.");
    return Number(
      this.#transaction(() => {
        const latest = this.#db.prepare("SELECT max(sent_at) AS at FROM messages").get().at;
        const at = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();
        const changes = this.#db.prepare("UPDATE messages SET sent_at = ? WHERE sent_at IS NULL").run(at).changes;
        if (changes) this.#writes++;
        return changes;
      }),
    );
  }

  /** Deletes every pending message, and every thread that was only a draft. Returns how many messages went. */
  discardPending(author) {
    if (author.kind !== "human") throw new StoreError("Only a human discards a batch.");
    return Number(
      this.#transaction(() => {
        const drafts = this.#db.prepare("SELECT t.id, t.review_id FROM threads t JOIN thread_facts f ON f.thread_id = t.id WHERE f.draft").all();
        const count = this.#db.prepare("DELETE FROM messages WHERE sent_at IS NULL").run().changes;
        for (const draft of drafts) this.#deleteThreadRows(draft.id, draft.review_id);
        if (count) this.#writes++;
        return count;
      }),
    );
  }

  /**
   * Permanently deletes a thread and its messages. Only a human may. When it
   * was the review's last thread, its stored versions go too, because only
   * reviews with threads keep copies.
   */
  deleteThread(threadId, author) {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      this.#deleteThreadRows(thread.id, thread.review_id);
      this.#writes++;
    });
  }

  /** Permanently deletes one reply. Only a human may. The first message goes only with its thread. */
  deleteMessage(threadId, messageId, author) {
    if (author.kind !== "human") throw new StoreError("Only a human deletes comments.");
    this.#transaction(() => {
      const thread = this.#threadRow(threadId);
      const message = this.#db.prepare("SELECT id FROM messages WHERE id = ? AND thread_id = ?").get(Number(messageId), thread.id);
      if (!message) throw new StoreError(`Thread #${thread.id} has no message ${messageId}.`);
      if (message.id === thread.first_message_id) throw new StoreError("The first message is the comment itself. Delete the thread instead.");
      this.#db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
      this.#writes++;
    });
  }

  /**
   * Makes the Markdown file at `path` (absolute) a branch's description,
   * replacing any file linked before. Returns the description as the file
   * reads now.
   */
  linkDescription(repo, entry, path, author) {
    this.#transaction(() => this.#link(repo, entry, path, author));
    return this.description(repo, entry);
  }

  /**
   * The entry of the stack description for a stack whose branches (bottom
   * first) are `branches`: the most recently linked one sharing any of them,
   * or null when none does.
   */
  stackEntry(repo, branches) {
    const row = this.#db
      .prepare(
        `SELECT m.stack FROM stack_members m JOIN description_links l ON l.repo = m.repo AND l.entry = m.stack
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
    const entry = this.#transaction(() => {
      const found = this.stackEntry(repo, branches) ?? this.#newStackEntry(repo, branches[0]);
      this.#link(repo, found, path, author);
      this.#db.prepare("DELETE FROM stack_members WHERE repo = ? AND stack = ?").run(repo, found);
      const insert = this.#db.prepare("INSERT INTO stack_members (repo, stack, branch) VALUES (?, ?, ?)");
      for (const branch of branches) insert.run(repo, found, branch);
      return found;
    });
    return { ...this.description(repo, entry), entry };
  }

  #link(repo, entry, path, author) {
    this.#db
      .prepare(
        `INSERT INTO description_links (repo, entry, path, linked_by, linked_by_kind, linked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET path = excluded.path, linked_by = excluded.linked_by, linked_by_kind = excluded.linked_by_kind, linked_at = excluded.linked_at`,
      )
      .run(repo, entry, path, author.name, author.kind, now());
    this.#writes++;
  }

  /** An entry for a new stack description: "stack:<bottom>", or "stack:<bottom>~2" and on when a merged stack had that bottom. */
  #newStackEntry(repo, bottom) {
    const taken = (entry) =>
      this.#db.prepare("SELECT 1 FROM description_links WHERE repo = ? AND entry = ? UNION SELECT 1 FROM reviews WHERE repo = ? AND entry = ?").get(repo, entry, repo, entry);
    let entry = `${STACK_PREFIX}${bottom}`;
    for (let n = 2; taken(entry); n++) entry = `${STACK_PREFIX}${bottom}~${n}`;
    return entry;
  }

  /**
   * An entry's description as its file reads now: {path, title, body,
   * sha256, editedAt, linkedBy, linkedAt}, or {path, missing, reason, ...}
   * when the file cannot be read; null when none is linked.
   */
  description(repo, entry) {
    const link = this.#db.prepare("SELECT * FROM description_links WHERE repo = ? AND entry = ?").get(repo, entry);
    if (!link) return null;
    return { ...readDescriptionFile(link.path), linkedBy: link.linked_by, linkedByKind: link.linked_by_kind, linkedAt: link.linked_at };
  }

  /**
   * The stored snapshot of an entry's description whose hash is `sha`. When
   * none is, the file must still read that way, and is stored now: a comment
   * needs the text it was made on.
   */
  #descriptionSnapshot(repo, entry, sha) {
    const stored = sha && this.#descriptionBySha(repo, entry, sha);
    if (stored) return stored;
    const current = this.description(repo, entry);
    if (!current || current.missing || current.sha256 !== sha) throw new StoreError("The description changed since you opened it. Reload and select the text again.");
    const latest = this.#latestDescription(repo, entry);
    this.#writes++;
    return this.#db
      .prepare(
        `INSERT INTO descriptions (repo, entry, seq, title, body, sha256, author, author_kind, session, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) RETURNING *`,
      )
      .get(repo, entry, (latest?.seq ?? 0) + 1, current.title, current.body, current.sha256, current.linkedBy, current.linkedByKind, now());
  }

  /**
   * The description a thread is placed against: the snapshot hashed `sha`
   * (what a page rendered), else the file as it reads now, else, when the
   * file cannot be read, the latest snapshot.
   */
  #descriptionShown(repo, entry, sha) {
    const stored = sha && this.#descriptionBySha(repo, entry, sha);
    if (stored) return stored;
    const current = this.description(repo, entry);
    if (current && !current.missing) return { body: current.body, sha256: current.sha256 };
    return this.#latestDescription(repo, entry) ?? null;
  }

  /** Per entry in `repo`: how many threads are unresolved, and how many of those wait on the human. Drafts count as unresolved. */
  countsByEntry(repo) {
    const rows = this.#db
      .prepare(
        `SELECT r.entry, sum(t.status != 'resolved') AS unresolved, sum(coalesce(f.waiting_on = 'human', 0)) AS your_turn
         FROM threads t JOIN thread_facts f ON f.thread_id = t.id JOIN reviews r ON r.id = t.review_id
         WHERE r.repo = ? GROUP BY r.entry`,
      )
      .all(repo);
    return Object.fromEntries(rows.map((row) => [row.entry, { unresolved: row.unresolved, yourTurn: row.your_turn }]));
  }

  /** Marks a file viewed as its diff reads now (`fileSha`), or with null, not viewed. */
  setViewed(repo, entry, path, fileSha) {
    this.#transaction(() => {
      if (fileSha) {
        this.#db
          .prepare("INSERT INTO viewed_files (repo, entry, path, file_sha, viewed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET file_sha = excluded.file_sha, viewed_at = excluded.viewed_at")
          .run(repo, entry, path, fileSha, now());
      } else {
        this.#db.prepare("DELETE FROM viewed_files WHERE repo = ? AND entry = ? AND path = ?").run(repo, entry, path);
      }
      this.#writes++;
    });
  }

  /** The files marked viewed on an entry: path to the file's diff hash when it was marked. */
  viewed(repo, entry) {
    const rows = this.#db.prepare("SELECT path, file_sha FROM viewed_files WHERE repo = ? AND entry = ?").all(repo, entry);
    return Object.fromEntries(rows.map((row) => [row.path, row.file_sha]));
  }

  /** One stored version of a tracked review, with its patch, or null. */
  versionAt(repo, entry, seq) {
    const review = this.findReview(repo, entry);
    const version = review && this.#db.prepare("SELECT * FROM versions WHERE review_id = ? AND seq = ?").get(review.id, seq);
    return version ? { ...this.#versionInfo(review.id, version), patch: version.patch } : null;
  }

  /** A tracked review's versions, newest first, with how many threads each one started. */
  versions(repo, entry) {
    const review = this.findReview(repo, entry);
    if (!review) return [];
    return this.#db
      .prepare(
        `SELECT v.seq, v.base, v.head, v.working_tree AS workingTree, v.observed_at AS observedAt,
                (SELECT count(*) FROM threads t WHERE t.version_id = v.id) AS threads
         FROM versions v WHERE v.review_id = ? ORDER BY v.seq DESC`,
      )
      .all(review.id)
      .map((row) => ({ ...row, workingTree: Boolean(row.workingTree) }));
  }

  /**
   * Ids of threads waiting on an agent in `repo`, on `entries` when given,
   * else on any entry, and with a sent message newer than message id `after`
   * when given. Cheap enough to run on every doorbell ring.
   */
  waitingOnAgent({ repo, entries = null, after = 0 }) {
    const wanted = entries && new Set(entries);
    return this.#db
      .prepare(
        `SELECT t.id, r.entry FROM threads t
         JOIN thread_facts f ON f.thread_id = t.id JOIN reviews r ON r.id = t.review_id
         WHERE f.waiting_on = 'agent' AND r.repo = ?
           AND (SELECT max(id) FROM messages WHERE thread_id = t.id AND sent_at IS NOT NULL) > ?
         ORDER BY t.id`,
      )
      .all(repo, after)
      .filter((row) => !wanted || wanted.has(row.entry))
      .map((row) => row.id);
  }

  /**
   * Every thread on a review, located against one of its versions: the one
   * whose patch hashes to `sha`, or the latest. Threads made after that
   * version are left out, and so are pending messages unless
   * `includePending` (the viewer) asks for them. Returns null when the
   * review has no threads or no such version.
   */
  threadsAt(repo, entry, { sha, descriptionSha, includePending = false } = {}) {
    const review = this.findReview(repo, entry);
    if (!review) return null;
    const version = sha ? this.#versionBySha(review.id, sha) : this.#latestVersion(review.id);
    if (!version) return null;
    const rows = this.#db
      .prepare(`${THREAD_ROW} WHERE t.review_id = ? AND t.version_id IN (SELECT id FROM versions WHERE review_id = ? AND seq <= ?) ORDER BY t.id`)
      .all(review.id, review.id, version.seq);
    const description = this.#descriptionShown(repo, entry, descriptionSha);
    return {
      repo,
      entry,
      version: this.#versionInfo(review.id, version),
      descriptionPath: this.#linkedPath(repo, entry),
      threads: this.#views(version, rows, includePending, description),
    };
  }

  /** One thread, located against its review's latest version. A pending thread does not exist for agents. */
  thread(threadId, { includePending = false } = {}) {
    const row = this.#threadRow(threadId);
    const review = this.#reviewById(row.review_id);
    const version = this.#latestVersion(review.id);
    const [view] = this.#views(version, [row], includePending, this.#descriptionShown(review.repo, review.entry));
    if (!view) throw new StoreError(`No thread #${threadId}.`);
    return { repo: review.repo, entry: review.entry, version: this.#versionInfo(review.id, version), descriptionPath: this.#linkedPath(review.repo, review.entry), thread: view };
  }

  /** The repo and entry a thread belongs to, so callers can observe it before acting. */
  reviewOf(threadId) {
    const review = this.#reviewById(this.#threadRow(threadId).review_id);
    return { repo: review.repo, entry: review.entry };
  }

  /** Runs `fn` under the write lock. Listeners hear about its writes only after they commit. */
  #transaction(fn) {
    const before = this.#writes;
    this.#db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      result = fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      this.#writes = before;
      throw err;
    }
    if (this.#writes !== before) for (const listener of this.#listeners) listener();
    return result;
  }

  /** Returns the review's latest version, inserting `snapshot` as the next one when its patch differs. */
  #recordVersion(reviewId, { base, head, workingTree = false, patch }) {
    const sha = sha256(patch);
    const latest = this.#latestVersion(reviewId);
    // Committing the working tree changes the head but not the patch, and so not what any comment is on.
    if (latest?.sha256 === sha) return latest;
    this.#writes++;
    return this.#db
      .prepare("INSERT INTO versions (review_id, seq, base, head, working_tree, sha256, patch, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(reviewId, (latest?.seq ?? 0) + 1, base, head, workingTree ? 1 : 0, sha, patch, now());
  }

  #findOrInsertReview(repo, entry) {
    return this.findReview(repo, entry) ?? this.#db.prepare("INSERT INTO reviews (repo, entry, created_at) VALUES (?, ?, ?) RETURNING *").get(repo, entry, now());
  }

  #reviewById(id) {
    return this.#db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
  }

  #threadRow(id) {
    const row = this.#db.prepare(`${THREAD_ROW} WHERE t.id = ?`).get(Number(id));
    if (!row) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  /** A thread's row, refusing agents a thread that is still a human's draft, as if it did not exist. */
  #visibleThreadRow(id, author) {
    const row = this.#threadRow(id);
    if (author.kind !== "human" && row.draft) throw new StoreError(`No thread #${id}.`);
    return row;
  }

  #deleteThreadRows(threadId, reviewId) {
    this.#db.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    this.#db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
    if (this.#db.prepare("SELECT count(*) AS n FROM threads WHERE review_id = ?").get(reviewId).n === 0) {
      this.#db.prepare("DELETE FROM versions WHERE review_id = ?").run(reviewId);
      this.#db.prepare("DELETE FROM reviews WHERE id = ?").run(reviewId);
    }
  }

  #latestVersion(reviewId) {
    return this.#db.prepare("SELECT * FROM versions WHERE review_id = ? ORDER BY seq DESC LIMIT 1").get(reviewId);
  }

  #versionBySha(reviewId, sha) {
    return this.#db.prepare("SELECT * FROM versions WHERE review_id = ? AND sha256 = ? ORDER BY seq DESC LIMIT 1").get(reviewId, sha);
  }

  #versionById(id) {
    return this.#db.prepare("SELECT * FROM versions WHERE id = ?").get(id);
  }

  #versionInfo(reviewId, version) {
    return {
      seq: version.seq,
      sha256: version.sha256,
      base: version.base,
      head: version.head,
      workingTree: Boolean(version.working_tree),
      observedAt: version.observed_at,
      latestSeq: this.#latestVersion(reviewId).seq,
    };
  }

  #linkedPath(repo, entry) {
    return this.#db.prepare("SELECT path FROM description_links WHERE repo = ? AND entry = ?").get(repo, entry)?.path ?? null;
  }

  #latestDescription(repo, entry) {
    return this.#db.prepare("SELECT * FROM descriptions WHERE repo = ? AND entry = ? ORDER BY seq DESC LIMIT 1").get(repo, entry);
  }

  #descriptionBySha(repo, entry, sha) {
    return this.#db.prepare("SELECT * FROM descriptions WHERE repo = ? AND entry = ? AND sha256 = ? ORDER BY seq DESC LIMIT 1").get(repo, entry, sha);
  }

  /** A description's blocks, {body, sha256}. A hash names one text, so each is parsed once per process. */
  #descriptionBlocks(row) {
    const key = `description:${row.sha256}`;
    if (!this.#parsed.has(key)) this.#parsed.set(key, parseBlocks(row.body));
    return this.#parsed.get(key);
  }

  /** Where a description thread sits in `here`, the description shown: as mdview locates a comment in a doc. */
  #descriptionPlace(row, here) {
    const origin = this.#db.prepare("SELECT * FROM descriptions WHERE id = ?").get(row.description_id);
    const originBlocks = this.#descriptionBlocks(origin);
    const anchor = { blockSha: row.block_sha, ordinal: row.block_ordinal };
    const originBlock = locateBlock(anchor, originBlocks).block;
    const hereBlocks = here ? this.#descriptionBlocks(here) : [];
    const hit = here ? locateBlock(anchor, hereBlocks) : { state: "outdated" };
    const state = hit.state === "outdated" ? "outdated" : origin.sha256 === here.sha256 ? "current" : "carried";
    const shown = hit.block ? { block: hit.block, blocks: hereBlocks, body: here.body } : originBlock ? { block: originBlock, blocks: originBlocks, body: origin.body } : null;
    const next = !hit.block && originBlock && here ? successor(originBlock, originBlocks, hereBlocks) : null;
    return {
      state,
      blockIndex: hit.block?.index ?? null,
      startLine: shown?.block.startLine ?? null,
      endLine: shown?.block.endLine ?? null,
      heading: shown && headingAbove(shown.blocks, shown.block.index),
      blockText: shown ? sourceLines(shown.body, shown.block) : null,
      madeOn: { seq: origin.seq, description: true, startLine: originBlock?.startLine ?? null, endLine: originBlock?.endLine ?? null },
      nowReads: next && { blockIndex: next.index, startLine: next.startLine, endLine: next.endLine, text: sourceLines(here.body, next) },
    };
  }

  /** A version's parsed files. Versions never change, so each is parsed once per process. */
  #filesOf(version) {
    if (!this.#parsed.has(version.id)) this.#parsed.set(version.id, parseDiff(version.patch));
    return this.#parsed.get(version.id);
  }

  #insertMessage(threadId, versionId, body, author, pending = false) {
    const at = now();
    this.#db
      .prepare(
        `INSERT INTO messages (thread_id, author, author_kind, body, version_id, session, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, author.name, author.kind, body.trim(), versionId, author.session ?? null, at, pending ? null : at);
  }

  #updateStatus(threadId, status, author) {
    this.#db.prepare("UPDATE threads SET status = ?, status_by = ?, status_at = ? WHERE id = ?").run(status, author.name, now(), threadId);
  }

  #messagesFor(threadIds) {
    const byThread = new Map(threadIds.map((id) => [id, []]));
    if (!threadIds.length) return byThread;
    // Sent messages go by send time, so a sent batch follows anything posted while it was drafted; pending ones come last.
    const rows = this.#db
      .prepare(
        `SELECT m.*, v.seq AS version_seq FROM messages m JOIN versions v ON v.id = m.version_id
         WHERE m.thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY m.sent_at IS NULL, m.sent_at, m.id`,
      )
      .all(...threadIds);
    for (const m of rows) {
      byThread.get(m.thread_id).push({
        id: m.id,
        author: m.author,
        authorKind: m.author_kind,
        session: m.session,
        body: m.body,
        versionSeq: m.version_seq,
        createdAt: m.created_at,
        sentAt: m.sent_at,
        pending: m.sent_at === null,
      });
    }
    return byThread;
  }

  /**
   * Views of thread rows against `version` of the diff and `description`,
   * the description shown. Without `includePending`, drafts and pending
   * messages are left out.
   */
  #views(version, rows, includePending = false, description = null) {
    const visible = includePending ? rows : rows.filter((row) => !row.draft);
    const messages = this.#messagesFor(visible.map((r) => r.id));
    const here = this.#filesOf(version);
    const common = (row) => {
      const all = messages.get(row.id);
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        pending: Boolean(row.draft),
        waitingOn: row.waiting_on,
        quote: row.quote,
        statusBy: row.status_by,
        statusAt: row.status_at,
        createdAt: row.created_at,
        messages: includePending ? all : all.filter((m) => !m.pending),
      };
    };
    return visible.map((row) => {
      if (row.kind === "description") {
        return { ...common(row), path: null, side: null, start: row.quote_start, excerpt: [], ...this.#descriptionPlace(row, description) };
      }
      const anchor = {
        kind: row.kind,
        path: row.path,
        side: row.side,
        startLine: row.start_line,
        endLine: row.end_line,
        linesSha: row.lines_sha,
        ordinal: row.ordinal,
        repeats: row.repeats,
      };
      const originVersion = row.version_id === version.id ? version : this.#versionById(row.version_id);
      const origin = this.#filesOf(originVersion);
      const hit = locate(anchor, here);
      const state = hit.state === "outdated" ? "outdated" : row.version_id === version.id ? "current" : "carried";
      const shown = hit.state === "attached" ? { files: here, ...hit } : { files: origin, path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine };
      return {
        ...common(row),
        side: row.side,
        path: shown.path,
        startLine: shown.startLine,
        endLine: shown.endLine,
        state,
        madeOn: { seq: originVersion.seq, path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine },
        excerpt: excerpt(shown.files, { path: shown.path, side: row.side, startLine: shown.startLine, endLine: shown.endLine }),
        nowReads: state === "outdated" ? nowReads(anchor, anchoredTexts(anchor, origin), here) : null,
      };
    });
  }
}
