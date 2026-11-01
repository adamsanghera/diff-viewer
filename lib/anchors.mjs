/**
 * Where a comment sits in a branch's diff, and where it lands in a later
 * version of that diff.
 *
 * A comment on lines records the file, the side (the branch's "new" lines
 * or the parent's "old" ones), the line range, and a hash of the range's
 * text. In a later version the comment follows its text, not its numbers:
 * it attaches to the run of lines on that side whose text hashes the same,
 * so a rebase that shifts the lines keeps it. When
 * the text is gone, as when an agent rewrote those lines, the comment is
 * outdated, and nowReads() guesses what the lines became.
 *
 * A comment on lines the diff shows (context and added lines on the new
 * side, context and removed lines on the old side) is scoped to the diff:
 * repeats of its text are counted there. A comment on unmodified lines,
 * the ones a viewer expands around the hunks, is scoped to the whole file
 * instead, and follows that text through later versions of the file. A
 * line that drops out of the diff, because its file's changes were
 * reverted, has nothing left to review.
 */
import { createHash } from "node:crypto";

export const SIDES = ["new", "old"];
export const KINDS = ["lines", "file", "branch"];

// How alike (Dice coefficient over word sets) a run of lines must be to an
// outdated comment's lines to count as those lines, edited.
const SUCCESSOR_SIMILARITY = 0.5;

/** Hashes lines' text, ignoring trailing whitespace, which editors and formatters change freely. */
export function linesSha(texts) {
  return createHash("sha256")
    .update(texts.map((t) => t.replace(/\s+$/, "")).join("\n"))
    .digest("hex");
}

/** The lines a diff shows for `file` on `side`, in order: [{line, text}]. */
export function sideLines(file, side) {
  const lines = [];
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (side === "new" && l.kind !== "del") lines.push({ line: l.new, text: l.text });
      if (side === "old" && l.kind !== "add") lines.push({ line: l.old, text: l.text });
    }
  }
  return lines;
}

export function pathOn(file, side) {
  return side === "new" ? file.newPath : file.oldPath;
}

/** A file's lines as the diff's line list is shaped: [{line, text}], 1-based, with no trailing empty line. */
function textLines(text) {
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts.map((line, i) => ({ line: i + 1, text: line }));
}

/** Where `startLine`..`endLine` sits in `lines`, or null when the range is missing or broken by a gap. */
function place(lines, startLine, endLine) {
  const count = endLine - startLine + 1;
  const first = lines.findIndex((l) => l.line === startLine);
  if (first === -1 || lines[first + count - 1]?.line !== endLine) return null;
  return { first, count };
}

/**
 * The file a comment on `path` refers to in a parsed diff: the one with
 * that path on the comment's side, else one renamed from it since.
 */
export function findFile(files, path, side) {
  return files.find((f) => pathOn(f, side) === path) ?? files.find((f) => f.status === "renamed" && f.oldPath === path) ?? null;
}

/** Runs of `count` consecutive lines (no gap between hunks) within `lines`, as start indexes. */
function* runs(lines, count) {
  for (let i = 0; i + count <= lines.length; i++) {
    if (lines[i + count - 1].line - lines[i].line === count - 1) yield i;
  }
}

/**
 * Builds the anchor for a comment on `startLine`..`endLine` of `path`'s
 * `side` in a parsed diff, or explains why those lines cannot hold one.
 * `fileText`, when given, is that side's whole file: lines the diff does
 * not show are anchored against it (`scope: "file"`).
 */
export function anchorFor(files, { kind, path, side = "new", startLine, endLine = startLine }, fileText) {
  const none = { startLine: null, endLine: null, linesSha: null, ordinal: 0, repeats: 0, scope: "diff" };
  if (kind === "branch") return { kind, path: null, side: null, ...none };
  const file = files.find((f) => pathOn(f, side) === path);
  if (!file) throw new AnchorError(`${path} is not in this diff${side === "old" ? " on the old side" : ""}.`);
  if (kind === "file") return { kind, path, side, ...none };
  if (!(Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine)) {
    throw new AnchorError(`Lines ${startLine}-${endLine} are not a line range.`);
  }
  const lines = sideLines(file, side);
  const shown = place(lines, startLine, endLine);
  if (shown) return lineAnchor({ kind, path, side, startLine, endLine }, lines, shown, "diff");
  if (typeof fileText === "string") {
    const whole = textLines(fileText);
    const inFile = place(whole, startLine, endLine);
    if (inFile) return lineAnchor({ kind, path, side, startLine, endLine }, whole, inFile, "file");
    throw new AnchorError(`Lines ${startLine}-${endLine} of ${path} are not in that file.`);
  }
  throw new AnchorError(`Lines ${startLine}-${endLine} of ${path} are not shown together in the diff.`);
}

function lineAnchor({ kind, path, side, startLine, endLine }, lines, { first, count }, scope) {
  const sha = linesSha(lines.slice(first, first + count).map((l) => l.text));
  const repeats = matchingRuns(lines, count, sha);
  return { kind, path, side, startLine, endLine, linesSha: sha, ordinal: repeats.indexOf(startLine), repeats: repeats.length, scope };
}

/** The first line of every run of `count` lines whose text hashes to `sha`. */
function matchingRuns(lines, count, sha) {
  const starts = [];
  for (const i of runs(lines, count)) {
    if (linesSha(lines.slice(i, i + count).map((l) => l.text)) === sha) starts.push(lines[i].line);
  }
  return starts;
}

/** A request for an anchor the diff cannot hold. */
export class AnchorError extends Error {}

