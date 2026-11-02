/**
 * diffview as a peanut app: what its documents are, how threads pin to
 * them, and the tables it keeps beside peanut's.
 *
 * Three document types, each keyed by JSON.stringify([repo, entry]), where
 * repo is the realpath of the git common dir (so every worktree shares
 * threads) and entry is a branch name, a jj change id, or a stack's
 * "stack:<bottom>". A JSON key is unambiguous whatever a branch is called,
 * a repo's documents share the prefix `["<repo>",`, and SQL reads the entry
 * back with json_extract(key, '$[1]').
 *
 * - diffview.branch: a branch's diff. A revision's content is the patch,
 *   and its meta the repo, base, head and whether the head was the working
 *   tree, which line anchors need to read unchanged lines from git.
 * - diffview.stack: a stack as a whole. It has no code of its own, so its
 *   content is always empty, and it takes only whole comments.
 * - diffview.description: a branch's or a stack's description file. A
 *   revision's content is JSON [title, body], so its hash is the one
 *   normalizeDescription() gives and pages already send back.
 */
import { markdownBlock } from "peanut";
import { anchoredTexts, anchorFor, AnchorError, excerpt, locate, nowReads } from "./anchors.mjs";
import { readDescriptionFile } from "./descriptions.mjs";
import { parseDiff } from "./diff.mjs";
import { readBlob } from "./git.mjs";
import { descriptionTokens } from "./render.mjs";

export const BRANCH = "diffview.branch";
export const STACK = "diffview.stack";
export const DESCRIPTION = "diffview.description";
export const LINES = "diffview.lines";
export const FILE = "diffview.file";
export const WHOLE = "core.whole";
export const BLOCK = "markdown.block";

// A stack's description and its threads live under an entry no branch can
// have, since git refuses ":" in ref names.
const STACK_PREFIX = "stack:";

/** Whether an entry is a stack's, not a branch's. */
export function isStackEntry(entry) {
  return entry.startsWith(STACK_PREFIX);
}

export function documentKey(repo, entry) {
  return JSON.stringify([repo, entry]);
}

export function parseKey(key) {
  const [repo, entry] = JSON.parse(key);
  return { repo, entry };
}

/** The prefix every document key in `repo` starts with. */
export function repoPrefix(repo) {
  return JSON.stringify([repo, ""]).slice(0, -3);
}

/** The document a branch's or stack's code-side threads are on. */
export function codeType(entry) {
  return isStackEntry(entry) ? STACK : BRANCH;
}

/** A description file's text as a revision's content: JSON [title, body]. */
export function descriptionContent({ title, body }) {
  return JSON.stringify([title ?? null, body]);
}

export function descriptionOfContent(content) {
  const [title, body] = JSON.parse(content);
  return { title, body };
}

// Cached by revision hash: a revision's patch never changes. Bounded, since a long-running viewer sees many.
const PARSED = new Map();
const PARSED_LIMIT = 64;
function filesOf(revision) {
  let files = PARSED.get(revision.sha256);
  if (!files) {
    files = parseDiff(revision.content);
    PARSED.set(revision.sha256, files);
    if (PARSED.size > PARSED_LIMIT) PARSED.delete(PARSED.keys().next().value);
  }
  return files;
}

// A commit's blob never changes, so a file read while placing comments is kept.
const BLOBS = new Map();
const BLOB_LIMIT = 256;

/** `side`'s whole file for a file-scoped line anchor in `revision`, from git; undefined when there is none to read. */
function fileTextFor(revision, { path, side }) {
  const { repo, base, head } = revision.meta ?? {};
  const rev = side === "old" ? base : head;
  if (!repo || !rev || !path) return undefined;
  const key = `${repo}\0${rev}\0${path}`;
  if (!BLOBS.has(key)) {
    BLOBS.set(key, readBlob(repo, rev, path));
    if (BLOBS.size > BLOB_LIMIT) BLOBS.delete(BLOBS.keys().next().value);
  }
  return BLOBS.get(key) ?? undefined;
}

/**
 * The anchor types for lines and whole files of a diff. Both store the
 * anchor lib/anchors.mjs builds, {kind, path, side, startLine, endLine,
 * linesSha, ordinal, repeats, scope}, and place it with its locate().
 * A placement is {path, startLine, endLine}; a successor's also carries the
 * lines' text.
 */
