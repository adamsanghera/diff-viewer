/**
 * Comments in the page: picking lines in a diff, the composer, threads in
 * the margin rail or inline under their lines, the list of all threads,
 * batches, viewed marks, and the version list.
 *
 * Pierre renders each file into an open shadow root. Lines are picked with
 * its line selection, which reports a side and a range of line numbers.
 * The rail finds a thread's rows inside the shadow root to sit level with
 * them, and marks them with attributes that styles passed in through
 * Pierre's unsafeCSS option tint. Pierre redraws rows on every render, so
 * the marks are applied again after each one.
 */
import { stackCards } from "./lib/card-stack.js";
import { anchorLabel, railHead, railList, threadCard } from "./lib/cards.js";
import { escapeHtml } from "./lib/format.js";
import { keyHint, submitMode } from "./lib/keys.js";
import { $, autosize, getJson, PIERRE_SIDE, postJson, root, SIDE_OF, state, toast } from "./state.js";

const RAIL_GAP = 16;
const CARD_GAP = 8;
// The narrowest diff pane the rail may leave beside it. Below this, threads show inline instead.
const MIN_DIFF_WIDTH_BESIDE_RAIL = 640;
const RAIL_WIDTH = 300;

/** Styles that reach into Pierre's shadow roots: tints on commented rows. */
export const ROW_MARK_CSS = `
[data-dv-comment] { background-image: linear-gradient(var(--dv-tint), var(--dv-tint)); box-shadow: inset 3px 0 0 var(--dv-mark); cursor: pointer; }
[data-dv-comment="open"] { --dv-mark: #d4a72c; --dv-tint: rgba(212, 167, 44, 0.14); --dv-tint-active: rgba(212, 167, 44, 0.32); }
[data-dv-comment="turn"] { --dv-mark: #2f6feb; --dv-tint: rgba(47, 111, 235, 0.12); --dv-tint-active: rgba(47, 111, 235, 0.28); }
[data-dv-comment="suggested"] { --dv-mark: #1a7f37; --dv-tint: rgba(26, 127, 55, 0.12); --dv-tint-active: rgba(26, 127, 55, 0.28); }
[data-dv-comment="pending"] { --dv-mark: #8c959f; --dv-tint: rgba(140, 149, 159, 0.14); --dv-tint-active: rgba(140, 149, 159, 0.3); }
[data-dv-active] { background-image: linear-gradient(var(--dv-tint-active), var(--dv-tint-active)); box-shadow: inset 4px 0 0 var(--dv-mark); }
`;

/** Set by main.js: re-renders the diffs, as when threads move between the rail and inline. */
export const commentHooks = { rerenderFiles() {}, showVersion() {}, refreshAfterComposer() {}, renderTree() {} };

const batching = () => state.comments.pendingCount > 0;

/* Which threads show where */

/** Threads that sit at their lines on the version shown: unresolved and not outdated. */
function placedThreads() {
  return state.comments.threads.filter((t) => t.status !== "resolved" && t.state !== "outdated");
}

/** Whether threads show inline: the person chose it, or the rail does not fit beside the diff. */
export function threadsInline() {
  if (state.comments.inline) return true;
  const width = $("#main").clientWidth;
  return width - RAIL_WIDTH - RAIL_GAP < MIN_DIFF_WIDTH_BESIDE_RAIL;
}

function railShown() {
  return state.comments.enabled && (state.comments.listMode || (!threadsInline() && placedThreads().length > 0));
}

/** Pierre line annotations for a file's threads, when they show inline. */
export function lineAnnotationsFor(file) {
  if (!threadsInline()) return [];
  return placedThreads()
    .filter((t) => t.kind !== "branch" && t.path === file.path)
    .map((t) => ({ side: PIERRE_SIDE[t.side ?? "new"], lineNumber: t.kind === "file" ? 0 : t.endLine, metadata: { id: t.id } }));
}

/** Renders a thread's card for Pierre's inline annotation slot. */
export function renderAnnotation(annotation) {
  const thread = state.comments.threads.find((t) => t.id === annotation.metadata.id);
  const el = document.createElement("div");
  el.className = "inline-thread";
  el.dataset.inlineThread = String(annotation.metadata.id);
  if (thread) el.innerHTML = threadCard(thread, { expanded: thread.id === state.comments.active, batching: batching() });
  return el;
}

/* Rows inside Pierre's shadow roots */

