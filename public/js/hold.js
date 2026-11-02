/**
 * Keeps the line a reader is on at the same height on screen while the diff
 * pane changes width: the comment margin opening or closing, the sidebar's
 * panels, threads moving inline. A narrower pane rewraps lines and, under
 * Auto, can switch split to unified, so everything below the page's top moves.
 *
 * The line is the open thread's, when it is on screen, else the first one
 * below the pinned headers. The diffs are laid out again at once, so Pierre
 * never paints the moved frame, and the line is put back on every frame for a
 * moment after, while Pierre finishes; a reader who scrolls first wins.
 */
import { rowFor } from "./comments.js";
import { $, state } from "./state.js";

const HOLD_MS = 500;
// Room for a file's pinned header under the top bar, so the line held is one the reader can see.
const PINNED_HEADER_HEIGHT = 40;

/** Set by main.js: lays the diffs out for the pane's width now, rather than when its ResizeObserver next fires. */
export const holdHooks = { relayout() {} };

const itemAt = (path) => state.views.find((v) => v.file.path === path);

function rowOf(line) {
  const item = itemAt(line.path);
  return item ? rowFor(item, line.side, line.line) : null;
}

function onScreen(row, top) {
  const box = row.getBoundingClientRect();
  return box.top >= top && box.bottom <= innerHeight;
}

/** The line a reader is on, as `{path, side, line}`, or null when no diff line is on screen. */
function readingLine() {
  const top = $(".topbar").getBoundingClientRect().bottom;
  const active = state.comments.threads.find((t) => t.id === state.comments.active && t.kind === "lines");
  if (active) {
    const line = { path: active.path, side: active.side, line: active.startLine };
    const row = rowOf(line);
    if (row && onScreen(row, top)) return line;
  }
  const below = top + PINNED_HEADER_HEIGHT;
  for (const item of state.views) {
    const box = item.section.getBoundingClientRect();
    if (box.bottom < below || box.top > innerHeight) continue;
    for (const row of item.section.firstElementChild?.shadowRoot?.querySelectorAll("[data-line]") ?? []) {
      if (row.getBoundingClientRect().bottom <= below) continue;
      const deleted = row.closest("code").hasAttribute("data-deletions") || row.dataset.lineType === "change-deletion";
      return { path: item.file.path, side: deleted ? "old" : "new", line: Number(row.dataset.line) };
    }
  }
  return null;
}

// While a change and its relayout run: a change nested in them (relayout docking the margin) is already held.
let holding = false;

/** Runs `change`, which moves the diff pane's edges, keeping the reader's line where it was on screen. */
export function holdReadingLine(change) {
  if (holding) {
    change();
    return;
  }
  const line = readingLine();
  const at = line && rowOf(line).getBoundingClientRect().top;
  holding = true;
  try {
    change();
    holdHooks.relayout();
  } finally {
    holding = false;
  }
  if (!line) return;
  let stopped = false;
  const stop = () => (stopped = true);
  addEventListener("wheel", stop, { once: true, passive: true });
  addEventListener("keydown", stop, { once: true });
  const until = performance.now() + HOLD_MS;
  const putBack = () => {
    const row = stopped ? null : rowOf(line);
    if (row) {
      const moved = row.getBoundingClientRect().top - at;
      if (Math.abs(moved) >= 1) scrollBy(0, moved);
    }
    if (!stopped && performance.now() < until) {
      requestAnimationFrame(putBack);
      return;
    }
    removeEventListener("wheel", stop);
    removeEventListener("keydown", stop);
  };
  putBack();
}