function codeAnchorType(name, kind) {
  /** The whole file a file-scoped anchor follows, at `revision`, or undefined for any other anchor. */
  const fileText = (anchor, revision) => (anchor.kind === "lines" && anchor.scope === "file" ? fileTextFor(revision, anchor) : undefined);
  return {
    name,
    /** spec: {path, side, startLine, endLine, quote}, as the page or the CLI names lines or a file. */
    create(revision, { path, side = "new", startLine = null, endLine = startLine, quote = "" }) {
      const files = filesOf(revision);
      const spec = { kind, path, side, startLine, endLine };
      try {
        return { anchor: anchorFor(files, spec), quote };
      } catch (err) {
        // Lines the diff does not show, the unmodified ones a viewer expands around a hunk, anchor against the file.
        if (!(err instanceof AnchorError) || !err.message.includes("not shown together")) throw err;
        const text = fileTextFor(revision, spec);
        if (text === undefined) throw err;
        return { anchor: anchorFor(files, spec, text), quote };
      }
    },
    place(anchor, revision) {
      const hit = locate(anchor, filesOf(revision), fileText(anchor, revision));
      return hit.state === "attached" ? { path: hit.path, startLine: hit.startLine, endLine: hit.endLine } : null;
    },
    successor(anchor, from, to) {
      const texts = anchoredTexts(anchor, filesOf(from), fileText(anchor, from));
      return nowReads(anchor, texts, filesOf(to), fileText(anchor, to));
    },
    label(anchor, placement) {
      const at = placement ?? anchor;
      if (at.startLine === null || at.startLine === undefined) return at.path;
      const lines = at.startLine === at.endLine ? `line ${at.startLine}` : `lines ${at.startLine}-${at.endLine}`;
      return `${at.path}${anchor.side === "old" ? " (old side)" : ""} ${lines}`;
    },
  };
}

/**
 * The diff lines around a placement, as the CLI and cards show them:
 * [{kind, old, new, text, marked}]. Not an anchor type method because it
 * returns lines, not text.
 */
export function codeExcerpt(anchor, placement, revision) {
  const at = placement ?? anchor;
  const fileText = anchor.kind === "lines" && anchor.scope === "file" ? fileTextFor(revision, { path: at.path, side: anchor.side }) : undefined;
  return excerpt(filesOf(revision), { path: at.path, side: anchor.side, startLine: at.startLine, endLine: at.endLine }, fileText);
}

const descriptionBlock = markdownBlock({
  tokenize(content) {
    const { body } = descriptionOfContent(content);
    return { tokens: descriptionTokens(body), source: body };
  },
});

/**
 * diffview's app. `links` reads a description's linked path; the store
 * hands it in, since the links live in the store's own table.
 */
export function diffviewApp({ linkedPath }) {
  const nameOf = (key) => parseKey(key).entry;
  return {
    name: "diffview",
    anchorTypes: [codeAnchorType(LINES, "lines"), codeAnchorType(FILE, "file"), descriptionBlock],
    documentTypes: [
      {
        name: BRANCH,
        noun: "branch",
        anchorTypes: [LINES, FILE, WHOLE],
        // A branch's diff takes a stack and git to compute; callers always hand it in.
        readContent: () => null,
        displayName: nameOf,
      },
      {
        name: STACK,
        noun: "stack",
        anchorTypes: [WHOLE],
        readContent: () => ({ content: "" }),
        displayName: nameOf,
      },
      {
        name: DESCRIPTION,
        noun: "description",
        anchorTypes: [BLOCK],
        readContent(key) {
          const { repo, entry } = parseKey(key);
          const path = linkedPath(repo, entry);
          const file = path && readDescriptionFile(path);
          return file && !file.missing ? { content: descriptionContent(file), meta: { path } } : null;
        },
        displayName: nameOf,
      },
    ],
    migrations: [
      `
-- Where each entry's description lives: a Markdown file the agent owns and
-- edits (lib/descriptions.mjs). The store never writes it.
CREATE TABLE diffview_description_links (
  repo           TEXT NOT NULL,
  entry          TEXT NOT NULL,
  path           TEXT NOT NULL,      -- absolute
  linked_by      TEXT NOT NULL,
  linked_by_kind TEXT NOT NULL CHECK (linked_by_kind IN ('human', 'agent')),
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (repo, entry)
);
-- The branches a stack description was written for, as of its latest write.
-- Stacks have no id in any tool, and they grow on top and merge from the
-- bottom, so a stack's description is found through any branch it shares.
CREATE TABLE diffview_stack_members (
  repo   TEXT NOT NULL,
  stack  TEXT NOT NULL,              -- the description's entry, "stack:<bottom branch when first written>"
  branch TEXT NOT NULL,
  PRIMARY KEY (repo, stack, branch)
);
-- Files the human marked viewed. Not a comment, so not a document: marking
-- a file viewed must not make a branch keep copies of its diff.
CREATE TABLE diffview_viewed_files (
  repo      TEXT NOT NULL,
  entry     TEXT NOT NULL,
  path      TEXT NOT NULL,
  file_sha  TEXT NOT NULL,           -- of the file's diff when it was marked viewed
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (repo, entry, path)
);
-- Branches the human marked viewed as a whole: approval, set only on purpose,
-- never by viewing every file. It holds while the branch's diff reads as it
-- did (diff_sha), so a rebase that changes no code keeps it.
CREATE TABLE diffview_viewed_branches (
  repo      TEXT NOT NULL,
  entry     TEXT NOT NULL,
  diff_sha  TEXT NOT NULL,           -- of the branch's whole diff when it was marked
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (repo, entry)
);
-- Which old store this one was filled from, so the import runs once.
CREATE TABLE diffview_imports (
  source      TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL
);
`,
    ],
  };
}
