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

test("a pending reply on a sent thread is badged on the reply", () => {
  const html = threadCard(thread(false, [message(1, false), message(2, true)]), {});
  assert.equal(count(html, ">Pending<"), 0);
  assert.equal(count(html, "badge-pending"), 1);
});
