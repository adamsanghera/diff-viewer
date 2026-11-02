/**
 * Copies the store an older diffview kept (<home>/diffview.sqlite3, schema
 * version 5) into peanut's, once. Every thread and message keeps its id,
 * so ids agents and people have already seen still work. The old file is
 * only read, so it stays as the backup.
 *
 * How the old rows map:
 *
 * - A review's diff versions become revisions of its diffview.branch (or,
 *   for a "stack:" entry, diffview.stack) document, keeping their ids. A
 *   review whose only threads are on its description has no code document:
 *   peanut keeps revisions only for documents with threads.
 * - Threads on lines and files keep the anchors lib/anchors.mjs built;
 *   threads on the whole branch become core.whole.
 * - Description snapshots become revisions of a diffview.description
 *   document, and threads on them markdown.block anchors. A message on such
 *   a thread is put on the snapshot that was latest when it was written.
 * - Description links, stack members and viewed marks are copied as they are.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreError } from "peanut";
import { BLOCK, codeType, DESCRIPTION, descriptionContent, documentKey, FILE, LINES, WHOLE } from "./peanut-app.mjs";

export const LEGACY_FILE = "diffview.sqlite3";
const LEGACY_SCHEMA = 5;
const ANCHOR_BY_KIND = { lines: LINES, file: FILE, branch: WHOLE };

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Imports <home>/diffview.sqlite3 into `peanut` unless it was imported
 * already or there is none. Returns how many threads came over, or null
 * when nothing ran. Refuses a store peanut already holds threads in, rather
 * than mixing two sets of ids.
 */
export function importLegacyStore(peanut, home, { DatabaseSync = loadSqlite() } = {}) {
  const file = path.join(home, LEGACY_FILE);
  if (!fs.existsSync(file)) return null;
  if (peanut.db.prepare("SELECT 1 FROM diffview_imports WHERE source = ?").get(file)) return null;
  if (peanut.db.prepare("SELECT count(*) AS n FROM threads").get().n > 0) {
    throw new StoreError(`${path.join(home, "peanut.sqlite3")} already holds comments, so ${file} cannot be copied into it. Move one of them aside.`);
  }

  const old = new DatabaseSync(file, { readOnly: true });
  try {
    const version = old.prepare("PRAGMA user_version").get().user_version;
    if (version !== LEGACY_SCHEMA) {
      throw new StoreError(`${file} is from an older diffview (store version ${version}). Open it once with a diffview from before peanut to upgrade it, then try again.`);
    }
    const count = peanut.write((db) => copy(old, db, file));
    if (count) console.error(`diffview: moved ${count} comment threads into ${path.join(home, "peanut.sqlite3")}; ${file} is left as it was`);
    return count;
  } finally {
    old.close();
  }
}

function loadSqlite() {
  // Loaded lazily by the caller's node:sqlite; peanut has already required it by the time this runs.
  return process.getBuiltinModule("node:sqlite").DatabaseSync;
}