/**
 * Where `anchor` lands in a parsed diff: {state: "attached", path,
 * startLine, endLine} or {state: "outdated"}. `fileText` is the whole file
 * on the anchor's side, and is how a file-scoped comment is found.
 */
export function locate(anchor, files, fileText) {
  if (anchor.kind === "branch") return { state: "attached", path: null, startLine: null, endLine: null };
  const file = findFile(files, anchor.path, anchor.side);
  if (!file) return { state: "outdated" };
  const path = pathOn(file, anchor.side);
  if (anchor.kind === "file") return { state: "attached", path, startLine: null, endLine: null };
  const count = anchor.endLine - anchor.startLine + 1;
  const lines = anchor.scope === "file" ? (typeof fileText === "string" ? textLines(fileText) : null) : sideLines(file, anchor.side);
  if (!lines) return { state: "outdated" };
  const starts = matchingRuns(lines, count, anchor.linesSha);
  if (!starts.length) return { state: "outdated" };
  // Lines that repeat (a lone "}") are told apart by position among their repeats while
  // the number of repeats holds, and by distance from where they were once it changes.
  const start =
    starts.length === anchor.repeats
      ? starts[anchor.ordinal]
      : starts.reduce((best, s) => (Math.abs(s - anchor.startLine) < Math.abs(best - anchor.startLine) ? s : best));
  return { state: "attached", path, startLine: start, endLine: start + count - 1 };
}

function wordSet(text) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function dice(a, b) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size || 1);
}

/**
 * Guesses what an outdated comment's lines became in a parsed diff: the
 * run of lines of the same length, in the same file and side, most like
 * the original `texts`. Returns {path, startLine, endLine, text}, or null
 * when nothing is alike enough, as when the lines were deleted.
 * `fileText` is the whole file, searched for a file-scoped comment.
 */
export function nowReads(anchor, texts, files, fileText) {
  if (anchor.kind !== "lines") return null;
  const file = findFile(files, anchor.path, anchor.side);
  if (!file) return null;
  const lines = anchor.scope === "file" && typeof fileText === "string" ? textLines(fileText) : sideLines(file, anchor.side);
  const count = texts.length;
  const original = wordSet(texts.join("\n"));
  let best = null;
  for (const i of runs(lines, count)) {
    const run = lines.slice(i, i + count);
    const score = dice(original, wordSet(run.map((l) => l.text).join("\n")));
    if (score >= SUCCESSOR_SIMILARITY && (!best || score > best.score)) best = { run, score };
  }
  if (!best) return null;
  return {
    path: pathOn(file, anchor.side),
    startLine: best.run[0].line,
    endLine: best.run.at(-1).line,
    text: best.run.map((l) => l.text).join("\n"),
  };
}

// Lines of context `excerpt` shows on each side of a comment's lines.
const EXCERPT_CONTEXT = 3;

/**
 * The diff lines around `startLine`..`endLine` of `path`'s `side`, for
 * showing a comment in a terminal: [{kind, old, new, text, marked}], with
 * `marked` on the commented lines. `fileText` supplies lines the diff does
 * not show.
 */
export function excerpt(files, { path, side, startLine, endLine }, fileText) {
  const fromDiff = excerptFromDiff(files, { path, side, startLine, endLine });
  if (fromDiff.length || typeof fileText !== "string" || startLine === null) return fromDiff;
  const lines = textLines(fileText);
  const index = lines.findIndex((l) => l.line === startLine);
  if (index === -1) return [];
  const last = lines.findIndex((l) => l.line === endLine);
  if (last === -1) return [];
  const from = Math.max(0, index - EXCERPT_CONTEXT);
  const to = Math.min(lines.length, last + EXCERPT_CONTEXT + 1);
  return lines.slice(from, to).map((l) => ({
    kind: "context",
    old: side === "old" ? l.line : null,
    new: side === "new" ? l.line : null,
    text: l.text,
    marked: l.line >= startLine && l.line <= endLine,
  }));
}

function excerptFromDiff(files, { path, side, startLine, endLine }) {
  const file = files.find((f) => pathOn(f, side) === path);
  if (!file || startLine === null) return [];
  const number = (l) => (side === "new" ? l.new : l.old);
  const out = [];
  for (const hunk of file.hunks) {
    const index = hunk.lines.findIndex((l) => number(l) === startLine);
    const last = hunk.lines.findIndex((l) => number(l) === endLine);
    if (index === -1 || last === -1) continue;
    const from = Math.max(0, index - EXCERPT_CONTEXT);
    const to = Math.min(hunk.lines.length, last + EXCERPT_CONTEXT + 1);
    for (const l of hunk.lines.slice(from, to)) {
      const n = number(l);
      out.push({ kind: l.kind, old: l.old, new: l.new, text: l.text, marked: n !== null && n >= startLine && n <= endLine });
    }
    break;
  }
  return out;
}

/** The text of an anchor's lines in the parsed diff it was made on, or in `fileText` for a file-scoped one. */
export function anchoredTexts(anchor, files, fileText) {
  if (anchor.kind !== "lines") return [];
  if (anchor.scope === "file" && typeof fileText === "string") {
    return textLines(fileText)
      .filter((l) => l.line >= anchor.startLine && l.line <= anchor.endLine)
      .map((l) => l.text);
  }
  const file = files.find((f) => pathOn(f, anchor.side) === anchor.path);
  if (!file) return [];
  return sideLines(file, anchor.side)
    .filter((l) => l.line >= anchor.startLine && l.line <= anchor.endLine)
    .map((l) => l.text);
}
