/**
 * The stack's overview page: the stack's description above (description.js
 * draws it, and it takes comments like a branch's), then every branch in
 * the stack with its title, first paragraph and size, in the sidebar's order.
 */
import { cleanUpViews } from "./diffs.js";
import { shownSize } from "./filters.js";
import { mergeBadge } from "./sidebar.js";
import { escapeHtml } from "./lib/format.js";
import { stackRows } from "./lib/tree.js";
import { $, state } from "./state.js";

function sum(branches, key) {
  return branches.reduce((n, b) => n + b[key], 0);
}

export function renderOverview() {
  const { entry } = state.overview;
  const branches = state.overview.branches.map((b) => ({ ...b, ...shownSize(b) }));
  const { trunk } = state.stack;
  $("#branch-head").innerHTML = `
    <h1>Stack overview</h1>
    <p class="branch-meta">
      ${branches.length} ${branches.length === 1 ? "branch" : "branches"} on <strong>${escapeHtml(trunk ?? "trunk")}</strong>
      · ${sum(branches, "files")} files <span class="add">+${sum(branches, "additions")}</span> <span class="del">−${sum(branches, "deletions")}</span>
    </p>`;
  $("#branch-name").textContent = "Overview";
  document.title = `Overview · ${state.stackOf} · diffview`;
  $("#comment-branch").hidden = !(state.comments.enabled && entry);
  $("#comment-branch").textContent = "Comment on the whole stack";

  cleanUpViews();
  const byId = new Map(branches.map((b) => [b.id, b]));
  const rows = stackRows(state.stack.entries).map(({ entry: e }) => {
    const b = byId.get(e.id);
    const counts = state.stack.comments?.[e.id];
    const pr = e.pr ? `<span class="badge">#${e.pr.number}</span>` : "";
    const comments = counts?.unresolved ? `<span class="badge badge-comments${counts.yourTurn ? " badge-turn" : ""}">${counts.unresolved}</span>` : "";
    return `<li class="overview-branch">
      <div class="overview-branch-head">
        <a href="?${new URLSearchParams({ branch: e.id, stack: state.stackOf })}" data-branch="${escapeHtml(e.id)}">${escapeHtml(b.title ?? e.id)}</a>
        ${mergeBadge(e.id)}${pr}${comments}
        <span class="counts"><span class="add">+${b.additions}</span> <span class="del">−${b.deletions}</span></span>
      </div>
      ${b.title ? `<p class="overview-branch-name">${escapeHtml(e.id)}</p>` : ""}
      ${b.summaryHtml ? `<p class="overview-summary">${b.summaryHtml}</p>` : '<p class="overview-summary faint">No description yet.</p>'}
    </li>`;
  });
  $("#diffs").innerHTML = `<ol class="overview-branches">${rows.join("")}</ol>`;
}