/** The row showing `line` on `side` of a rendered file, or null when it is not on screen (collapsed, or outside the hunks). */
function rowFor(item, side, line) {
  const shadow = item.section.firstElementChild?.shadowRoot;
  if (!shadow) return null;
  const unified = shadow.querySelector("code[data-unified]");
  if (unified) {
    for (const row of unified.querySelectorAll("[data-line]")) {
      const type = row.dataset.lineType;
      if (side === "new" && type !== "change-deletion" && Number(row.dataset.line) === line) return row;
      if (side === "old" && type === "change-deletion" && Number(row.dataset.line) === line) return row;
      if (side === "old" && type === "context" && Number(row.dataset.altLine) === line) return row;
    }
    return null;
  }
  const code = shadow.querySelector(side === "new" ? "code[data-additions]" : "code[data-deletions]");
  return code?.querySelector(`[data-line="${line}"]`) ?? null;
}

function rowsOf(item, thread) {
  const rows = [];
  for (let line = thread.startLine; line <= thread.endLine; line++) {
    const row = rowFor(item, thread.side, line);
    if (row) rows.push(row);
  }
  return rows;
}

function markOf(t) {
  if (t.pending) return "pending";
  if (t.status === "suggested") return "suggested";
  return t.waitingOn === "human" ? "turn" : "open";
}

/** Tints the rows of every thread on `item`'s file. Called after each of Pierre's renders. */
export function markRows(item) {
  const shadow = item.section.firstElementChild?.shadowRoot;
  if (!shadow) return;
  for (const row of shadow.querySelectorAll("[data-dv-comment]")) {
    row.removeAttribute("data-dv-comment");
    row.removeAttribute("data-dv-active");
    row.removeAttribute("data-dv-thread");
  }
  for (const t of placedThreads()) {
    if (t.kind !== "lines" || t.path !== item.file.path) continue;
    for (const row of rowsOf(item, t)) {
      row.dataset.dvComment = markOf(t);
      row.dataset.dvThread = String(t.id);
      if (t.id === state.comments.active) row.dataset.dvActive = "";
    }
  }
}

/** Opens the thread under a clicked line, if any. Pierre calls this with the line's number and side. */
export function clickedLine(item, props) {
  const side = SIDE_OF[props.annotationSide] ?? "new";
  const hit = placedThreads().find((t) => t.kind === "lines" && t.path === item.file.path && t.side === side && props.lineNumber >= t.startLine && props.lineNumber <= t.endLine);
  if (hit) activate(hit.id);
}

/* Loading */

export async function loadComments() {
  if (!state.comments.enabled || !state.diff) return;
  const params = new URLSearchParams({ branch: state.branch, sha: state.diff.sha });
  const data = await getJson(`/api/comments?${params}`);
  const before = JSON.stringify([state.comments.threads, state.comments.viewed]);
  state.comments.threads = data.threads;
  state.comments.pendingCount = data.pendingCount;
  state.comments.viewed = data.viewed;
  state.comments.version = data.version;
  if (state.comments.active && !data.threads.some((t) => t.id === state.comments.active)) state.comments.active = null;
  const changed = before !== JSON.stringify([state.comments.threads, state.comments.viewed]);
  renderComments({ annotationsChanged: changed && threadsInline() });
  if (changed) commentHooks.renderTree();
}

/* Rendering */

/** Redraws everything comments show: row tints, the rail or inline cards, the header's counts and batch. */
export function renderComments({ annotationsChanged = false } = {}) {
  if (!state.comments.enabled) return;
  renderHeader();
  root.classList.toggle("rail-docked", railShown());
  if (annotationsChanged) commentHooks.rerenderFiles();
  for (const item of state.views) markRows(item);
  renderBranchThreads();
  renderRail();
}

function renderHeader() {
  const threads = state.comments.threads;
  const unresolved = threads.filter((t) => t.status !== "resolved").length;
  const button = $("#comments-btn");
  button.hidden = false;
  $("#comments-count").textContent = unresolved ? String(unresolved) : "";
  button.classList.toggle("attention", threads.some((t) => t.waitingOn === "human" && t.status !== "resolved"));
  button.setAttribute("aria-pressed", String(state.comments.listMode));
  const pending = state.comments.pendingCount;
  $("#batch").hidden = pending === 0;
  $("#batch-count").textContent = `${pending} pending`;
  const version = state.version ?? state.diff?.version;
  const chip = $("#version");
  chip.hidden = !version;
  if (version) {
    chip.textContent = state.version ? `v${version.seq} of ${version.latestSeq}` : `v${version.seq}`;
    chip.classList.toggle("old", Boolean(state.version));
  }
}

/** Whole-branch threads sit under the branch's header, whether threads show in the rail or inline. */
function renderBranchThreads() {
  const box = $("#branch-threads");
  const threads = placedThreads().filter((t) => t.kind === "branch");
  box.innerHTML = threads.map((t) => threadCard(t, { expanded: t.id === state.comments.active, batching: batching() })).join("");
}

