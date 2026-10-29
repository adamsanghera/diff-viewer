/** The sidebar: the stack, the branch's files, and showing or hiding it. */
import { viewedState } from "./comments.js";
import { escapeHtml } from "./lib/format.js";
import { counted, KINDS, rendered, shownKinds, shownSize } from "./kinds.js";
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

/** How much of a branch is viewed, for its line in the stack: {done, html}, from its size's viewed and changed file counts. */
function viewedProgress(size) {
  if (!size?.files) return { done: false, html: "" };
  if (size.viewed === size.files) return { done: true, html: '<span class="stack-viewed-mark" title="Every file viewed">✓ viewed</span>' };
  if (size.changed) return { done: false, html: `<span class="stack-changed" title="${size.changed} changed since you viewed them">↻ changed</span>` };
  if (size.viewed) return { done: false, html: `<span title="Files viewed">${size.viewed}/${size.files} viewed</span>` };
  return { done: false, html: "" };
}

export function renderStack() {
  const { entries, trunk } = state.stack;
  const checkedOut = state.stack.checkedOut;
  const prefix = sharedPrefix(entries.map((e) => e.id));
  $("#stack-meta").textContent = `${prefix} · ${entries.length} ${entries.length === 1 ? "branch" : "branches"}`.replace(/^ · /, "");
  const rows = stackRows(entries).map(({ entry, depth }, index) => {
    const badges = [
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
    return `<li><a class="stack-row${top}${active}${viewed.done ? " stack-viewed" : ""}" href="?${new URLSearchParams({ branch: entry.id, stack: state.stackOf })}" data-branch="${escapeHtml(entry.id)}" style="--depth:${depth}" title="${escapeHtml(entry.id)} (from ${escapeHtml(entry.source)})">
      <span class="dot"></span><span class="stack-label"><span class="name">${escapeHtml(entry.id.slice(prefix.length))}</span><span class="stack-size">${sizeText}</span></span>${badges}</a></li>`;
  });
  rows.push(`<li><span class="stack-row trunk"><span class="dot"></span><span class="name">${escapeHtml(trunk ?? "trunk")}</span></span></li>`);
  if (hasOverview()) rows.unshift(overviewRow());
  $("#stack").innerHTML = rows.join("");
}

/* The branch's files */

/** Toggles for showing tests and generated files, with how many the branch has; only kinds the branch has. */
function renderKindFilters(files) {
  const toggles = Object.entries(KINDS)
    .map(([kind, label]) => [kind, label, files.filter((f) => f.kind === kind).length])
    .filter(([, , n]) => n > 0)
    .map(
      ([kind, label, n]) =>
        `<button class="kind-toggle" type="button" data-show-kind="${kind}" aria-pressed="${shownKinds.has(kind)}" title="${shownKinds.has(kind) ? "Hide" : "Show"} ${label.toLowerCase()} files">${label} <span class="faint">${n}</span></button>`,
    );
  $("#kind-filters").innerHTML = toggles.join("");
  $("#kind-filters").hidden = !toggles.length;
}

export function renderTree() {
  const all = state.diff?.files ?? [];
  renderKindFilters(all);
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
