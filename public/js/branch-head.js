/** The header above a branch's description and diff: its name, PR, parent, range and counts. */
import { renderBranchViewed } from "./comments.js";
import { counted } from "./filters.js";
import { escapeHtml, shortSha } from "./lib/format.js";
import { $, state } from "./state.js";

export function renderBranchHead() {
  const { entry, uncommitted } = state.diff;
  const files = state.diff.files.filter(counted);
  const hidden = state.diff.files.length - files.length;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const parent = entry.parent ?? state.stack.trunk ?? "trunk";
  const pr = entry.pr ? (entry.pr.url ? `<a href="${escapeHtml(entry.pr.url)}" target="_blank" rel="noreferrer">#${entry.pr.number}</a>` : `#${entry.pr.number}`) : "";
  const old = state.version
    ? `<p class="old-version">Showing v${state.version.seq} of ${state.version.latestSeq}, as it was ${new Date(state.version.observedAt).toLocaleString()}. <button class="link" type="button" data-latest>Back to the latest</button></p>`
    : "";
  $("#branch-head").innerHTML = `${old}
    <h1>${escapeHtml(entry.id)} ${pr}</h1>
    <p class="branch-meta">
      on <strong>${escapeHtml(parent)}</strong>
      <span class="faint">${shortSha(entry.base)}..${uncommitted ? "working tree" : shortSha(entry.head)}</span>
      · ${files.length} ${files.length === 1 ? "file" : "files"} <span class="add">+${additions}</span> <span class="del">−${deletions}</span>
      ${hidden ? `<span class="faint" title="Tests and generated files, not counted while hidden">(${hidden} hidden)</span>` : ""}
      · from ${escapeHtml(entry.source)}
      ${entry.needsRestack ? '<span class="badge badge-warn">needs restack</span>' : ""}
      <span id="branch-viewed"></span>
    </p>`;
  $("#comment-branch").hidden = !state.comments.enabled;
  $("#comment-branch").textContent = "Comment on the whole branch";
  $("#branch-name").textContent = entry.id;
  document.title = `${entry.id} · diffview`;
  renderBranchViewed();
}