let layoutFrame = 0;
/** Re-measures where rail cards go, on the next frame. Cheap to call often. */
export function scheduleLayout() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(layoutRail);
}

function renderRail() {
  const rail = $("#rail");
  rail.classList.toggle("listing", state.comments.listMode);
  if (!railShown()) {
    rail.innerHTML = "";
    return;
  }
  const threads = state.comments.threads;
  if (state.comments.listMode) {
    rail.innerHTML = railHead(threads, { listing: true }) + railList(threads, { active: state.comments.active, batching: batching() });
    restoreReplies(rail);
    return;
  }
  const margin = placedThreads().filter((t) => t.kind !== "branch");
  rail.innerHTML = railHead(threads, { listing: false }) + margin.map((t) => threadCard(t, { expanded: t.id === state.comments.active, batching: batching() })).join("");
  restoreReplies(rail);
  layoutRail();
}

/** Puts each margin card level with its lines (or its file's header), stacking cards that would overlap. */
function layoutRail() {
  const rail = $("#rail");
  if (!railShown() || state.comments.listMode) return;
  const railTop = rail.getBoundingClientRect().top;
  const head = rail.querySelector(".rail-head");
  const minTop = head ? head.offsetHeight + CARD_GAP : 0;
  const items = [];
  for (const card of rail.querySelectorAll(".thread")) {
    const thread = state.comments.threads.find((t) => t.id === Number(card.dataset.thread));
    const item = thread && state.views.find((v) => v.file.path === thread.path);
    if (!item) continue;
    const anchor = (thread.kind === "lines" && rowsOf(item, thread)[0]) || item.section;
    items.push({ card, id: thread.id, target: anchor.getBoundingClientRect().top - railTop, height: card.offsetHeight });
  }
  items.sort((a, b) => a.target - b.target);
  if (!items.length) return;
  const pivot = Math.max(0, items.findIndex((i) => i.id === state.comments.active));
  const tops = stackCards(items, { pivot, minTop, gap: CARD_GAP });
  items.forEach((item, i) => (item.card.style.top = `${tops[i]}px`));
  rail.style.minHeight = `${tops.at(-1) + items.at(-1).height}px`;
}

function restoreReplies(container) {
  for (const input of container.querySelectorAll("textarea.reply")) {
    const id = Number(input.closest(".thread").dataset.thread);
    input.value = state.comments.replyText.get(id) ?? "";
    autosize(input);
  }
}

/* Activating a thread */

export function activate(id, { scroll = false } = {}) {
  state.comments.active = id;
  const thread = state.comments.threads.find((t) => t.id === id);
  if (threadsInline() && !state.comments.listMode) {
    for (const el of document.querySelectorAll("[data-inline-thread]")) {
      const t = state.comments.threads.find((x) => x.id === Number(el.dataset.inlineThread));
      if (t) el.innerHTML = threadCard(t, { expanded: t.id === id, batching: batching() });
    }
  }
  renderComments();
  if (scroll && thread) {
    const item = state.views.find((v) => v.file.path === thread.path);
    const target = (item && thread.kind === "lines" && rowsOf(item, thread)[0]) || item?.section || $("#branch-head");
    target?.scrollIntoView({ block: "center" });
  }
  document.querySelector(`.thread.expanded[data-thread="${id}"] textarea.reply`)?.focus({ preventScroll: true });
}

function deactivate() {
  if (state.comments.active === null) return;
  activate(null);
}

/* The composer */

