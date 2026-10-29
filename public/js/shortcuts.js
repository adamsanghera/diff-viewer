/** Keyboard shortcuts. `show` (main.js) moves to another branch. */
import { toggleInline } from "./comments.js";
import { cycleLayout } from "./diffs.js";
import { stackRows } from "./lib/tree.js";
import { toggleSidebar } from "./sidebar.js";
import { $, state } from "./state.js";

function moveFile(step) {
  const sections = [...document.querySelectorAll(".file-diff")];
  const current = sections.findIndex((s) => s.getBoundingClientRect().top > 60);
  const target = sections[Math.max(0, Math.min(sections.length - 1, (current === -1 ? sections.length : current) + (step > 0 ? 0 : -2)))];
  target?.scrollIntoView({ block: "start" });
}

export function installShortcuts({ show }) {
  const moveBranch = (step) => {
    const rows = stackRows(state.stack.entries).map((r) => r.entry.id);
    const next = rows[rows.indexOf(state.branch) - step];
    if (next) show(next);
  };
  const actions = {
    "/": () => $("#filter").focus(),
    f: toggleSidebar,
    s: cycleLayout,
    i: toggleInline,
    "[": () => moveBranch(-1),
    "]": () => moveBranch(1),
    j: () => moveFile(1),
    k: () => moveFile(-1),
  };
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.("input, textarea")) return;
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
}
