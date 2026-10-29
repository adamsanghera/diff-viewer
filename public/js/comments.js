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
import { anchorFromRange, blockAt, descriptionTarget, paintDescription, threadAtPoint } from "./description.js";
import { stackCards } from "./lib/card-stack.js";
import { anchorLabel, railHead, railList, threadCard } from "./lib/cards.js";
import { renderedPaths } from "./filters.js";
import { escapeHtml } from "./lib/format.js";
import { isSubmitKey, submitButton } from "./lib/keys.js";
import { $, autosize, getJson, PIERRE_SIDE, postJson, root, SIDE_OF, state, toast } from "./state.js";

const RAIL_GAP = 16;
const CARD_GAP = 8;
// The narrowest diff pane the rail may leave beside it. Below this, threads show inline instead.
const MIN_DIFF_WIDTH_BESIDE_RAIL = 640;
const RAIL_WIDTH = 300;

/** Styles that reach into Pierre's shadow roots: tints on commented rows. */
export const ROW_MARK_CSS = `
[data-dv-comment], [data-hovered], [data-selected-line] {
  background-image: linear-gradient(var(--dv-over, transparent), var(--dv-over, transparent)), linear-gradient(var(--dv-tint, transparent), var(--dv-tint, transparent));
}
[data-hovered] { --dv-over: var(--hover); }
/* Pierre selects whole rows, so in a split diff it marks a context line on both sides; only the side being selected is tinted. */
code[data-unified] [data-selected-line],
:host(:not([data-dv-select-side])) [data-selected-line],
:host([data-dv-select-side="additions"]) code[data-additions] [data-selected-line],
:host([data-dv-select-side="deletions"]) code[data-deletions] [data-selected-line] { --dv-over: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent) !important; }
:host([data-dv-select-side="additions"]) code[data-deletions],
:host([data-dv-select-side="deletions"]) code[data-additions] { --diffs-selection-number-fg: var(--diffs-fg-number); }
[data-dv-comment] { box-shadow: inset 3px 0 0 var(--dv-mark); cursor: pointer; }
[data-dv-comment="open"] { --dv-mark: rgb(240, 124, 0); --dv-tint: rgba(240, 124, 0, 0.12); --dv-tint-active: rgba(240, 124, 0, 0.26); }
[data-dv-comment="turn"] { --dv-mark: rgb(53, 101, 226); --dv-tint: rgba(53, 101, 226, 0.1); --dv-tint-active: rgba(53, 101, 226, 0.24); }
[data-dv-comment="suggested"] { --dv-mark: rgb(58, 154, 67); --dv-tint: rgba(58, 154, 67, 0.12); --dv-tint-active: rgba(58, 154, 67, 0.26); }
[data-dv-comment="pending"] { --dv-mark: rgb(152, 152, 164); --dv-tint: rgba(152, 152, 164, 0.14); --dv-tint-active: rgba(152, 152, 164, 0.3); }
[data-dv-active] { --dv-tint: var(--dv-tint-active); box-shadow: inset 4px 0 0 var(--dv-mark); }
`;

/** Set by main.js: re-renders the diffs, as when threads move between the rail and inline. */
export const commentHooks = { renderFiles() {}, rerenderFiles() {}, setCollapsed() {}, showVersion() {}, refreshAfterComposer() {}, renderTree() {} };

// Whether new comments and replies go into the batch: the sticky "Add to batch" checkbox.
const batching = () => state.comments.batch;
const BATCH_KEY = "diffview.batch";

/** Sets the batch mode, keeps it for the next visit, and brings every submit button, its menu and the key hints up to date. */
function setBatching(batch) {
  state.comments.batch = batch;
  localStorage.setItem(BATCH_KEY, batch ? "on" : "off");
  for (const button of document.querySelectorAll("[data-submit]")) button.textContent = batch ? "Add to batch" : button.dataset.labelNow;
  for (const choice of document.querySelectorAll("[data-batch-choice]")) choice.setAttribute("aria-checked", String((choice.dataset.batchChoice === "on") === batch));
}

