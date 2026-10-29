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
import { KINDS, rendered, renderedPaths } from "./kinds.js";
import { escapeHtml, startsCollapsed } from "./lib/format.js";
import { $, root, state } from "./state.js";

const PIERRE_THEMES = { light: "pierre-light", dark: "pierre-dark" };
const LAYOUTS = ["auto", "split", "unified"];
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
[data-column-number][data-line-type="change-addition"] { color: var(--diff-added-number) !important; }
[data-column-number][data-line-type="change-deletion"] { color: var(--diff-removed-number) !important; }
[data-separator], [data-separator-content], [data-separator-wrapper] { background-color: var(--bg-soft) !important; color: var(--text-faint); }
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
  $('[data-layout="auto"]').title = `Split when the window is wide enough, else one column; now ${diffStyle} (s)`;
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

/** `s`: Auto, then Split, then Unified. */
export function cycleLayout() {
  setLayout(LAYOUTS[(LAYOUTS.indexOf(state.layout) + 1) % LAYOUTS.length]);
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

function renderFileViews() {
  cleanUpViews();
  const container = $("#diffs");
  container.replaceChildren();
  const parsed = parsedByPath(state.diff.patch);
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
      overflow: "scroll",
      lineDiffType: "word-alt",
      hunkSeparators: "line-info",
      collapsed: viewedState(file) === "viewed" || startsCollapsed(file),
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
      renderHeaderMetadata: () => headerControls(item, openInCursor(file)),
    };
    item.view = new FileDiff(item.options);
    item.view.render({ fileDiff, containerWrapper: section, lineAnnotations: lineAnnotationsFor(file) });
    state.views.push(item);
  });
  if (!state.diff.files.length) container.innerHTML = '<p class="empty">This branch changes nothing.</p>';
  const hidden = hiddenNote(state.diff.files.filter((f) => !rendered(f)));
  if (hidden) container.insertAdjacentHTML("beforeend", hidden);
}

/** "2 test files and 1 generated file hidden", with buttons that show them; empty when none are. */
function hiddenNote(files) {
  const parts = Object.keys(KINDS)
    .map((kind) => [kind, files.filter((f) => f.kind === kind).length])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `<button class="link" type="button" data-show-kind="${kind}">${n} ${kind === "test" ? "test" : "generated"} ${n === 1 ? "file" : "files"}</button>`);
  if (!parts.length) return "";
  return `<p class="hidden-files faint">${parts.join(" and ")} hidden. Click to show ${parts.length === 1 ? "them" : "either kind"}.</p>`;
}

/** Renders each file again with its current threads as inline annotations, or none. */
export function rerenderFiles() {
  for (const item of state.views) item.view.render({ fileDiff: item.fileDiff, lineAnnotations: lineAnnotationsFor(item.file), forceRender: true });
}
