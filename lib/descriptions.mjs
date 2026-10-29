/**
 * Description files. A branch's (or a stack's) description is a Markdown
 * file the agent keeps wherever it likes and edits with its usual tools;
 * the store only records its path, as mdview overlays comments on files it
 * never owns. The PR title rides in front matter:
 *
 *   ---
 *   title: Share compute()
 *   ---
 *   ## Why
 *   ...
 *
 * Other front matter keys are ignored.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a description file's text into {title, body}; the title is null without front matter or a title key. */
export function parseDescription(text) {
  const match = FRONT_MATTER.exec(text);
  const title = match && /^title:[ \t]*(.*)$/m.exec(match[1])?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  return { title: title || null, body: match ? text.slice(match[0].length) : text };
}

/** A description's text as a file: front matter with its title, when it has one, then the body. */
export function formatDescription({ title, body }) {
  return title ? `---\ntitle: ${title}\n---\n\n${body}` : body;
}

/**
 * Whitespace at the ends does not change a description, and its hash covers
 * the title and body together. Snapshots in the store hash the same way, so a
 * file reads as the snapshot it matches.
 */
export function normalizeDescription({ title, body }) {
  const text = `${body.trim()}\n`;
  const heading = title?.trim() || null;
  return { title: heading, body: text, sha256: createHash("sha256").update(JSON.stringify([heading, text])).digest("hex") };
}

/**
 * Reads the description file at `path`: {path, title, body, sha256, editedAt},
 * or {path, missing: true, reason} when it cannot be read or holds no text.
 */
export function readDescriptionFile(path) {
  let text;
  let stat;
  try {
    text = fs.readFileSync(path, "utf8");
    stat = fs.statSync(path);
  } catch (err) {
    return { path, missing: true, reason: err.code === "ENOENT" ? "no file there" : err.message };
  }
  const parsed = parseDescription(text);
  if (!parsed.body.trim()) return { path, missing: true, reason: "the file has no text below its front matter" };
  return { path, ...normalizeDescription(parsed), editedAt: stat.mtime.toISOString() };
}
