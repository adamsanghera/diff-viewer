/** Light, dark, or following the system, for the page and Pierre's diffs. */
import { $, root, state } from "./state.js";

const THEMES = ["auto", "light", "dark"];
export const PREFERS_DARK = matchMedia("(prefers-color-scheme: dark)");

export function applyTheme() {
  const pref = localStorage.getItem("diffview.theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && PREFERS_DARK.matches);
  root.dataset.theme = dark ? "dark" : "light";
  $("#theme").dataset.pref = pref;
  $("#theme").title = `Theme: ${pref}. Click to change.`;
  for (const { view } of state.views) view.setThemeType(root.dataset.theme);
}

export function cycleTheme() {
  const pref = localStorage.getItem("diffview.theme") || "auto";
  localStorage.setItem("diffview.theme", THEMES[(THEMES.indexOf(pref) + 1) % THEMES.length]);
  applyTheme();
}
