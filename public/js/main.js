/**
 * The viewer: the stack in the sidebar, the selected branch's files below
 * it, and each file's diff rendered by Pierre's FileDiff in the main pane.
 * The URL names the branch shown and the branch whose stack the sidebar
 * shows, so moving within a stack keeps the sidebar steady.
 */
import { FileDiff, parsePatchFiles } from "/vendor/pierre.js";
import { escapeHtml, shortSha, startsCollapsed } from "./lib/format.js";
import { buildTree, stackRows } from "./lib/tree.js";

const $ = (selector) => document.querySelector(selector);
const root = document.documentElement;
const THEMES = ["auto", "light", "dark"];
const PREFERS_DARK = matchMedia("(prefers-color-scheme: dark)");
const PIERRE_THEMES = { light: "pierre-light", dark: "pierre-dark" };
const STATUS_MARKS = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" };
const LAYOUTS = ["auto", "split", "unified"];
// Under Auto, the narrowest diff pane that gets split diffs: each side then still shows about 60 columns of code.
const AUTO_SPLIT_MIN_WIDTH = 1000;

const state = {
  info: null,
  stackOf: null,
  branch: null,
  stack: null,
  diff: null,
  views: [],
  layout: localStorage.getItem("diffview.layout") || "auto",
  diffStyle: null,
};

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

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

/* Theme and layout */

function applyTheme() {
  const pref = localStorage.getItem("diffview.theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && PREFERS_DARK.matches);
  root.dataset.theme = dark ? "dark" : "light";
  $("#theme").dataset.pref = pref;
  $("#theme").title = `Theme: ${pref}. Click to change.`;
  for (const { view } of state.views) view.setThemeType(root.dataset.theme);
}

function cycleTheme() {
  const pref = localStorage.getItem("diffview.theme") || "auto";
  localStorage.setItem("diffview.theme", THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length]);
  applyTheme();
}

/** The diff style shown: the chosen one, or under Auto, split when the pane is wide enough. */
function effectiveLayout() {
  if (state.layout !== "auto") return state.layout;
  return $("#main").clientWidth >= AUTO_SPLIT_MIN_WIDTH ? "split" : "unified";
}

/** Re-renders the diffs if the style shown should change, as when the window or sidebar resizes under Auto. */
function applyLayout() {
  const diffStyle = effectiveLayout();
  $('[data-layout="auto"]').title = `Split when the window is wide enough, else one column; now ${diffStyle} (s)`;
  if (diffStyle === state.diffStyle) return;
  state.diffStyle = diffStyle;
  for (const item of state.views) {
    item.options = { ...item.options, diffStyle };
    item.view.setOptions(item.options);
    item.view.rerender();
  }
}

function setLayout(layout) {
  state.layout = layout;
  localStorage.setItem("diffview.layout", layout);
  for (const button of document.querySelectorAll("[data-layout]")) button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  applyLayout();
}

function toggleSidebar() {
  const hidden = root.classList.toggle("no-sidebar");
  localStorage.setItem("diffview.sidebar", hidden ? "hidden" : "shown");
}

/* Sidebar: the stack */

/** The folder-like prefix every branch in the stack shares, such as "ans-feature/", shown once instead of on every row. */
function sharedPrefix(names) {
  if (names.length < 2) return "";
  let prefix = names[0].slice(0, names[0].lastIndexOf("/") + 1);
  while (prefix && !names.every((name) => name.startsWith(prefix))) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
  return prefix;
}

