/** The sidebar: the stack, the branch's files, and showing or hiding it. */
import { viewedState } from "./comments.js";
import { escapeHtml } from "./lib/format.js";
import { buildTree, stackRows } from "./lib/tree.js";
import { $, root, state } from "./state.js";

const STATUS_MARKS = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };
const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
const VIEWED_MARKS = { viewed: '<span class="viewed-mark" title="Viewed">✓</span>', changed: '<span class="viewed-mark changed" title="Changed since viewed">↻</span>', unviewed: "" };

export function toggleSidebar() {
  const hidden = root.classList.toggle("no-sidebar");
  localStorage.setItem("diffview.sidebar", hidden ? "hidden" : "shown");
}

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

export function renderStack() {
  const { entries, trunk } = state.stack;
  const checkedOut = state.stack.checkedOut;
  const prefix = sharedPrefix(entries.map((e) => e.id));
  $("#stack-meta").textContent = `${prefix} · ${entries.length} ${entries.length === 1 ? "branch" : "branches"}`.replace(/^ · /, "");
  const rows = stackRows(entries).map(({ entry, depth }) => {
    const badges = [
      commentBadge(state.stack.comments?.[entry.id]),
      entry.id === checkedOut ? '<span class="badge badge-head" title="Checked out">HEAD</span>' : "",
      entry.needsRestack ? `<span class="badge badge-warn" title="Its base is no longer ${escapeHtml(entry.parent)}'s tip">restack</span>` : "",
      entry.pr ? `<span class="badge">#${entry.pr.number}</span>` : "",
    ].join("");
    const active = entry.id === state.branch ? " active" : "";
    return `<li><a class="stack-row${active}" href="?${new URLSearchParams({ branch: entry.id, stack: state.stackOf })}" data-branch="${escapeHtml(entry.id)}" style="--depth:${depth}" title="${escapeHtml(entry.id)} (from ${escapeHtml(entry.source)})">
      <span class="dot"></span><span class="name">${escapeHtml(entry.id.slice(prefix.length))}</span>${badges}</a></li>`;
  });
  rows.push(`<li><span class="stack-row trunk"><span class="dot"></span><span class="name">${escapeHtml(trunk ?? "trunk")}</span></span></li>`);
  $("#stack").innerHTML = rows.join("");
}

/* The branch's files */

export function renderTree() {
  const files = state.diff?.files ?? [];
  const query = $("#filter").value.trim().toLowerCase();
  const shown = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
  const byPath = new Map(files.map((f, i) => [f.path, { ...f, index: i }]));
  const viewed = files.filter((f) => viewedState(f) === "viewed").length;
  $("#files-meta").textContent = files.length ? (state.comments.enabled ? `${viewed}/${files.length} viewed` : `${files.length}`) : "";
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
  $("#tree").innerHTML = shown.length ? renderNode(buildTree(shown.map((f) => f.path))) : `<div class="tree-empty">${query ? "No matching files" : "No changes"}</div>`;
}
