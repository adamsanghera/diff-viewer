/** The branch's files, each rendered by Pierre's FileDiff, and the layout they use: Auto, Split, or Unified. */
import { DEFAULT_TOKENIZE_MAX_LENGTH, FileDiff, hydratePartialDiff, parsePatchFiles } from "/vendor/pierre.js";
import {
  clickedLine,
  headerControls,
  lineAnnotationsFor,
  markRows,
  renderAnnotation,
  revealCommentedLines,
  ROW_MARK_CSS,
  scheduleLayout,
  markSelectionSide,
  selectedLines,
  viewedState,
} from "./comments.js";
import { hiddenSummary, rendered, renderedPaths } from "./filters.js";
import { escapeHtml, startsCollapsed } from "./lib/format.js";
import { $, getJson, root, state } from "./state.js";

const PIERRE_THEMES = { light: "pierre-light", dark: "pierre-dark" };
// Under Auto, the narrowest diff pane that gets split diffs: each side then still shows about 60 columns of code.
const AUTO_SPLIT_MIN_WIDTH = 1000;

/**
 * Graphite's row colors inside Pierre's shadow roots. Pierre blends each
 * row's color from its theme through several mixes, which its override
 * variables do not reach, so these set the backgrounds directly, from the
 * page's tokens (custom properties inherit into shadow roots).
 */
const GRAPHITE_DIFF_CSS = `
pre, [data-code], [data-content], [data-gutter-buffer], [data-diffs-header], [data-line-type="context"], [data-line-type="context-expanded"], [data-column-number][data-line-type="context"], [data-column-number][data-line-type="context-expanded"], [data-gutter] { background-color: var(--bg) !important; }
[data-line-type="change-addition"] { background-color: var(--diff-added) !important; }
[data-line-type="change-deletion"] { background-color: var(--diff-removed) !important; }
[data-line-type="change-addition"] [data-diff-span] { background-color: var(--diff-added-word) !important; }
[data-line-type="change-deletion"] [data-diff-span] { background-color: var(--diff-removed-word) !important; }
[data-column-number][data-line-type="change-addition"] { color: var(--diff-added-number) !important; background-color: var(--diff-added-gutter) !important; }
[data-column-number][data-line-type="change-deletion"] { color: var(--diff-removed-number) !important; background-color: var(--diff-removed-gutter) !important; }
[data-separator], [data-separator-wrapper], [data-separator-content] { background-color: var(--bg) !important; }
[data-separator] { border-block: 1px dashed var(--border); }
[data-separator-content] { color: var(--text-faint); font-size: 11px; }
[data-diffs-header][data-sticky] { top: var(--topbar); z-index: 5; }
`;

/* Layout */

/** The diff style shown: the chosen one, or under Auto, split when the diff pane is wide enough. */
function effectiveLayout() {
  if (state.layout !== "auto") return state.layout;
  return $("#diffs").clientWidth >= AUTO_SPLIT_MIN_WIDTH ? "split" : "unified";
}

/** Re-renders the diffs if the style shown should change, as when the window, sidebar or rail resizes under Auto. */
export function applyLayout() {
  const diffStyle = effectiveLayout();
  $('[data-layout="auto"]').title = `Split when the window is wide enough, else one column; now ${diffStyle}`;
  if (diffStyle === state.diffStyle) return;
  state.diffStyle = diffStyle;
  for (const item of state.views) {
    item.options = { ...item.options, diffStyle };
    item.view.setOptions(item.options);
    item.view.rerender();
  }
}

export function setLayout(layout) {
  state.layout = layout;
  localStorage.setItem("diffview.layout", layout);
  for (const button of document.querySelectorAll("[data-layout]")) button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  applyLayout();
}

/* Files */

function openInCursor(file) {
  const link = document.createElement("a");
  link.className = "open-editor";
  link.href = `cursor://file${encodeURI(`${state.info.top}/${file.path}`)}:${file.firstLine}`;
  link.textContent = "Open";
  link.title = "Open in Cursor";
  return link;
}

// A commit's blob never changes, so a path at a revision is fetched once per page. `blobText` holds it once known; `blobMiss` remembers a failed fetch so a render does not ask again.
const blobs = new Map();
const blobText = new Map();
const blobMiss = new Set();
const blobKey = (rev, name) => `${rev}\0${name}`;