function renderStack() {
  const { entries, trunk } = state.stack;
  const checkedOut = state.stack.checkedOut;
  const prefix = sharedPrefix(entries.map((e) => e.id));
  $("#stack-meta").textContent = `${prefix} · ${entries.length} ${entries.length === 1 ? "branch" : "branches"}`.replace(/^ · /, "");
  const rows = stackRows(entries).map(({ entry, depth }) => {
    const badges = [
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

/* Sidebar: the branch's files */

const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

function renderTree() {
  const files = state.diff?.files ?? [];
  const query = $("#filter").value.trim().toLowerCase();
  const shown = query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files;
  const byPath = new Map(files.map((f, i) => [f.path, { ...f, index: i }]));
  $("#files-meta").textContent = files.length ? `${files.length}` : "";
  const renderNode = (node) => {
    const items = [];
    for (const [name, child] of node.dirs) {
      items.push(`<li><span class="dir-label">${CHEVRON}<span>${escapeHtml(name)}</span></span>${renderNode(child)}</li>`);
    }
    for (const path of node.files) {
      const f = byPath.get(path);
      items.push(`<li><a class="file" href="#file-${f.index}" data-index="${f.index}" title="${escapeHtml(path)}">
        <span class="status status-${f.status}">${STATUS_MARKS[f.status] ?? "M"}</span>
        <span class="file-name">${escapeHtml(path.split("/").pop())}</span>
        <span class="counts"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span></a></li>`);
    }
    return `<ul>${items.join("")}</ul>`;
  };
  $("#tree").innerHTML = shown.length ? renderNode(buildTree(shown.map((f) => f.path))) : `<div class="tree-empty">${query ? "No matching files" : "No changes"}</div>`;
}

/* Main pane */

function renderBranchHead() {
  const { entry, files, uncommitted } = state.diff;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const parent = entry.parent ?? state.stack.trunk ?? "trunk";
  const pr = entry.pr ? (entry.pr.url ? `<a href="${escapeHtml(entry.pr.url)}" target="_blank" rel="noreferrer">#${entry.pr.number}</a>` : `#${entry.pr.number}`) : "";
  $("#branch-head").innerHTML = `
    <h1>${escapeHtml(entry.id)} ${pr}</h1>
    <p class="branch-meta">
      on <strong>${escapeHtml(parent)}</strong>
      <span class="faint">${shortSha(entry.base)}..${uncommitted ? "working tree" : shortSha(entry.head)}</span>
      · ${files.length} ${files.length === 1 ? "file" : "files"} <span class="add">+${additions}</span> <span class="del">−${deletions}</span>
      · from ${escapeHtml(entry.source)}
      ${entry.needsRestack ? '<span class="badge badge-warn">needs restack</span>' : ""}
      ${uncommitted ? '<span class="badge badge-head" title="Includes edits not yet committed">uncommitted changes</span>' : ""}
    </p>`;
  $("#branch-name").textContent = entry.id;
  document.title = `${entry.id} · diffview`;
}

function openInCursor(file) {
  const link = document.createElement("a");
  link.className = "open-editor";
  link.href = `cursor://file${encodeURI(`${state.info.top}/${file.path}`)}:${file.firstLine}`;
  link.textContent = "Open";
  link.title = "Open in Cursor";
  return link;
}

function cleanUpViews() {
  for (const { view } of state.views) view.cleanUp();
  state.views = [];
}

/** Pairs each summarized file with Pierre's parse of it. Both come from one patch, so names match. */
function parsedByPath(patch) {
  const byPath = new Map();
  for (const file of parsePatchFiles(patch).flatMap((p) => p.files)) byPath.set(file.name, file);
  return byPath;
}

function renderFiles() {
  cleanUpViews();
  const container = $("#diffs");
  container.replaceChildren();
  const parsed = parsedByPath(state.diff.patch);
  state.diff.files.forEach((file, index) => {
    const section = document.createElement("section");
    section.className = "file-diff";
    section.id = `file-${index}`;
    container.append(section);
    const fileDiff = parsed.get(file.path);
    if (file.binary || !fileDiff) {
      section.innerHTML = `<div class="file-placeholder"><strong>${escapeHtml(file.path)}</strong> <span class="faint">${file.binary ? "binary file" : "no textual changes"}</span></div>`;
      return;
    }
    const item = { file, view: null, options: null };
    item.options = {
      diffStyle: state.diffStyle,
      theme: PIERRE_THEMES,
      themeType: root.dataset.theme,
      overflow: "scroll",
      lineDiffType: "word-alt",
      hunkSeparators: "line-info",
      collapsed: startsCollapsed(file),
      renderHeaderMetadata: () => openInCursor(file),
    };
    item.view = new FileDiff(item.options);
    item.view.render({ fileDiff, containerWrapper: section });
    state.views.push(item);
  });
  if (!state.diff.files.length) container.innerHTML = '<p class="empty">This branch changes nothing.</p>';
}

/* Loading */

async function loadStack() {
  state.stack = await getJson(`/api/stack?${new URLSearchParams({ branch: state.stackOf })}`);
  const source = [...new Set(state.stack.entries.map((e) => e.source))].join(", ");
  $("#source-chip").textContent = source;
  $("#source-chip").title = "Where this stack's parents came from";
  $("#source-chip").hidden = false;
  renderStack();
}

async function loadDiff({ force = false } = {}) {
  const diff = await getJson(`/api/diff?${new URLSearchParams({ branch: state.branch, stack: state.stackOf })}`);
  if (!force && diff.sha === state.diff?.sha && diff.entry.base === state.diff.entry.base) return;
  const scroll = scrollY;
  state.diff = diff;
  renderBranchHead();
  renderTree();
  renderFiles();
  if (!force) scrollTo(0, scroll);
}

async function show(branch, { push = true } = {}) {
  state.branch = branch;
  if (push) writeLocation();
  renderStack();
  try {
    await loadDiff({ force: true });
    scrollTo(0, 0);
  } catch (err) {
    toast(err.message);
  }
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await loadStack();
      await loadDiff();
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
}

/* Keys */

function moveBranch(step) {
  const rows = stackRows(state.stack.entries).map((r) => r.entry.id);
  const next = rows[rows.indexOf(state.branch) - step];
  if (next) show(next);
}

function moveFile(step) {
  const sections = [...document.querySelectorAll(".file-diff")];
  const current = sections.findIndex((s) => s.getBoundingClientRect().top > 60);
  const target = sections[Math.max(0, Math.min(sections.length - 1, (current === -1 ? sections.length : current) + (step > 0 ? 0 : -2)))];
  target?.scrollIntoView({ block: "start" });
}

function onKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea")) return;
  const actions = {
    "/": () => $("#filter").focus(),
    "\\": toggleSidebar,
    f: toggleSidebar,
    s: () => setLayout(LAYOUTS[(LAYOUTS.indexOf(state.layout) + 1) % LAYOUTS.length]),
    "[": () => moveBranch(-1),
    "]": () => moveBranch(1),
    j: () => moveFile(1),
    k: () => moveFile(-1),
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

/* Start */

async function main() {
  state.info = await getJson("/api/info");
  $("#repo-name").textContent = state.info.repo;
  readLocation();
  applyTheme();
  setLayout(state.layout);
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
  document.addEventListener("keydown", onKey);
  new ResizeObserver(applyLayout).observe($("#main"));
  addEventListener("popstate", () => {
    readLocation();
    show(state.branch, { push: false });
  });
  try {
    await loadStack();
    await loadDiff({ force: true });
  } catch (err) {
    $("#branch-head").innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
  connectLive();
}

main();
