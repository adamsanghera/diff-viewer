/** The comment threads' HTML: cards, the rail's header, and the grouped list. Adapted from mdview's. */
import { ago, escapeHtml, truncate } from "./format.js";
import { submitButton } from "./keys.js";

const NOW_READS_PREVIEW_CHARS = 140;

// The list view's sections, in order. Each thread goes in the first one that takes it.
export const GROUPS = [
  ["Pending, not sent", (t) => t.pending],
  ["Waiting on you", (t) => t.status !== "resolved" && t.state !== "outdated" && t.waitingOn === "human"],
  ["Waiting on the agent", (t) => t.status !== "resolved" && t.state !== "outdated"],
  ["On older versions", (t) => t.status !== "resolved"],
  ["Resolved", () => true],
];

/** Where a thread sits, in words: "app.js:12-14", "app.js (old side):9", "app.js", or "whole branch". */
export function anchorLabel(t) {
  if (t.kind === "description") return t.heading ? `description · ${t.heading}` : "description";
  if (t.kind === "branch") return "whole branch";
  const file = t.path.split("/").pop();
  if (t.kind === "file") return file;
  const lines = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
  return `${file}${t.side === "old" ? " (old)" : ""}:${lines}`;
}

function threadChips(t) {
  const chips = [];
  if (t.pending) chips.push('<span class="chip" title="In your batch. Agents see it after you send.">Pending</span>');
  if (t.status === "suggested") chips.push('<span class="chip chip-suggested">Agent suggests resolving</span>');
  if (t.status === "open" && t.waitingOn === "human") chips.push('<span class="chip chip-turn" title="The agent answered. This waits on you.">Your turn</span>');
  if (t.status === "resolved") chips.push('<span class="chip">Resolved</span>');
  const of = t.kind === "description" ? "description " : "";
  const what = t.kind === "description" ? "paragraph" : "lines";
  if (t.state === "carried") chips.push(`<span class="chip" title="Made on ${of}v${t.madeOn.seq}. Its ${what} have not changed since.">from ${of}v${t.madeOn.seq}</span>`);
  if (t.state === "outdated") chips.push(`<span class="chip chip-outdated" title="Its ${what} changed after ${of}v${t.madeOn.seq}.">outdated · made on ${of}v${t.madeOn.seq}</span>`);
  return chips.join("");
}

/**
 * One message. A reply's delete button shows on open cards; the first message
 * has none, since deleting it is deleting the thread (the header's menu). A
 * pending reply is badged, unless the whole thread is pending and its header
 * already says so.
 */
function messageItem(m, first, threadPending) {
  const time = Date.parse(m.sentAt ?? m.createdAt);
  const session = m.session ? ` title="Session ${escapeHtml(m.session)}"` : "";
  const badge =
    (m.authorKind === "agent" ? `<span class="badge"${session}>agent</span>` : "") +
    (m.pending && !threadPending ? '<span class="badge badge-pending" title="In your batch. Agents see it after you send.">pending</span>' : "");
  const remove = first ? "" : `<button class="message-delete" type="button" data-action="delete-message" data-message="${m.id}" title="Delete this message permanently">×</button>`;
  return `<li class="message" data-kind="${m.authorKind}">
    <div class="message-meta"><span class="author">${escapeHtml(m.author)}</span>${badge}<span class="when" title="${escapeHtml(new Date(time).toLocaleString())}">${ago(time)} · v${m.versionSeq}</span>${remove}</div>
    <div class="message-body">${m.bodyHtml}</div>
  </li>`;
}

/** Resolve, in every card's header, so a thread resolves in one click without opening it. A pending thread is a draft, so it has none. */
function resolveButton(t) {
  if (t.pending || t.status === "resolved") return "";
  return '<button class="thread-resolve" type="button" data-action="resolved" title="Resolve this thread">✓ Resolve</button>';
}

const DOTS_ICON = '<svg class="icon icon-dots" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01"/></svg>';
const TRASH_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/></svg>';

/** The ⋯ menu at the top right of every card. Picking Delete thread is the confirmation, so deleting takes two clicks without opening the card. */
function threadMenu() {
  return `<span class="thread-more"><button class="thread-more-btn" type="button" data-action="thread-menu" aria-haspopup="menu" aria-expanded="false" title="More">${DOTS_ICON}</button><span class="thread-menu" role="menu" hidden><button type="button" role="menuitem" data-action="delete-thread">${TRASH_ICON}Delete thread</button></span></span>`;
}

/** The open card's reply box and actions. */
function threadControls(t, batching) {
  const placeholder = t.status === "suggested" ? "Reply and reopen…" : "Reply…";
  const reopen = t.pending || t.status === "open" ? "" : '<button class="btn" type="button" data-action="open">Reopen</button>';
  return `<textarea class="reply" rows="1" placeholder="${placeholder}" aria-label="Reply"></textarea>
    <div class="thread-actions"><div class="thread-actions-end">${submitButton(batching, { now: "Reply", primary: false })}${reopen}</div></div>`;
}

