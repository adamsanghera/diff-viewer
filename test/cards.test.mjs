import { test } from "node:test";
import assert from "node:assert/strict";
import { threadCard } from "../public/js/lib/cards.js";

const message = (id, pending) => ({ id, author: "adam", authorKind: "human", createdAt: "2026-11-02T19:00:00Z", versionSeq: 1, bodyHtml: "<p>hi</p>", pending });
const thread = (pending, messages) => ({ id: 1, kind: "file", path: "src/app.js", status: "open", state: "current", waitingOn: "agent", pending, messages });
const count = (html, text) => html.split(text).length - 1;

test("a pending thread says Pending once, in its header, not again on its message", () => {
  const html = threadCard(thread(true, [message(1, true)]), {});
  assert.equal(count(html, ">Pending<"), 1);
  assert.equal(count(html, "badge-pending"), 0);
});

test("every card, pending or not, deletes from its header's menu; only replies have their own delete", () => {
  for (const pending of [true, false]) {
    const html = threadCard(thread(pending, [message(1, pending), message(2, pending)]), { expanded: true });
    assert.equal(count(html, 'data-action="delete-thread"'), 1);
    assert.ok(html.indexOf('data-action="delete-thread"') < html.indexOf("</header>"), "the thread's delete is in its header");
    assert.equal(count(html, 'data-action="delete-message"'), 1);
  }
});

test("a pending reply on a sent thread is badged on the reply", () => {
  const html = threadCard(thread(false, [message(1, false), message(2, true)]), {});
  assert.equal(count(html, ">Pending<"), 0);
  assert.equal(count(html, "badge-pending"), 1);
});