/** Opens the composer for a new thread: on lines (from Pierre's selection), a file, or the whole branch. */
function openComposer(target, anchorEl) {
  const composer = $("#composer");
  state.comments.composer = target;
  $("#composer-where").textContent = target.kind === "branch" ? `Comment on ${state.branch}` : `Comment on ${anchorLabel({ ...target, path: target.path })}`;
  composer.hidden = false;
  const rect = anchorEl.getBoundingClientRect();
  composer.style.top = `${rect.bottom + scrollY + 6}px`;
  composer.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - composer.offsetWidth - 8)) + scrollX}px`;
  $("#composer-submit").textContent = batching() ? "Add to batch" : "Comment";
  $("#composer-alt").textContent = batching() ? "Send just this" : "Start batch";
  $("#composer-hint").textContent = keyHint(batching());
  const input = $("#composer-text");
  autosize(input);
  input.focus({ preventScroll: true });
}

export function composerOpen() {
  return !$("#composer").hidden;
}

/** Closes the composer and clears Pierre's selection. A live reload that waited for it runs then. */
function closeComposer({ keepText = false } = {}) {
  if (!composerOpen()) return;
  $("#composer").hidden = true;
  if (!keepText) $("#composer-text").value = "";
  const target = state.comments.composer;
  state.comments.composer = null;
  if (target?.item) target.item.view.setSelectedLines(null);
  if (state.reloadWaiting) {
    state.reloadWaiting = false;
    commentHooks.refreshAfterComposer();
  }
}

/** Pierre calls this when a line selection ends: {start, side, end, endSide}, sides "additions" or "deletions". */
export function selectedLines(item, range) {
  if (!range || state.version?.old) return;
  if (range.endSide && range.side && range.endSide !== range.side) {
    toast("Pick lines on one side: added and context lines, or removed lines");
    item.view.setSelectedLines(null);
    return;
  }
  const side = SIDE_OF[range.side] ?? "new";
  const [startLine, endLine] = range.start <= range.end ? [range.start, range.end] : [range.end, range.start];
  const row = rowFor(item, side, endLine) ?? item.section;
  openComposer({ kind: "lines", path: item.file.path, side, startLine, endLine, item }, row);
}

/** A file header's Comment button. */
export function commentOnFile(item, button) {
  openComposer({ kind: "file", path: item.file.path, side: "new", item }, button);
}

async function submitComment(mode) {
  const target = state.comments.composer;
  const input = $("#composer-text");
  const body = input.value.trim();
  if (!target || !body) return;
  try {
    const { id } = await postJson("/api/comments", {
      branch: state.branch,
      stack: state.stackOf,
      sha: state.diff.sha,
      kind: target.kind,
      path: target.path ?? null,
      side: target.side ?? "new",
      startLine: target.startLine ?? null,
      endLine: target.endLine ?? null,
      body,
      pending: mode === "batch" || mode === "send",
    });
    if (mode === "send") await postJson("/api/comments/batch/send", {});
    closeComposer();
    state.comments.active = id;
    await loadComments();
    if (threadsInline()) commentHooks.rerenderFiles();
  } catch (err) {
    toast(err.status === 409 ? "The diff changed while you wrote. Your comment is kept: reload, then pick the lines again." : err.message);
  }
}

/* Thread actions */

async function sendReply(input, mode) {
  const id = Number(input.closest(".thread").dataset.thread);
  const body = input.value.trim();
  if (!body) return;
  try {
    await postJson(`/api/comments/${id}/messages`, { body, pending: mode === "batch" || mode === "send" });
    if (mode === "send") await postJson("/api/comments/batch/send", {});
    state.comments.replyText.delete(id);
    await loadComments();
  } catch (err) {
    toast(err.message);
  }
}

async function act(url, body = {}, { confirmText } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await postJson(url, body);
    await loadComments();
    if (threadsInline()) commentHooks.rerenderFiles();
  } catch (err) {
    toast(err.message);
  }
}

/* Viewed marks */

/** A file is viewed when marked so as its diff reads now; a mark on an older diff means it changed since. */
export function viewedState(file) {
  const mark = state.comments.viewed[file.path];
  if (!mark) return "unviewed";
  return mark === file.sha ? "viewed" : "changed";
}

async function setViewed(item, viewed) {
  try {
    await postJson("/api/viewed", { branch: state.branch, path: item.file.path, fileSha: viewed ? item.file.sha : null });
    state.comments.viewed = { ...state.comments.viewed, [item.file.path]: viewed ? item.file.sha : undefined };
    if (!viewed) delete state.comments.viewed[item.file.path];
    item.options = { ...item.options, collapsed: viewed };
    item.view.setOptions(item.options);
    item.view.rerender();
    commentHooks.renderTree();
    if (viewed) item.section.scrollIntoView({ block: "nearest" });
  } catch (err) {
    toast(err.message);
  }
}

/** The controls in a file's header: viewed, comment, and open in Cursor. */
export function headerControls(item, openLink) {
  const box = document.createElement("span");
  box.className = "file-controls";
  if (state.comments.enabled) {
    const status = viewedState(item.file);
    const label = document.createElement("label");
    label.className = `viewed viewed-${status}`;
    label.title = status === "changed" ? "Changed since you marked it viewed" : "Mark viewed: collapses the file until it changes";
    label.innerHTML = `<input type="checkbox"${status === "viewed" ? " checked" : ""}> ${status === "changed" ? "Changed since viewed" : "Viewed"}`;
    label.querySelector("input").addEventListener("change", (event) => setViewed(item, event.target.checked));
    const comment = document.createElement("button");
    comment.type = "button";
    comment.className = "link";
    comment.textContent = "Comment";
    comment.title = "Comment on the whole file";
    comment.addEventListener("click", () => commentOnFile(item, comment));
    box.append(label, comment);
  }
  box.append(openLink);
  return box;
}

/* Versions */

async function toggleVersions() {
  const menu = $("#versions-menu");
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  const { versions } = await getJson(`/api/versions?${new URLSearchParams({ branch: state.branch })}`);
  const shown = state.version?.seq ?? state.diff?.version?.seq;
  menu.innerHTML = versions
    .map((v, i) => {
      const label = i === 0 ? "latest" : new Date(v.observedAt).toLocaleString();
      const threads = v.threads ? ` · ${v.threads} ${v.threads === 1 ? "comment" : "comments"}` : "";
      return `<button type="button" class="version-row${v.seq === shown ? " current" : ""}" data-seq="${i === 0 ? "" : v.seq}">v${v.seq} <span class="faint">${escapeHtml(label)}${threads}</span></button>`;
    })
    .join("");
  menu.hidden = false;
}

/* Wiring */

export function initComments() {
  state.comments.enabled = Boolean(state.info.comments);
  if (!state.comments.enabled) return;
  const onThreadClick = (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const card = event.target.closest(".thread");
    const id = card && Number(card.dataset.thread);
    if (action === "list") {
      state.comments.listMode = !state.comments.listMode;
      renderComments();
      commentHooks.rerenderFiles();
    } else if (action === "resolved" || action === "open") {
      act(`/api/comments/${id}/status`, { status: action, pending: action === "open" && batching() });
    } else if (action === "delete-thread") {
      act(`/api/comments/${id}/delete`, {}, { confirmText: "Delete this thread permanently?" });
    } else if (action === "delete-message") {
      act(`/api/comments/${id}/messages/${event.target.closest("[data-message]").dataset.message}/delete`, {}, { confirmText: "Delete this message permanently?" });
    } else if (action === "version") {
      commentHooks.showVersion(Number(event.target.dataset.seq));
    } else if (card && !card.classList.contains("expanded") && !event.target.closest("a")) {
      activate(id, { scroll: state.comments.listMode });
    }
  };
  const onReplyKey = (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendReply(input, submitMode(event, batching()));
    } else if (event.key === "Escape") {
      input.blur();
      deactivate();
    }
  };
  const onReplyInput = (event) => {
    const input = event.target.closest("textarea.reply");
    if (!input) return;
    state.comments.replyText.set(Number(input.closest(".thread").dataset.thread), input.value);
    autosize(input);
    scheduleLayout();
  };
  for (const container of [$("#rail"), $("#diffs"), $("#branch-threads")]) {
    container.addEventListener("click", onThreadClick);
    container.addEventListener("keydown", onReplyKey);
    container.addEventListener("input", onReplyInput);
  }

  $("#composer-submit").addEventListener("click", () => submitComment(batching() ? "batch" : "now"));
  $("#composer-alt").addEventListener("click", () => submitComment(batching() ? "now" : "batch"));
  $("#composer-cancel").addEventListener("click", () => closeComposer());
  $("#composer-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitComment(submitMode(event, batching()));
    } else if (event.key === "Escape") {
      closeComposer();
    }
  });
  $("#composer-text").addEventListener("input", (event) => autosize(event.target));
  $("#comment-branch").addEventListener("click", (event) => openComposer({ kind: "branch" }, event.currentTarget));

  $("#batch-send").addEventListener("click", () => act("/api/comments/batch/send"));
  $("#batch-discard").addEventListener("click", () => act("/api/comments/batch/discard", {}, { confirmText: "Discard every pending comment?" }));
  $("#comments-btn").addEventListener("click", () => {
    state.comments.listMode = !state.comments.listMode;
    renderComments();
  });
  $("#version").addEventListener("click", toggleVersions);
  $("#versions-menu").addEventListener("click", (event) => {
    const row = event.target.closest(".version-row");
    if (!row) return;
    $("#versions-menu").hidden = true;
    commentHooks.showVersion(row.dataset.seq ? Number(row.dataset.seq) : null);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#versions-menu, #version")) $("#versions-menu").hidden = true;
  });
  new ResizeObserver(scheduleLayout).observe($("#diffs"));
}

/** `i`: threads in the margin rail, or inline under their lines. */
export function toggleInline() {
  state.comments.inline = !state.comments.inline;
  localStorage.setItem("diffview.threads", state.comments.inline ? "inline" : "rail");
  toast(state.comments.inline ? "Threads inline" : "Threads in the margin");
  renderComments();
  commentHooks.rerenderFiles();
}