function blobAt(rev, name) {
  const key = blobKey(rev, name);
  if (blobText.has(key)) return Promise.resolve(blobText.get(key));
  let pending = blobs.get(key);
  if (!pending) {
    pending = getJson(`/api/file?${new URLSearchParams({ rev, path: name })}`).then((body) => {
      blobText.set(key, body.contents);
      return body.contents;
    });
    pending.catch(() => {
      blobs.delete(key);
      blobMiss.add(key);
    });
    blobs.set(key, pending);
  }
  return pending;
}

/** The blob if this page already has it: `{file}` or `{missing}`, or null when it has not been asked for. */
function knownBlob(rev, name) {
  const key = blobKey(rev, name);
  if (blobText.has(key)) return { file: { name, contents: blobText.get(key), cacheKey: `${rev}:${name}` } };
  if (blobMiss.has(key)) return { missing: true };
  return null;
}

/**
 * Both sides of a changed file: the old side at the branch's base, the new at
 * its head. Pierre tokenizes a side as one document only once it has every
 * line, so a modified file loads here before its first paint. Pierre calls
 * this again when a collapsed file is opened or a separator expands, and the
 * cache above makes that the same blobs.
 */
async function loadBothSides(fileDiff, { base, head }) {
  const at = async (rev, name) => ({ name, contents: await blobAt(rev, name), cacheKey: `${rev}:${name}` });
  if (fileDiff.type === "rename-pure") return { oldFile: null, newFile: await at(head, fileDiff.name) };
  const [oldFile, newFile] = await Promise.all([at(base, fileDiff.prevName ?? fileDiff.name), at(head, fileDiff.name)]);
  return { oldFile, newFile };
}

/** A patch of a modification or a rename that changed: the two sides to highlight are not in the hunks. Added and deleted files already are. */
function needsWholeFile(fileDiff) {
  return fileDiff.isPartial && (fileDiff.type === "change" || fileDiff.type === "rename-changed");
}

/** How many lines Pierre's splitter would make of `contents`. Past its tokenize limit a whole-file highlight is plain text, which is worse than coloring the hunks. */
function lineCount(contents) {
  if (contents === "") return 0;
  let count = 1;
  for (let i = 0; i < contents.length; i++) if (contents.charCodeAt(i) === 10) count++;
  if (contents.charCodeAt(contents.length - 1) === 10) count--;
  return count;
}

