/**
 * The branch's description above its diff: rendering it, turning a text
 * selection in it into what the server anchors a comment to, and painting
 * comments' quotes. Adapted from mdview's comments/anchors.js and marks.js:
 * a comment names its block (data-block="<index>"), the quote trimmed to
 * that block, and the quote's offset in the block's text.
 */
import { findQuote } from "./lib/quote.js";
import { escapeHtml } from "./lib/format.js";
import { $, state } from "./state.js";

const HIGHLIGHTS =
  "highlights" in CSS ? { open: new Highlight(), turn: new Highlight(), suggested: new Highlight(), pending: new Highlight(), active: new Highlight() } : null;
if (HIGHLIGHTS) {
  HIGHLIGHTS.active.priority = 1;
  for (const [name, highlight] of Object.entries(HIGHLIGHTS)) CSS.highlights.set(`dv-description-${name}`, highlight);
}

/** Draws the description, or a note saying how an agent writes one. */
export function renderDescription() {
  const box = $("#description");
  const d = state.description;
  box.hidden = false;
  if (!d) {
    box.classList.add("empty");
    box.innerHTML = `<p class="faint">No description yet. The agent writing this branch adds one with <code>diffview describe</code>; it becomes the PR's body.</p>`;
    return;
  }
  box.classList.remove("empty");
  const meta = `<p class="description-meta faint">Description v${d.seq} · ${escapeHtml(d.author)}${d.authorKind === "agent" ? " (agent)" : ""} · ${new Date(d.createdAt).toLocaleString()}</p>`;
  box.innerHTML = `${d.title ? `<h2 class="description-title">${escapeHtml(d.title)}</h2>` : ""}${meta}<div class="description-body" id="description-body">${d.html}</div>`;
}

export function blockAt(node) {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const block = el?.closest("[data-block]");
  return block && $("#description-body")?.contains(block) ? block : null;
}

/** A block's own text nodes, leaving out any nested block (a list item's sub-list). */
function ownTextNodes(block) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest("[data-block]") === block ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/** The character offset of a DOM point within the concatenated text of `nodes`. */
function textOffset(nodes, container, offset) {
  const point = document.createRange();
  point.setStart(container, offset);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + offset;
    if (point.comparePoint(node, node.length) > 0) break;
    total += node.length;
  }
  return total;
}

function domPoint(nodes, offset) {
  for (const node of nodes) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  const last = nodes.at(-1);
  return [last, last.length];
}

/** What the server needs to anchor a selection: its block, the quote trimmed to that block, and its offset; or null. */
export function anchorFromRange(range) {
  const block = blockAt(range.startContainer);
  if (!block) return null;
  const nodes = ownTextNodes(block);
  const text = nodes.map((n) => n.data).join("");
  const start = textOffset(nodes, range.startContainer, range.startOffset);
  const end = block.contains(range.endContainer) ? textOffset(nodes, range.endContainer, range.endOffset) : text.length;
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (!quote) return null;
  return { blockIndex: Number(block.dataset.block), quote, start: start + raw.length - raw.trimStart().length };
}

/** The Range a description thread highlights: its quote inside its block, or the whole block when the quote is not there. */
export function rangeFor(thread) {
  const block = $(`#description-body [data-block="${thread.blockIndex}"]`);
  const nodes = block ? ownTextNodes(block) : [];
  if (!nodes.length) return null;
  const text = nodes.map((n) => n.data).join("");
  const [start, end] = findQuote(text, thread.quote, thread.start ?? 0) ?? [0, text.length];
  const range = document.createRange();
  range.setStart(...domPoint(nodes, start));
  range.setEnd(...domPoint(nodes, end));
  return range;
}

let painted = new Map();

/** Highlights each placed description thread's quote, colored by whose turn it is. */
export function paintDescription(threads, active, markOf) {
  painted = new Map();
  if (!HIGHLIGHTS) return;
  for (const highlight of Object.values(HIGHLIGHTS)) highlight.clear();
  for (const t of threads) {
    const range = rangeFor(t);
    if (!range) continue;
    painted.set(t.id, range);
    HIGHLIGHTS[markOf(t)].add(range);
    if (t.id === active) HIGHLIGHTS.active.add(range);
  }
}

/** The thread whose highlight holds the point (x, y), or null. */
export function threadAtPoint(x, y) {
  let node;
  let offset;
  if (document.caretPositionFromPoint) ({ offsetNode: node, offset } = document.caretPositionFromPoint(x, y) ?? {});
  else ({ startContainer: node, startOffset: offset } = document.caretRangeFromPoint?.(x, y) ?? {});
  if (!node) return null;
  for (const [id, range] of painted) if (range.isPointInRange(node, offset)) return id;
  return null;
}

/** Where a description thread's card should line up: its highlight, or its block. */
export function descriptionTarget(thread) {
  return painted.get(thread.id) ?? $(`#description-body [data-block="${thread.blockIndex}"]`);
}
