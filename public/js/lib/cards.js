/** The comment threads' HTML: cards, the rail's header, and the grouped list. Adapted from mdview's. */
import { ago, escapeHtml, truncate } from "./format.js";
import { keyHint } from "./keys.js";

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
  if (t.pending) chips.push('<span class="chip chip-pending" title="In your batch. Agents see it after you send.">Pending</span>');
  if (t.status === "suggested") chips.push('<span class="chip chip-suggested">Agent suggests resolving</span>');
  if (t.status === "open" && t.waitingOn === "human") chips.push('<span class="chip chip-turn" title="The agent answered. This waits on you.">Your turn</span>');
  if (t.status === "resolved") chips.push('<span class="chip">Resolved</span>');
  const of = t.kind === "description" ? "description " : "";
  const what = t.kind === "description" ? "paragraph" : "lines";
  if (t.state === "carried") chips.push(`<span class="chip" title="Made on ${of}v${t.madeOn.seq}. Its ${what} have not changed since.">from ${of}v${t.madeOn.seq}</span>`);
  if (t.state === "outdated") chips.push(`<span class="chip chip-outdated" title="Its ${what} changed after ${of}v${t.madeOn.seq}.">outdated · made on ${of}v${t.madeOn.seq}</span>`);
  return chips.join("");
}

/** One message. Its delete button shows on open cards; on the first message it deletes the whole thread. */
function messageItem(m, first) {
  const time = Date.parse(m.sentAt ?? m.createdAt);
  const session = m.session ? ` title="Session ${escapeHtml(m.session)}"` : "";
  const badge =
    (m.authorKind === "agent" ? `<span class="badge"${session}>agent</span>` : "") +
    (m.pending ? '<span class="badge badge-pending" title="In your batch. Agents see it after you send.">pending</span>' : "");
  const remove = first
    ? '<button class="message-delete" type="button" data-action="delete-thread" title="Delete this thread permanently">×</button>'
    : `<button class="message-delete" type="button" data-action="delete-message" data-message="${m.id}" title="Delete this message permanently">×</button>`;
  return `<li class="message" data-kind="${m.authorKind}">
    <div class="message-meta"><span class="author">${escapeHtml(m.author)}</span>${badge}<span class="when" title="${escapeHtml(new Date(time).toLocaleString())}">${ago(time)} · v${m.versionSeq}</span>${remove}</div>
    <div class="message-body">${m.bodyHtml}</div>
  </li>`;
}

/** The open card's reply box and actions. A pending thread is a draft, so it can only be replied to or deleted. */
function threadControls(t, batching) {
  const placeholder = t.status === "suggested" ? "Reply and reopen…" : "Reply…";
  const reopen = t.pending || t.status === "open" ? "" : '<button class="btn" type="button" data-action="open">Reopen</button>';
  const resolve = t.pending || t.status === "resolved" ? "" : '<button class="btn btn-primary" type="button" data-action="resolved">Resolve</button>';
  return `<textarea class="reply" rows="1" placeholder="${placeholder}" aria-label="Reply"></textarea>
    <p class="key-hint">${keyHint(batching)}</p>
    <div class="thread-actions"><button class="btn btn-danger" type="button" data-action="delete-thread" title="Delete this thread permanently">Delete</button><span class="spacer"></span>${reopen}${resolve}</div>`;
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
  const items = shown.map((m) => messageItem(m, m.id === t.messages[0].id));
  const hidden = t.messages.length - shown.length;
  if (hidden) items.splice(1, 0, `<li class="message more">${hidden} more</li>`);
  const where = listed ? `<span class="thread-where">${escapeHtml(anchorLabel(t))}</span>` : "";
  const lines = listed || t.state === "outdated" || t.kind === "description" ? excerpt(t) : "";
  return `<section class="thread${expanded ? " expanded" : ""}" data-thread="${t.id}" data-status="${t.status}" data-pending="${t.pending}" data-turn="${t.waitingOn ?? ""}">
    <header class="thread-head"><span class="thread-id">#${t.id}</span>${where}${threadChips(t)}</header>
    ${lines}
    ${nowReads(t)}
    <ol class="messages">${items.join("")}</ol>
    ${expanded ? threadControls(t, batching) : ""}
  </section>`;
}

/** The rail's header: the unresolved count, and the toggle between margin and list. */
export function railHead(threads, { listing }) {
  const unresolved = threads.filter((t) => t.status !== "resolved");
  const older = unresolved.filter((t) => t.state === "outdated").length;
  const olderLink = older && !listing ? ` · <button class="link" type="button" data-action="list">${older} on older versions</button>` : "";
  return `<div class="rail-head"><span>${unresolved.length} unresolved${olderLink}</span><button class="link" type="button" data-action="list">${listing ? "Show in margin" : "All comments"}</button></div>`;
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
