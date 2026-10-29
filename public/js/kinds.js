/**
 * Tests and generated files (the server's `kind` on each file): hidden by
 * default and left out of every count the page shows, until the person
 * shows them. A file with an unresolved thread shows anyway, so no comment
 * is hidden; it still stays out of the counts.
 */
import { state } from "./state.js";

export const KINDS = { test: "Tests", generated: "Generated" };
const STORAGE_KEY = "diffview.showKinds";

/** The kinds shown, as chosen in this browser. */
export const shownKinds = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));

export function toggleKind(kind) {
  if (shownKinds.has(kind)) shownKinds.delete(kind);
  else shownKinds.add(kind);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...shownKinds]));
}

/** Whether a file counts toward the stats shown: an ordinary file, or one of a shown kind. */
export function counted(file) {
  return !file.kind || shownKinds.has(file.kind);
}

/** Whether a file's diff is rendered: counted, or carrying an unresolved thread. */
export function rendered(file) {
  return counted(file) || state.comments.threads.some((t) => t.path === file.path && t.status !== "resolved");
}

/** Which files are rendered, as one string, so a change in what threads force into view can be noticed. */
export function renderedPaths() {
  return (state.diff?.files ?? []).filter(rendered).map((f) => f.path).join("\0");
}

/** A branch's size from the server ({files, additions, deletions, viewed, changed, byKind}) with hidden kinds taken out. */
export function shownSize(size) {
  if (!size) return size;
  const shown = { ...size };
  for (const [kind, part] of Object.entries(size.byKind ?? {})) {
    if (shownKinds.has(kind)) continue;
    for (const key of ["files", "additions", "deletions", "viewed", "changed"]) shown[key] -= part[key];
  }
  return shown;
}
