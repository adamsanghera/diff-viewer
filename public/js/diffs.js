/** The branch's files, each rendered by Pierre's FileDiff, and the layout they use: Auto, Split, or Unified. */
import { FileDiff, parsePatchFiles } from "/vendor/pierre.js";
import {
  clickedLine,
  headerControls,
  lineAnnotationsFor,
  markRows,
  renderAnnotation,
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
pre, [data-code], [data-content], [data-gutter-buffer], [data-diffs-header], [data-line-type="context"], [data-column-number][data-line-type="context"], [data-gutter] { background-color: var(--bg) !important; }
[data-line-type="change-addition"] { background-color: var(--diff-added) !important; }
[data-line-type="change-deletion"] { background-color: var(--diff-removed) !important; }
[data-line-type="change-addition"] [data-diff-span] { background-color: var(--diff-added-word) !important; }
[data-line-type="change-deletion"] [data-diff-span] { background-color: var(--diff-removed-word) !important; }
[data-column-number][data-line-type="change-addition"] { color: var(--diff-added-number) !important; background-color: var(--diff-added-gutter) !important; }
[data-column-number][data-line-type="change-deletion"] { color: var(--diff-removed-number) !important; background-color: var(--diff-removed-gutter) !important; }
[data-separator], [data-separator-wrapper], [data-separator-content] { background-color: var(--bg) !important; }
[data-separator] { border-block: 1px dashed var(--border); }
[data-separator-content] { color: var(--text-faint); font-size: 11px; }
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

/**
 * Both sides of a changed file, for expanding its unmodified lines: the old
 * side at the branch's base, the new at its head. Pierre calls it the first
 * time someone expands one of the file's separators, and only then.
 */
async function loadBothSides(fileDiff, { base, head }) {
  const at = async (rev, name) => {
    const { contents } = await getJson(`/api/file?${new URLSearchParams({ rev, path: name })}`);
    return { name, contents, cacheKey: `${rev}:${name}` };
  };
  if (fileDiff.type === "rename-pure") return { oldFile: null, newFile: await at(head, fileDiff.name) };
  const [oldFile, newFile] = await Promise.all([at(base, fileDiff.prevName ?? fileDiff.name), at(head, fileDiff.name)]);
  return { oldFile, newFile };
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

/** Renders the branch's files, measured as "diffview:render-files" for ?perf and DevTools' Performance panel. */
export function renderFiles() {
  performance.mark("diffview:render-files-start");
  try {
    renderFileViews();
  } finally {
    performance.measure("diffview:render-files", "diffview:render-files-start");
  }
}

/* Collapsing files */

// Whether each file is collapsed, by branch and path, as the person left it, so re-renders (live reload, layout, filters) keep it.
const collapsedChoice = new Map();
const choiceKey = (file) => `${state.branch}\0${file.path}`;

/** Whether a file shows collapsed: as the person left it, else collapsed when viewed, generated, or too big to read in place. */
function collapsedNow(file) {
  return collapsedChoice.get(choiceKey(file)) ?? (viewedState(file) === "viewed" || startsCollapsed(file));
}

/** Collapses or expands a rendered file, and remembers it. */
export function setCollapsed(item, collapsed) {
  collapsedChoice.set(choiceKey(item.file), collapsed);
  item.options = { ...item.options, collapsed };
  item.view.setOptions(item.options);
  item.view.rerender();
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

function renderFileViews() {
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
      unsafeCSS: GRAPHITE_DIFF_CSS + ROW_MARK_CSS,
      enableLineSelection: state.comments.enabled,
      lineHoverHighlight: state.comments.enabled ? "both" : "disabled",
      onLineSelectionStart: (range) => markSelectionSide(item, range),
      onLineSelectionChange: (range) => markSelectionSide(item, range),
      onLineSelectionEnd: (range) => selectedLines(item, range),
      onLineClick: (props) => clickedLine(item, props),
      onPostRender: () => {
        markRows(item);
        scheduleLayout();
      },
      renderAnnotation,
      renderHeaderPrefix: () => collapseToggle(item),
      renderHeaderMetadata: () => headerControls(item, openInCursor(file)),
    };
    item.view = new FileDiff(item.options);
    item.view.render({ fileDiff, containerWrapper: section, lineAnnotations: lineAnnotationsFor(file) });
    state.views.push(item);
  });
  if (!state.diff.files.length) container.innerHTML = '<p class="empty">This branch changes nothing.</p>';
  const summary = hiddenSummary(state.diff.files);
  if (summary) container.insertAdjacentHTML("beforeend", `<p class="hidden-files faint">${escapeHtml(summary)}. <button class="link" type="button" data-reset-filters>Show all files</button></p>`);
}

/** Renders each file again with its current threads as inline annotations, or none. */
export function rerenderFiles() {
  for (const item of state.views) item.view.render({ fileDiff: item.fileDiff, lineAnnotations: lineAnnotationsFor(item.file), forceRender: true });
}
