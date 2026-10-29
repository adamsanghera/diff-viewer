/** The sidebar: the stack, the branch's files, and showing or hiding it. */
import { viewedState } from "./comments.js";
import { escapeHtml } from "./lib/format.js";
import { counted, extensionOf, filters, HIDE_CHOICES, hiddenSummary, KIND_CHOICES, rendered, shownSize } from "./filters.js";
import { buildTree, stackRows } from "./lib/tree.js";
import { $, root, state } from "./state.js";

const STATUS_MARKS = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };
const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
const VIEWED_MARKS = { viewed: '<span class="viewed-mark" title="Viewed">✓</span>', changed: '<span class="viewed-mark changed" title="Changed since viewed">↻</span>', unviewed: "" };

// The stack (s) and the branch's files (f) show and hide on their own; with both hidden, the sidebar goes. boot.js applies the saved choice before the first paint.
const PANELS = { stack: "no-stack", files: "no-files" };

function togglePanel(panel) {
  const hidden = root.classList.toggle(PANELS[panel]);
  localStorage.setItem(`diffview.panel.${panel}`, hidden ? "hidden" : "shown");
}

export const toggleStackPanel = () => togglePanel("stack");
export const toggleFilesPanel = () => togglePanel("files");

/* The stack */

/** The folder-like prefix every branch in the stack shares, such as "ans-feature/", shown once instead of on every row. */
function sharedPrefix(names) {
  if (names.length < 2) return "";
  let prefix = names[0].slice(0, names[0].lastIndexOf("/") + 1);
  while (prefix && !names.every((name) => name.startsWith(prefix))) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
  return prefix;
}

function commentBadge(counts) {
  if (!counts?.unresolved) return "";
  const turn = counts.yourTurn ? " badge-turn" : "";
  const title = counts.yourTurn ? `${counts.unresolved} unresolved, ${counts.yourTurn} waiting on you` : `${counts.unresolved} unresolved`;
  return `<span class="badge badge-comments${turn}" title="${title}">${counts.unresolved}</span>`;
}

/** Whether the stack has an overview row: a stack of several branches, or one with a stack description. */
export function hasOverview() {
  return state.stack.entries.length > 1 || Boolean(state.stack.stackEntry);
}

function overviewRow() {
  const active = state.overview ? " active" : "";
  const href = `?${new URLSearchParams({ stack: state.stackOf, overview: "" })}`;
  return `<li><a class="stack-row overview-row${active}" href="${href}" data-overview title="The stack's description and every branch in it">
    <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg><span class="name">Overview</span>${commentBadge(state.stack.comments?.[state.stack.stackEntry])}</a></li>`;
}

/**
 * How far a branch's review got, for its line in the stack: {done, html}.
 * Only the branch's own mark (v) makes it viewed; files viewed one by one
 * show as progress.
 */
function viewedProgress(size) {
  if (size?.branch === "viewed") return { done: true, html: '<span class="stack-viewed-mark" title="You marked this branch viewed">✓ viewed</span>' };
  if (size?.branch === "changed") return { done: false, html: '<span class="stack-changed" title="Changed since you marked it viewed">↻ changed</span>' };
  if (size?.viewed) return { done: false, html: `<span title="Files viewed">${size.viewed}/${size.files} files</span>` };
  return { done: false, html: "" };
}

const DOT_MIN = 4;
const DOT_MAX = 16;
/** Changed lines at which a dot reaches DOT_MAX; bigger branches are capped there. */
const DOT_MAX_LINES = 1000;

/**
 * A branch's dot diameter in px, on a log scale of its changed lines, so a
 * 10-line branch differs from a 100-line one as much as 100 does from 1,000.
 * Even, so the dot centers on the 2px stack line without blurring.
 */
function dotDiameter(size) {
  const lines = size.additions + size.deletions;
  const scale = Math.min(1, Math.log10(1 + lines) / Math.log10(1 + DOT_MAX_LINES));
  return 2 * Math.round((DOT_MIN + scale * (DOT_MAX - DOT_MIN)) / 2);
}

/** A branch's "merged" or "pushed" badge, from the server's merge state; empty when it is in neither trunk. */
export function mergeBadge(branch) {
  const trunk = state.stack?.trunk ?? "trunk";
  const merged = state.mergeState?.[branch];
  if (merged === "pushed") return `<span class="badge badge-merged" title="In ${escapeHtml(trunk)} and origin/${escapeHtml(trunk)}">pushed</span>`;
  if (merged === "merged") return `<span class="badge badge-merged" title="In ${escapeHtml(trunk)}, not yet in origin/${escapeHtml(trunk)}">merged</span>`;
  return "";
}