/** Opens a submit button's menu, closing any other, or closes them all with null. */
function openBatchMenu(chevron) {
  for (const other of document.querySelectorAll("[data-batch-menu]")) {
    const open = other === chevron && other.getAttribute("aria-expanded") !== "true";
    other.setAttribute("aria-expanded", String(open));
    other.parentElement.querySelector(".split-menu").hidden = !open;
  }
}

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
  if (state.description?.sha256) params.set("descriptionSha", state.description.sha256);
  const data = await getJson(`/api/comments?${params}`);
  const before = JSON.stringify([state.comments.threads, state.comments.viewed]);
  state.comments.threads = data.threads;
  state.comments.pendingCount = data.pendingCount;
  state.comments.viewed = data.viewed;
  state.comments.branchViewed = { branch: state.branch, mark: data.branchViewed };
  state.comments.version = data.version;
  if (state.comments.active && !data.threads.some((t) => t.id === state.comments.active)) state.comments.active = null;
  const changed = before !== JSON.stringify([state.comments.threads, state.comments.viewed]);
  // A new thread on a hidden test or generated file brings that file into view.
  if (state.views.length && renderedPaths() !== state.renderedPaths) commentHooks.renderFiles();
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
  paintDescription(placedThreads().filter((t) => t.kind === "description"), state.comments.active, markOf);
  renderBranchThreads();
  renderRail();
  renderBranchViewed();
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
  const version = state.overview ? null : (state.version ?? state.diff?.version);
  const chip = $("#version");
  chip.hidden = !version;
  if (version) {
    chip.textContent = state.version ? `v${version.seq} of ${version.latestSeq}` : `v${version.seq}`;
    chip.classList.toggle("old", Boolean(state.version));
  }
}

/**
 * Whole-branch threads sit under the description, whether threads show in
 * the rail or inline. Inline, the description's own threads join them.
 */
