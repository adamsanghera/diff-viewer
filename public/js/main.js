/**
 * The viewer: the stack in the sidebar, the selected branch's files below
 * it, and each file's diff rendered by Pierre's FileDiff in the main pane,
 * with comments (comments.js) beside or under the lines.
 * The URL names the branch shown and the branch whose stack the sidebar
 * shows, so moving within a stack keeps the sidebar steady.
 *
 * This module loads what the page shows and wires the pieces together:
 * theme.js, diffs.js (files and layout), sidebar.js, branch-head.js,
 * description.js, comments.js and shortcuts.js draw and handle the rest.
 */
import { renderBranchHead } from "./branch-head.js";
import { commentHooks, composerOpen, initComments, loadComments, renderComments, scheduleLayout, threadsInline } from "./comments.js";
import { renderDescription } from "./description.js";
import { applyLayout, renderFiles, rerenderFiles, setLayout } from "./diffs.js";
import { escapeHtml } from "./lib/format.js";
import { reportLoad } from "./perf.js";
import { installShortcuts } from "./shortcuts.js";
import { renderStack, renderTree, toggleSidebar } from "./sidebar.js";
import { $, getJson, state, toast } from "./state.js";
import { applyTheme, cycleTheme, PREFERS_DARK } from "./theme.js";

/* Location */

function readLocation() {
  const params = new URLSearchParams(location.search);
  state.branch = params.get("branch") || state.info.initialBranch;
  state.stackOf = params.get("stack") || state.branch;
}

function writeLocation() {
  const params = new URLSearchParams({ branch: state.branch });
  if (state.stackOf !== state.branch) params.set("stack", state.stackOf);
  history.pushState(null, "", `/view?${params}`);
}

/* Loading */

async function loadDescription() {
  if (!state.comments.enabled) return;
  const { description } = await getJson(`/api/description?${new URLSearchParams({ branch: state.branch })}`);
  if (description?.sha256 === state.description?.sha256 && $("#description").innerHTML) return;
  state.description = description;
  renderDescription();
}

async function loadStack() {
  state.stack = await getJson(`/api/stack?${new URLSearchParams({ branch: state.stackOf })}`);
  const source = [...new Set(state.stack.entries.map((e) => e.source))].join(", ");
  $("#source-chip").textContent = source;
  $("#source-chip").title = "Where this stack's parents came from";
  $("#source-chip").hidden = false;
  renderStack();
}

async function loadDiff({ force = false } = {}) {
  const params = new URLSearchParams({ branch: state.branch, stack: state.stackOf });
  if (state.version) params.set("v", String(state.version.seq));
  const diff = await getJson(`/api/diff?${params}`);
  if (!force && diff.sha === state.diff?.sha && diff.entry.base === state.diff.entry.base) {
    state.diff.version = diff.version;
    return false;
  }
  const scroll = scrollY;
  state.diff = diff;
  if (state.version) state.version = diff.version;
  renderBranchHead();
  renderFiles();
  renderTree();
  if (!force) scrollTo(0, scroll);
  return true;
}

async function show(branch, { push = true, version = null } = {}) {
  const started = performance.now();
  state.branch = branch;
  state.version = version === null ? null : { seq: version };
  state.comments.active = null;
  state.comments.listMode = false;
  if (push) writeLocation();
  renderStack();
  try {
    state.description = null;
    await Promise.all([loadDiff({ force: true }), loadDescription()]);
    await loadComments();
    scrollTo(0, 0);
    reportLoad(`Showed ${branch}`, started);
  } catch (err) {
    toast(err.message);
  }
}

let refreshing = null;
/** Brings the page up to date with the repo. While a comment is being written, it waits, so lines never move under it. */
async function refresh() {
  if (composerOpen()) {
    state.reloadWaiting = true;
    $("#live").dataset.state = "held";
    $("#live").title = "Live reload: waiting while you write a comment";
    return;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await loadStack();
      if (!state.version) await loadDiff();
      await loadDescription();
      await loadComments();
    } catch (err) {
      toast(err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function connectLive() {
  const live = $("#live");
  const events = new EventSource("/api/events");
  events.onopen = () => {
    live.dataset.state = "on";
    live.title = "Live reload: connected";
  };
  events.onerror = () => {
    live.dataset.state = "off";
    live.title = "Live reload: reconnecting";
  };
  events.addEventListener("change", refresh);
  if (state.comments.enabled) {
    const store = new EventSource("/api/store-events");
    store.addEventListener("change", async () => {
      try {
        if (!composerOpen()) await loadDescription();
        await loadComments();
        await loadStack();
      } catch {
        // The server may be restarting; the next change retries.
      }
    });
  }
}

/* Start */

let wasInline = null;
/** After the window or sidebar resizes: the diff style under Auto, and whether the rail still fits. */
function onResize() {
  applyLayout();
  const inline = threadsInline();
  if (wasInline !== null && inline !== wasInline) {
    renderComments();
    rerenderFiles();
  }
  wasInline = inline;
  scheduleLayout();
}

async function main() {
  state.info = await getJson("/api/info");
  $("#repo-name").textContent = state.info.repo;
  readLocation();
  applyTheme();
  setLayout(state.layout);
  Object.assign(commentHooks, {
    rerenderFiles,
    renderTree,
    showVersion: (seq) => show(state.branch, { push: false, version: seq }),
    refreshAfterComposer: refresh,
  });
  initComments();
  installShortcuts({ show });
  $("#theme").addEventListener("click", cycleTheme);
  PREFERS_DARK.addEventListener("change", applyTheme);
  $("#toggle-sidebar").addEventListener("click", toggleSidebar);
  for (const button of document.querySelectorAll("[data-layout]")) button.addEventListener("click", () => setLayout(button.dataset.layout));
  $("#stack").addEventListener("click", (event) => {
    const row = event.target.closest("a[data-branch]");
    if (!row || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    show(row.dataset.branch);
  });
  $("#branch-head").addEventListener("click", (event) => {
    if (event.target.closest("[data-latest]")) show(state.branch, { push: false });
  });
  $("#tree").addEventListener("click", (event) => {
    const link = event.target.closest("a[data-index]");
    if (!link) return;
    event.preventDefault();
    document.getElementById(`file-${link.dataset.index}`)?.scrollIntoView({ block: "start" });
  });
  $("#filter").addEventListener("input", renderTree);
  $("#filter").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.value = "";
      renderTree();
      event.target.blur();
    }
  });
  new ResizeObserver(onResize).observe($("#main"));
  addEventListener("popstate", () => {
    readLocation();
    show(state.branch, { push: false });
  });
  try {
    await loadStack();
    await Promise.all([loadDiff({ force: true }), loadDescription()]);
    await loadComments();
    reportLoad(`Loaded ${state.branch}`, 0);
  } catch (err) {
    $("#branch-head").innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
  connectLive();
}

main();