export function renderStack() {
  const { entries, trunk } = state.stack;
  const checkedOut = state.stack.checkedOut;
  const prefix = sharedPrefix(entries.map((e) => e.id));
  $("#stack-meta").textContent = `${prefix} · ${entries.length} ${entries.length === 1 ? "branch" : "branches"}`.replace(/^ · /, "");
  const rows = stackRows(entries).map(({ entry, depth }, index) => {
    const badges = [
      mergeBadge(entry.id),
      commentBadge(state.stack.comments?.[entry.id]),
      entry.id === checkedOut ? '<span class="badge badge-head" title="Checked out">HEAD</span>' : "",
      entry.needsRestack ? `<span class="badge badge-warn" title="Its base is no longer ${escapeHtml(entry.parent)}'s tip">restack</span>` : "",
      entry.pr ? `<span class="badge">#${entry.pr.number}</span>` : "",
    ].join("");
    const active = !state.overview && entry.id === state.branch ? " active" : "";
    const top = index === 0 ? " stack-top" : "";
    const size = shownSize(state.stackSizes?.[entry.id]);
    const viewed = viewedProgress(size);
    const sizeText = size ? `<span class="add">+${size.additions}</span> <span class="del">−${size.deletions}</span>${viewed.html ? ` · ${viewed.html}` : ""}` : "";
    const merged = state.mergeState?.[entry.id] ? " stack-merged" : "";
    const dotStyle = size ? ` style="--dot:${dotDiameter(size)}px"` : "";
    return `<li><a class="stack-row${top}${active}${viewed.done ? " stack-viewed" : ""}${merged}" href="?${new URLSearchParams({ branch: entry.id, stack: state.stackOf })}" data-branch="${escapeHtml(entry.id)}" style="--depth:${depth}" title="${escapeHtml(entry.id)} (from ${escapeHtml(entry.source)})">
      <span class="dot"${dotStyle}></span><span class="stack-label"><span class="name">${escapeHtml(entry.id.slice(prefix.length))}</span><span class="stack-size">${sizeText}</span></span>${badges}</a></li>`;
  });
  rows.push(`<li><span class="stack-row trunk"><span class="dot"></span><span class="name">${escapeHtml(trunk ?? "trunk")}</span></span></li>`);
  if (hasOverview()) rows.unshift(overviewRow());
  $("#stack").innerHTML = rows.join("");
}

/* The filter menu */

const CHECK = '<svg class="icon menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/** The filter menu's contents: the kind to show, what to hide, and each extension the branch has, with counts. */
export function renderFilterMenu() {
  const files = state.diff?.files ?? [];
  const extensions = new Map();
  for (const f of files) extensions.set(extensionOf(f.path), (extensions.get(extensionOf(f.path)) ?? 0) + 1);
  const kinds = Object.entries(KIND_CHOICES)
    .map(([kind, label]) => `<button class="menu-item" type="button" role="menuitemradio" aria-checked="${filters.kind === kind}" data-filter-kind="${kind}">${label}${filters.kind === kind ? CHECK : ""}</button>`)
    .join("");
  const hides = Object.entries(HIDE_CHOICES)
    .map(([key, label]) => `<label class="menu-item">${label}<input type="checkbox" data-filter-hide="${key}"${filters[key] ? " checked" : ""}></label>`)
    .join("");
  const exts = [...extensions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([ext, n]) =>
        `<label class="menu-item">${escapeHtml(ext)} <span class="faint">${n}</span><input type="checkbox" data-filter-ext="${escapeHtml(ext)}"${filters.hiddenExtensions.includes(ext) ? "" : " checked"}></label>`,
    )
    .join("");
  $("#filter-menu").innerHTML = `<div class="menu-section"><h3>Kind</h3>${kinds}</div><div class="menu-section"><h3>Hide</h3>${hides}</div>${exts ? `<div class="menu-section"><h3>Extension</h3>${exts}</div>` : ""}`;
}

/** Opens the filter menu under its button, or closes it. */
export function toggleFilterMenu(open = $("#filter-menu").hidden) {
  const menu = $("#filter-menu");
  const button = $("#filter-btn");
  if (open) {
    renderFilterMenu();
    // Fixed, so the files panel's scrolling does not clip it.
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${r.left}px`;
  }
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  button.classList.toggle("active", open || hiddenSummary(state.diff?.files ?? []) !== "");
}

/* The branch's files */

export function renderTree() {
  const all = state.diff?.files ?? [];
  const summary = hiddenSummary(all);
  $("#hidden-summary").hidden = !summary;
  $("#hidden-summary-text").textContent = summary;
  $("#filter-btn").classList.toggle("active", !$("#filter-menu").hidden || summary !== "");
  if (!$("#filter-menu").hidden) renderFilterMenu();
  const files = all.filter(rendered);
  const query = $("#filter").value.trim().toLowerCase();
  const shown = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
  const byPath = new Map(all.map((f, i) => [f.path, { ...f, index: i }]));
  const listed = all.filter(counted);
  const viewed = listed.filter((f) => viewedState(f) === "viewed").length;
  $("#files-meta").textContent = listed.length ? (state.comments.enabled ? `${viewed}/${listed.length} viewed` : `${listed.length}`) : "";
  const renderNode = (node) => {
    const items = [];
    for (const [name, child] of node.dirs) {
      items.push(`<li><span class="dir-label">${CHEVRON}<span>${escapeHtml(name)}</span></span>${renderNode(child)}</li>`);
    }
    for (const path of node.files) {
      const f = byPath.get(path);
      items.push(`<li><a class="file file-${viewedState(f)}" href="#file-${f.index}" data-index="${f.index}" title="${escapeHtml(path)}">
        <span class="status status-${f.status}">${STATUS_MARKS[f.status] ?? "M"}</span>
        <span class="file-name">${escapeHtml(path.split("/").pop())}</span>${VIEWED_MARKS[viewedState(f)]}
        <span class="counts"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span></a></li>`);
    }
    return `<ul>${items.join("")}</ul>`;
  };
  const empty = state.overview ? "Pick a branch to see its files" : query ? "No matching files" : "No changes";
  $("#tree").innerHTML = shown.length ? renderNode(buildTree(shown.map((f) => f.path))) : `<div class="tree-empty">${empty}</div>`;
}