function renderBranchThreads() {
  const box = $("#branch-threads");
  const inline = threadsInline() && !state.comments.listMode;
  const threads = placedThreads().filter((t) => t.kind === "branch" || (inline && t.kind === "description"));
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
    const anchor = thread?.kind === "description" ? descriptionTarget(thread) : item && ((thread.kind === "lines" && rowsOf(item, thread)[0]) || item.section);
    if (!anchor) continue;
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
    const target =
      thread.kind === "description"
        ? $(`#description-body [data-block="${thread.blockIndex}"]`) ?? $("#description")
        : (item && thread.kind === "lines" && rowsOf(item, thread)[0]) || item?.section || $("#branch-head");
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
  // Not shown, since the composer opens beside what it comments on; screen readers announce it.
  const where =
    target.kind === "branch"
      ? `Comment on ${state.overview ? "the whole stack" : state.branch}`
      : target.kind === "description"
        ? `Comment on the ${state.overview ? "stack " : ""}description: “${target.quote.length > 60 ? `${target.quote.slice(0, 59)}…` : target.quote}”`
        : `Comment on ${anchorLabel({ ...target, path: target.path })}`;
  $("#composer-text").setAttribute("aria-label", where);
  $("#comment-btn").hidden = true;
  composer.hidden = false;
  const rect = anchorEl.getBoundingClientRect();
  composer.style.top = `${rect.bottom + scrollY + 6}px`;
  composer.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - composer.offsetWidth - 8)) + scrollX}px`;
  $("#composer-actions").innerHTML = submitButton(batching(), { now: "Comment", id: "composer-submit" });
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

/** Records which side a selection is on, as the selection starts and moves, so ROW_MARK_CSS tints only that column. */
export function markSelectionSide(item, range) {
  const host = item.section.firstElementChild;
  if (!host) return;
  if (range?.side) host.dataset.dvSelectSide = range.side;
  else delete host.dataset.dvSelectSide;
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

/** Shows the floating Comment button beside a selection of the description's text, or hides it. */
function updateCommentButton() {
  const button = $("#comment-btn");
  const selection = getSelection();
  const range = selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
  if (!state.comments.enabled || composerOpen() || !range || !blockAt(range.startContainer) || state.version?.old) {
    button.hidden = true;
    return;
  }
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  button.hidden = false;
  button.style.left = `${Math.min(rect.right + 6, innerWidth - button.offsetWidth - 8) + scrollX}px`;
  button.style.top = `${rect.top + scrollY - 3}px`;
}

/** The Comment button: opens the composer on the selected text of the description. */
function commentOnSelection() {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed || !state.description) return;
  const range = selection.getRangeAt(0).cloneRange();
  const anchor = anchorFromRange(range);
  if (!anchor) {
    toast("Select text inside one paragraph, heading, list item or code block of the description");
    return;
  }
  openComposer({ kind: "description", descriptionSha: state.description.sha256, ...anchor }, range);
}

/** A file header's Comment button. */
export function commentOnFile(item, button) {
  openComposer({ kind: "file", path: item.file.path, side: "new", item }, button);
}

/** Starts the thread the composer holds: into the batch while "Add to batch" is checked, else sent at once. */
async function submitComment() {
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
      descriptionSha: target.descriptionSha,
      blockIndex: target.blockIndex,
      quote: target.quote ?? "",
      start: target.start,
      body,
      pending: batching(),
    });
    closeComposer();
    state.comments.active = id;
    await loadComments();
    if (threadsInline()) commentHooks.rerenderFiles();
  } catch (err) {
    toast(err.status === 409 ? "The diff changed while you wrote. Your comment is kept: reload, then pick the lines again." : err.message);
  }
}

/* Thread actions */

/** Adds a reply: into the batch while "Add to batch" is checked, else sent at once. */
async function sendReply(input) {
  const id = Number(input.closest(".thread").dataset.thread);
  const body = input.value.trim();
  if (!body) return;
  try {
    await postJson(`/api/comments/${id}/messages`, { body, pending: batching() });
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

/**
 * Marks a file viewed or not. Checking it collapses the file and
 * unchecking expands it, once, at that moment; after that the person
 * collapses and expands it as they like (the header's chevron).
 */
async function setViewed(item, viewed) {
  try {
    await postJson("/api/viewed", { branch: state.branch, path: item.file.path, fileSha: viewed ? item.file.sha : null });
    state.comments.viewed = { ...state.comments.viewed, [item.file.path]: viewed ? item.file.sha : undefined };
    if (!viewed) delete state.comments.viewed[item.file.path];
    commentHooks.setCollapsed(item, viewed);
    commentHooks.renderTree();
    if (viewed) item.section.scrollIntoView({ block: "nearest" });
  } catch (err) {
    toast(err.message);
  }
}

/**
 * The branch shown's own viewed mark: "viewed", "changed" (its diff changed
 * since it was marked), or null. Set only with v or the header's button,
 * never by viewing every file.
 */
function branchMark() {
  const known = state.comments.branchViewed;
  return known?.branch === state.branch ? known.mark : null;
}

/** The branch header's toggle for marking the whole branch viewed (v). */
export function renderBranchViewed() {
  const slot = $("#branch-viewed");
  if (!slot) return;
  const files = state.diff?.files ?? [];
  if (!state.comments.enabled || state.overview || state.version?.old || !files.length) {
    slot.innerHTML = "";
    return;
  }
  const mark = branchMark();
  const [label, title] =
    mark === "viewed"
      ? ["✓ Branch viewed", "Take the branch's viewed mark away; files keep theirs (v)"]
      : mark === "changed"
        ? ["↻ Changed since viewed", "The branch changed since you marked it viewed; mark it again (v)"]
        : ["Mark branch viewed", "Mark the branch viewed as a whole; its files keep their own marks (v)"];
  slot.innerHTML = `<button class="btn btn-viewed${mark === "viewed" ? " is-viewed" : mark === "changed" ? " is-changed" : ""}" type="button" data-branch-viewed title="${title}">${label}</button>`;
}

/** Marks the branch shown viewed as a whole, or when it is marked, takes the mark away. Its files' marks stay as they are. */
export async function toggleBranchViewed() {
  if (!state.comments.enabled || state.overview || !state.diff?.files.length) return;
  try {
    const result = await postJson("/api/viewed/branch", { branch: state.branch, stack: state.stackOf, viewed: branchMark() !== "viewed" });
    state.comments.branchViewed = { branch: state.branch, mark: result.branchViewed };
    renderBranchViewed();
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
    if (isSubmitKey(event)) {
      event.preventDefault();
      sendReply(input);
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

  $("#composer-cancel").addEventListener("click", () => closeComposer());
  // Submit buttons and their batch menus, in the composer and in every card's reply box.
  document.addEventListener("click", (event) => {
    const submit = event.target.closest?.("[data-submit]");
    const chevron = event.target.closest?.("[data-batch-menu]");
    const choice = event.target.closest?.("[data-batch-choice]");
    if (choice) {
      setBatching(choice.dataset.batchChoice === "on");
      openBatchMenu(null);
    } else if (chevron) {
      openBatchMenu(chevron);
    } else {
      openBatchMenu(null);
    }
    if (submit?.closest("#composer")) submitComment();
    else if (submit) sendReply(submit.closest(".thread").querySelector("textarea.reply"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") openBatchMenu(null);
  });
  $("#composer-text").addEventListener("keydown", (event) => {
    if (isSubmitKey(event)) {
      event.preventDefault();
      submitComment();
    } else if (event.key === "Escape") {
      closeComposer();
    }
  });
  $("#composer-text").addEventListener("input", (event) => autosize(event.target));
  $("#comment-branch").addEventListener("click", (event) => openComposer({ kind: "branch" }, event.currentTarget));
  const commentButton = $("#comment-btn");
  commentButton.addEventListener("mousedown", (event) => event.preventDefault());
  commentButton.addEventListener("click", commentOnSelection);
  // A click inside the selection collapses it only after mouseup, so check on the next tick.
  document.addEventListener("mouseup", () => setTimeout(updateCommentButton));
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift") updateCommentButton();
  });
  document.addEventListener("selectionchange", () => {
    if (getSelection().isCollapsed) $("#comment-btn").hidden = true;
  });
  $("#description").addEventListener("click", (event) => {
    if (!getSelection().isCollapsed) return;
    const id = threadAtPoint(event.clientX, event.clientY);
    if (id !== null) activate(id);
  });

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
