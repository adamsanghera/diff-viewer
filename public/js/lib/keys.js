/**
 * The comment and reply boxes' keys. Enter is a new line. Shift+Enter, or
 * ⌘/Ctrl+Enter, submits what was written as its button says: sent at once,
 * or added to the batch. No key sends the batch; only the Send batch button
 * at the top right does.
 */

/** Whether a keydown in a comment or reply box submits it. */
export function isSubmitKey(event) {
  return event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey) && !event.altKey && !event.isComposing;
}

const CHEVRON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

/**
 * The submit button under a comment or reply box: its label is what Enter
 * does (`now`, such as "Comment", or "Add to batch"), and its chevron opens
 * a menu that switches between the two without submitting. The choice is
 * one for the whole page (the sticky batch mode), so every copy shows it.
 */
export function submitButton(batch, { now, primary = true, id = "" }) {
  const style = primary ? "btn btn-primary" : "btn";
  const choice = (value, label, detail) =>
    `<button class="split-choice" type="button" role="menuitemradio" aria-checked="${batch === value}" data-batch-choice="${value ? "on" : "off"}"><strong>${label}</strong><span>${detail}</span></button>`;
  return `<span class="split-btn">
    <button class="${style} split-main" type="button" data-submit data-label-now="${now}"${id ? ` id="${id}"` : ""}>${batch ? "Add to batch" : now}</button><button class="${style} split-chevron" type="button" data-batch-menu aria-haspopup="menu" aria-expanded="false" title="Send now, or hold in your batch">${CHEVRON}</button>
    <span class="split-menu" role="menu" hidden>${choice(false, now, "Send it to agents now")}${choice(true, "Add to batch", "Hold it, hidden from agents, until you press Send batch")}</span>
  </span>`;
}