function withinHighlightLimit(files) {
  const oldLines = files.oldFile ? lineCount(files.oldFile.contents) : 0;
  const newLines = files.newFile ? lineCount(files.newFile.contents) : 0;
  return Math.max(oldLines, newLines) <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/**
 * Gives `item` the whole file when highlighting can use it. With no view yet,
 * the parsed diff is hydrated in place so the first paint is already one
 * document per side. A view that was painted from the patch hydrates through
 * Pierre, which drops the per-hunk highlight it cached.
 */
async function withWholeFile(item, entry) {
  if (!needsWholeFile(item.fileDiff)) return;
  const files = await loadBothSides(item.fileDiff, entry);
  if (!item.fileDiff.isPartial || !withinHighlightLimit(files)) return;
  if (item.view) await item.view.prepareForEditing();
  else hydratePartialDiff("merge", item.fileDiff, files);
}

export function cleanUpViews() {
  for (const { view } of state.views) view.cleanUp();
  state.views = [];
}

/** Pairs each summarized file with Pierre's parse of it. Both come from one patch, so names match. */
function parsedByPath(patch) {
  const byPath = new Map();
  for (const file of parsePatchFiles(patch).flatMap((p) => p.files)) byPath.set(file.name, file);
  return byPath;
}

/**
 * Renders the branch's files, measured as "diffview:render-files" for ?perf and
 * DevTools' Performance panel. The measure is the paint, after the whole-file
 * blobs are in. Callers that show something derived from this paint, such as
 * the version chip, wait for the returned promise: the chip and the lines
 * then appear in the same turn.
 */
export function renderFiles() {
  const generation = ++renderGeneration;
  // Already-loaded files paint in this turn. A click that redraws them, and a
  // test that reads the page as soon as the click returns, then see the new diff.
  if (visibleFilesReady()) return paintNow(generation);
  return paintFiles(generation);
}

/** Both sides of every visible modified file are already known, so nothing has to be fetched. */
function visibleFilesReady() {
  const parsed = parsedByPath(state.diff.patch);
  const { entry } = state.diff;
  for (const file of state.diff.files) {
    if (!rendered(file) || collapsedNow(file)) continue;
    const fileDiff = parsed.get(file.path);
    if (!fileDiff || !needsWholeFile(fileDiff)) continue;
    if (!knownBlob(entry.base, fileDiff.prevName ?? fileDiff.name) || !knownBlob(entry.head, fileDiff.name)) return false;
  }
  return true;
}

function paintNow(generation) {
  performance.mark("diffview:render-files-start");
  try {
    renderFileViews(generation);
  } finally {
    if (generation === renderGeneration) performance.measure("diffview:render-files", "diffview:render-files-start");
  }
  return Promise.resolve();
}

/** Fetches both sides of each visible modified file. Collapsed files wait until they are opened. */
async function warmVisibleFiles() {
  const parsed = parsedByPath(state.diff.patch);
  const { entry } = state.diff;
  const jobs = [];
  for (const file of state.diff.files) {
    if (!rendered(file) || collapsedNow(file)) continue;
    const fileDiff = parsed.get(file.path);
    if (!fileDiff || !needsWholeFile(fileDiff)) continue;
    jobs.push(blobAt(entry.base, fileDiff.prevName ?? fileDiff.name), blobAt(entry.head, fileDiff.name));
  }
  await Promise.allSettled(jobs);
}

async function paintFiles(generation) {
  await warmVisibleFiles();
  if (generation !== renderGeneration) return;
  paintNow(generation);
}

/* Collapsing files */

// Whether each file is collapsed, by branch and path, as the person left it, so re-renders (live reload, layout, filters) keep it.
const collapsedChoice = new Map();
const choiceKey = (file) => `${state.branch}\0${file.path}`;

/** Whether a file shows collapsed: as the person left it, else collapsed when viewed, generated, or too big to read in place. */
function collapsedNow(file) {
  return collapsedChoice.get(choiceKey(file)) ?? (viewedState(file) === "viewed" || startsCollapsed(file));
}

/** Collapses or expands a rendered file, and remembers it. Opening one still painted from its hunks waits until the whole file is loaded, so the lines that appear are highlighted from it. */
export function setCollapsed(item, collapsed) {
  collapsedChoice.set(choiceKey(item.file), collapsed);
  if (!collapsed && needsWholeFile(item.fileDiff)) {
    void openHighlighted(item, renderGeneration);
    return;
  }
  // A file collapsed from its pinned header shrinks above the viewport; bring its header back, or the page lands somewhere in the files after it.
  const pinned = collapsed && item.section.getBoundingClientRect().top < $(".topbar").getBoundingClientRect().bottom;
  applyCollapsed(item);
  if (pinned) item.section.scrollIntoView({ block: "start" });
}

function applyCollapsed(item) {
  item.options = { ...item.options, collapsed: collapsedNow(item.file) };
  item.view.setOptions(item.options);
  item.view.rerender();
}

async function openHighlighted(item, generation) {
  try {
    await withWholeFile(item, state.diff.entry);
  } catch (err) {
    console.error(err);
  }
  if (generation !== renderGeneration || !item.view || collapsedNow(item.file)) return;
  applyCollapsed(item);
}

const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

/** The chevron before a file's name that collapses and expands it. */
function collapseToggle(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "collapse-toggle";
  const collapsed = item.options.collapsed;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = collapsed ? "Expand" : "Collapse";
  button.innerHTML = CHEVRON;
  button.addEventListener("click", () => setCollapsed(item, !item.options.collapsed));
  return button;
}

// Bumped on every render so a file fetch from the previous one cannot paint into the new page.
let renderGeneration = 0;

function mountFile(item) {
  item.section.replaceChildren();
  item.options = { ...item.options, diffStyle: state.diffStyle, themeType: root.dataset.theme, collapsed: collapsedNow(item.file) };
  item.view = new FileDiff(item.options);
  item.view.render({ fileDiff: item.fileDiff, containerWrapper: item.section, lineAnnotations: lineAnnotationsFor(item.file) });
  state.views.push(item);
}

/** Loads the whole file, then paints. A hidden child holds the section's place so a later file cannot become the first one while this is in flight. */
async function mountWhenHighlighted(item, entry, generation) {
  const place = document.createElement("div");
  place.hidden = true;
  item.section.replaceChildren(place);
  try {
    await withWholeFile(item, entry);
  } catch (err) {
    console.error(err);
  }
  if (generation !== renderGeneration || item.view) return;
  mountFile(item);
}

/** Both sides when this page already holds them, `{missing}` when a fetch failed, or null when they are not loaded yet. */
function readySides(fileDiff, entry) {
  const oldSide = knownBlob(entry.base, fileDiff.prevName ?? fileDiff.name);
  const newSide = knownBlob(entry.head, fileDiff.name);
  if (!oldSide || !newSide) return null;
  if (oldSide.missing || newSide.missing) return { missing: true };
  return { oldFile: oldSide.file, newFile: newSide.file };
}

function renderFileViews(generation) {
  cleanUpViews();
  const container = $("#diffs");
  container.replaceChildren();
  const parsed = parsedByPath(state.diff.patch);
  const { entry } = state.diff;
  state.renderedPaths = renderedPaths();
  state.diff.files.forEach((file, index) => {
    if (!rendered(file)) return;
    const section = document.createElement("section");
    section.className = "file-diff";
    section.id = `file-${index}`;
    section.dataset.path = file.path;
    container.append(section);
    const fileDiff = parsed.get(file.path);
    if (file.binary || !fileDiff) {
      section.innerHTML = `<div class="file-placeholder"><strong>${escapeHtml(file.path)}</strong> <span class="faint">${file.binary ? "binary file" : "no textual changes"}</span></div>`;
      return;
    }
    const item = { file, fileDiff, section, view: null, options: null };
    item.options = {
      diffStyle: state.diffStyle,
      theme: PIERRE_THEMES,
      themeType: root.dataset.theme,
      overflow: "wrap",
      lineDiffType: "word-alt",
      hunkSeparators: "line-info",
      loadDiffFiles: (diff) => loadBothSides(diff, entry),
      collapsed: collapsedNow(file),
      stickyHeader: true,
      unsafeCSS: GRAPHITE_DIFF_CSS + ROW_MARK_CSS,
      enableLineSelection: state.comments.enabled,
      lineHoverHighlight: state.comments.enabled ? "both" : "disabled",
      onLineSelectionStart: (range) => markSelectionSide(item, range),
      onLineSelectionChange: (range) => markSelectionSide(item, range),
      onLineSelectionEnd: (range) => selectedLines(item, range),
      onLineClick: (props) => clickedLine(item, props),
      onPostRender: () => {
        markRows(item);
        revealCommentedLines(item);
        scheduleLayout();
      },
      renderAnnotation,
      renderHeaderPrefix: () => collapseToggle(item),
      renderHeaderMetadata: () => headerControls(item, openInCursor(file)),
    };
    if (!item.options.collapsed && needsWholeFile(fileDiff)) {
      const sides = readySides(fileDiff, entry);
      if (sides?.oldFile && withinHighlightLimit(sides)) hydratePartialDiff("merge", fileDiff, sides);
      else if (!sides) {
        void mountWhenHighlighted(item, entry, generation);
        return;
      }
    }
    mountFile(item);
  });
  if (!state.diff.files.length) container.innerHTML = '<p class="empty">This branch changes nothing.</p>';
  const summary = hiddenSummary(state.diff.files);
  if (summary) container.insertAdjacentHTML("beforeend", `<p class="hidden-files faint">${escapeHtml(summary)}. <button class="link" type="button" data-reset-filters>Show all files</button></p>`);
}

/** Renders each file again with its current threads as inline annotations, or none. */
export function rerenderFiles() {
  for (const item of state.views) item.view.render({ fileDiff: item.fileDiff, lineAnnotations: lineAnnotationsFor(item.file), forceRender: true });
}