function copy(old, db, file) {
  const reviews = old.prepare("SELECT * FROM reviews ORDER BY id").all();
  const threads = old.prepare("SELECT * FROM threads ORDER BY id").all();
  const insertDocument = db.prepare("INSERT INTO documents (type, key, created_at) VALUES (?, ?, ?) RETURNING id");
  const insertRevision = db.prepare(
    "INSERT INTO revisions (id, document_id, seq, sha256, content, meta, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
  );
  const insertThread = db.prepare(
    `INSERT INTO threads (id, document_id, revision_id, anchor_type, anchor, quote, status, status_by, status_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, thread_id, revision_id, author, author_kind, session, body, created_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Code documents and their versions first, keeping version ids as revision ids.
  const codeDocument = new Map();
  for (const review of reviews) {
    if (!threads.some((t) => t.review_id === review.id && t.kind !== "description")) continue;
    const { id } = insertDocument.get(codeType(review.entry), documentKey(review.repo, review.entry), review.created_at);
    codeDocument.set(review.id, id);
    for (const v of old.prepare("SELECT * FROM versions WHERE review_id = ? ORDER BY seq").all(review.id)) {
      const meta = { repo: review.repo, base: v.base, head: v.head, workingTree: Boolean(v.working_tree) };
      insertRevision.get(v.id, id, v.seq, v.sha256, v.patch, JSON.stringify(meta), v.observed_at);
    }
  }

  // Then description documents, whose snapshots take fresh revision ids after the versions'.
  const descriptionRevision = new Map();
  const descriptionDocument = new Map();
  for (const review of reviews) {
    if (!threads.some((t) => t.review_id === review.id && t.kind === "description")) continue;
    const { id } = insertDocument.get(DESCRIPTION, documentKey(review.repo, review.entry), review.created_at);
    const snapshots = [];
    for (const d of old.prepare("SELECT * FROM descriptions WHERE repo = ? AND entry = ? ORDER BY seq").all(review.repo, review.entry)) {
      const content = descriptionContent({ title: d.title, body: d.body });
      const revision = insertRevision.get(null, id, d.seq, sha256(content), content, "{}", d.created_at);
      descriptionRevision.set(d.id, revision.id);
      snapshots.push({ id: revision.id, at: d.created_at });
    }
    descriptionDocument.set(review.id, snapshots);
  }

  for (const t of threads) {
    const messages = old.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id").all(t.id);
    if (t.kind === "description") {
      const revision = descriptionRevision.get(t.description_id);
      const anchor = { blockSha: t.block_sha, ordinal: t.block_ordinal, start: t.quote_start };
      insertThread.run(t.id, documentIdOf(db, revision), revision, BLOCK, JSON.stringify(anchor), t.quote, t.status, t.status_by, t.status_at, t.created_at);
      const snapshots = descriptionDocument.get(t.review_id);
      for (const m of messages) {
        // The snapshot latest when the message was written, and never one before the thread's own.
        const at = snapshots.filter((s) => s.at <= m.created_at && s.id >= revision).at(-1)?.id ?? revision;
        insertMessage.run(m.id, t.id, at, m.author, m.author_kind, m.session, m.body, m.created_at, m.sent_at);
      }
      continue;
    }
    const anchorType = ANCHOR_BY_KIND[t.kind];
    const anchor =
      anchorType === WHOLE
        ? {}
        : {
            kind: t.kind,
            path: t.path,
            side: t.side,
            startLine: t.start_line,
            endLine: t.end_line,
            linesSha: t.lines_sha,
            ordinal: t.ordinal,
            repeats: t.repeats,
            scope: t.scope ?? "diff",
          };
    insertThread.run(t.id, codeDocument.get(t.review_id), t.version_id, anchorType, JSON.stringify(anchor), t.quote, t.status, t.status_by, t.status_at, t.created_at);
    for (const m of messages) insertMessage.run(m.id, t.id, m.version_id, m.author, m.author_kind, m.session, m.body, m.created_at, m.sent_at);
  }

  copyRows(old, db, "description_links", "diffview_description_links", ["repo", "entry", "path", "linked_by", "linked_by_kind", "linked_at"]);
  copyRows(old, db, "stack_members", "diffview_stack_members", ["repo", "stack", "branch"]);
  copyRows(old, db, "viewed_files", "diffview_viewed_files", ["repo", "entry", "path", "file_sha", "viewed_at"]);
  copyRows(old, db, "viewed_branches", "diffview_viewed_branches", ["repo", "entry", "diff_sha", "viewed_at"]);
  db.prepare("INSERT INTO diffview_imports (source, imported_at) VALUES (?, ?)").run(file, new Date().toISOString());
  return threads.length;
}

function documentIdOf(db, revisionId) {
  return db.prepare("SELECT document_id FROM revisions WHERE id = ?").get(revisionId).document_id;
}

function copyRows(old, db, from, to, columns) {
  const insert = db.prepare(`INSERT INTO ${to} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of old.prepare(`SELECT ${columns.join(", ")} FROM ${from}`).all()) insert.run(...columns.map((c) => row[c]));
}