/** For an outdated thread: what its lines became, and a link to the version it was made on. */
function nowReads(t) {
  if (t.state === "outdated" && t.kind === "description") {
    const text = t.nowReads ? `<strong>Now reads:</strong> ${escapeHtml(truncate(t.nowReads.text.replace(/\s+/g, " "), NOW_READS_PREVIEW_CHARS))}` : "<strong>Its paragraph was removed or rewritten.</strong>";
    return `<p class="now-reads">${text}</p>`;
  }
  if (t.state !== "outdated" || t.kind !== "lines") return "";
  const text = t.nowReads
    ? `<strong>Now reads:</strong> <code>${escapeHtml(truncate(t.nowReads.text.replace(/\s+/g, " "), NOW_READS_PREVIEW_CHARS))}</code>`
    : "<strong>Its lines were removed or rewritten.</strong>";
  return `<p class="now-reads">${text} <button class="link" type="button" data-action="version" data-seq="${t.madeOn.seq}">View v${t.madeOn.seq}</button></p>`;
}

/** The lines a thread was made on, as they read then, for outdated cards and the list. */
function excerpt(t) {
  if (t.kind === "description") return t.quote ? `<blockquote class="thread-quote">${escapeHtml(t.quote)}</blockquote>` : "";
  const marked = t.excerpt.filter((l) => l.marked);
  if (!marked.length) return "";
  return `<pre class="thread-excerpt">${marked.map((l) => escapeHtml(l.text)).join("\n")}</pre>`;
}

/**
 * A thread card. Collapsed cards show the first and last messages; the open
 * (`expanded`) card shows all of them and its controls. `listed` cards, in
 * the list view, also say where the thread sits.
 */
export function threadCard(t, { expanded = false, batching = false, listed = false }) {
  const shown = expanded || t.messages.length <= 2 ? t.messages : [t.messages[0], t.messages.at(-1)];
  const items = shown.map((m) => messageItem(m, m.id === t.messages[0].id, t.pending));
  const hidden = t.messages.length - shown.length;
  if (hidden) items.splice(1, 0, `<li class="message more">${hidden} more</li>`);
  const where = listed ? `<span class="thread-where">${escapeHtml(anchorLabel(t))}</span>` : "";
  const lines = listed || t.state === "outdated" || t.kind === "description" ? excerpt(t) : "";
  return `<section class="thread${expanded ? " expanded" : ""}" data-thread="${t.id}" data-status="${t.status}" data-pending="${t.pending}" data-turn="${t.waitingOn ?? ""}">
    <header class="thread-head"><span class="thread-id">#${t.id}</span>${where}${threadChips(t)}<span class="thread-head-end">${resolveButton(t)}${threadMenu()}</span></header>
    ${lines}
    ${nowReads(t)}
    <ol class="messages">${items.join("")}</ol>
    ${expanded ? threadControls(t, batching) : ""}
  </section>`;
}

const RAIL_MODES = [
  ["margin", "Beside code", "Each comment next to the lines it is on"],
  ["list", "List", "Every comment on this branch, grouped by who it waits on"],
];

/** The rail's header: the unresolved count, and a switch between cards beside the code and the list. */
export function railHead(threads, { listing }) {
  const unresolved = threads.filter((t) => t.status !== "resolved");
  const older = unresolved.filter((t) => t.state === "outdated").length;
  const olderLink = older && !listing ? ` · <button class="link" type="button" data-action="list">${older} on older versions</button>` : "";
  const modes = RAIL_MODES.map(
    ([mode, label, title]) => `<button type="button" data-action="rail-mode" data-mode="${mode}" title="${title}" aria-pressed="${(mode === "list") === listing}">${label}</button>`,
  ).join("");
  return `<div class="rail-head"><span>${unresolved.length} unresolved${olderLink}</span><div class="seg" role="group" aria-label="Show comments">${modes}</div></div>`;
}

/** The list view: every thread under the first group that takes it, with the `active` one open. */
export function railList(threads, { active, batching }) {
  const groups = GROUPS.map(([title]) => ({ title, threads: [] }));
  for (const thread of threads) groups[GROUPS.findIndex(([, takes]) => takes(thread))].threads.push(thread);
  const html = groups
    .filter((g) => g.threads.length)
    .map((g) => `<h3 class="rail-group">${g.title} <span>${g.threads.length}</span></h3>` + g.threads.map((t) => threadCard(t, { expanded: t.id === active, batching, listed: true })).join(""))
    .join("");
  return html || '<p class="rail-empty">No comments on this branch yet. Click a line number to add one.</p>';
}
