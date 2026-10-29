/** What the page shows, shared by main.js and comments.js, and the small helpers both use. */

export const $ = (selector) => document.querySelector(selector);
export const root = document.documentElement;

export const state = {
  info: null,
  stackOf: null,
  branch: null,
  stack: null,
  /** While the stack's overview shows instead of a branch: {entry, diff, branches} from /api/overview. */
  overview: null,
  /** Each branch's {additions, deletions} for the sidebar, by branch name; null until they load. */
  stackSizes: null,
  /** Which branches are in trunk, by name: "merged" (local trunk) or "pushed" (also the remote's); absent when neither. */
  mergeState: {},
  diff: null,
  /** The branch's description: {seq, title, html, sha256, ...}, or null when it has none. */
  description: null,
  /** The stored version shown instead of the current diff, or null. */
  version: null,
  /** Per rendered file: {file, fileDiff, view, options, section}. */
  views: [],
  layout: localStorage.getItem("diffview.layout") || "auto",
  diffStyle: null,
  comments: {
    enabled: false,
    threads: [],
    pendingCount: 0,
    /** Whether new comments and replies go into the batch: the sticky "Add to batch" checkbox. */
    batch: localStorage.getItem("diffview.batch") === "on",
    viewed: {},
    /** The branch shown's own viewed mark, {branch, mark}: mark "viewed", "changed" or null. */
    branchViewed: null,
    active: null,
    listMode: false,
    inline: localStorage.getItem("diffview.threads") === "inline",
    composer: null,
    replyText: new Map(),
  },
  /** Set when live reload waited for the composer to close. */
  reloadWaiting: false,
};

export async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

/** Posts JSON the way the server requires of its own page; throws the server's message on refusal. */
export async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(reply.error ?? res.statusText), { status: res.status });
  return reply;
}

let toastTimer;
export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

export function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

/** The page side names Pierre uses for diff sides. */
export const PIERRE_SIDE = { new: "additions", old: "deletions" };
export const SIDE_OF = { additions: "new", deletions: "old" };
