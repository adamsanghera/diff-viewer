import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../lib/server.mjs";
import { openStore } from "../../lib/store.mjs";
import { ensureVendorBundle } from "../../lib/vendor.mjs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { makeRepo } from "../helpers/repo.mjs";

const chrome = sharedChrome();
const servers = [];
after(() => Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))));
const options = { skip: chromeMissing };

/** Writes a description file outside any repo and returns its path. */
function descriptionFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-desc-")), "description.md");
  fs.writeFileSync(file, text);
  return file;
}

const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i] ?? `const v${i} = ${i};`).join("\n") + "\n";

/** feat/a <- feat/b, where b changes line 11 of app.js and adds util.js; the viewer has a store of its own. */
async function openViewer({ width = 1700 } = {}) {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "feat/a");
  repo.commit("a", { "src/app.js": lines(30) });
  repo.git("checkout", "-q", "-b", "feat/b");
  repo.commit("b", { "src/app.js": lines(30, { 10: "const v10 = compute(10);" }), "src/util.js": "export const compute = (x) => x * 2;\n" });
  await ensureVendorBundle();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-browser-"));
  const started = await startServer({ dir: repo.dir, port: 4960, store: await openStore(home) });
  servers.push(started);
  const page = await (await chrome()).open(`${started.url}view`, { width, height: 950 });
  await page.waitFor(() => document.querySelector(".file-diff > *")?.shadowRoot?.querySelector("[data-line]"), { what: "a rendered diff" });
  return { repo, home, page, started };
}

/** Clicks a line number in the first file's new side, as a person would. */
async function clickLineNumber(page, line) {
  const point = await page.eval((n) => {
    const shadow = document.querySelector(".file-diff > *").shadowRoot;
    const cell = shadow.querySelector(`code[data-additions] [data-column-number="${n}"]`) ?? shadow.querySelector(`code[data-unified] [data-column-number="${n}"]`);
    const r = cell.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, line);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}

async function typeAndPress(page, text, key = "Enter", modifiers = 0) {
  await page.send("Input.insertText", { text });
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: 13, modifiers });
}

const railCards = () => [...document.querySelectorAll("#rail .thread")].map((c) => ({ id: Number(c.dataset.thread), status: c.dataset.status, text: c.innerText }));
const markedRows = () => [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll("[data-dv-comment]")].map((r) => `${r.dataset.line}:${r.dataset.dvComment}`);

async function commentOnLine11(page, text = "Why double it here?") {
  await clickLineNumber(page, 11);
  await page.waitFor(() => !document.querySelector("#composer").hidden, { what: "the composer" });
  await typeAndPress(page, text);
  await page.waitFor(() => document.querySelectorAll("#rail .thread").length === 1, { what: "a card in the rail" });
}

test("clicking a line number and pressing Enter leaves a comment beside the line", options, async () => {
  const { page } = await openViewer();
  await commentOnLine11(page);
  assert.match(await page.eval(() => document.querySelector("#composer-where").textContent), /app\.js:11/);
  const [card] = await page.eval(railCards);
  assert.match(card.text, /Why double it here\?/);
  assert.deepEqual(await page.eval(markedRows), ["11:open"]);
  const offset = await page.eval(() => {
    const row = document.querySelector(".file-diff > *").shadowRoot.querySelector('code[data-additions] [data-line="11"]');
    return Math.abs(document.querySelector("#rail .thread").getBoundingClientRect().top - row.getBoundingClientRect().top);
  });
  assert.ok(offset < 4, `the card sits ${offset}px from its line`);
  await page.waitFor(() => document.querySelector('.stack-row[data-branch="feat/b"] .badge-comments')?.textContent === "1", { what: "the stack's comment badge" });
  assert.deepEqual(page.errors, []);
});

test("the lines under the pointer, and the lines being selected, are tinted until the composer closes", options, async () => {
  const { page } = await openViewer();
  const centerOf = (n) =>
    page.eval((line) => {
      const shadow = document.querySelector(".file-diff > *").shadowRoot;
      const r = (shadow.querySelector(`code[data-additions] [data-column-number="${line}"]`) ?? shadow.querySelector(`code[data-unified] [data-column-number="${line}"]`)).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, n);
  const tinted = (attribute) =>
    page.eval((attr) => {
      const rows = [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll(`code[data-additions] [data-line][${attr}]`)];
      return rows.map((row) => `${row.dataset.line}:${getComputedStyle(row).backgroundImage.startsWith("linear-gradient(rgba(0, 0, 0, 0)") ? "clear" : "tinted"}`);
    }, attribute);

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await centerOf(13)) });
  await page.waitFor(() => document.querySelector(".file-diff > *").shadowRoot.querySelector("[data-line][data-hovered]"), { what: "a hovered row" });
  assert.deepEqual(await tinted("data-hovered"), ["13:tinted"]);

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await centerOf(9)) });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...(await centerOf(9)), button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await centerOf(11)), button: "left", buttons: 1 });
  await page.waitFor(() => document.querySelector(".file-diff > *").shadowRoot.querySelectorAll("code[data-additions] [data-line][data-selected-line]").length === 3, {
    what: "three rows selected mid-drag",
  });
  assert.deepEqual(await tinted("data-selected-line"), ["9:tinted", "10:tinted", "11:tinted"]);
  const otherSide = await page.eval(() =>
    [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll("code[data-deletions] [data-line][data-selected-line]")].map((row) => {
      const style = getComputedStyle(row);
      return style.backgroundImage.startsWith("linear-gradient(rgba(0, 0, 0, 0)") && style.boxShadow === "none";
    }),
  );
  assert.ok(otherSide.length > 0, "Pierre marks the old side's rows of a split diff too");
  assert.ok(
    otherSide.every(Boolean),
    "but only the side being selected is tinted",
  );

  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...(await centerOf(11)), button: "left", clickCount: 1 });
  await page.waitFor(() => !document.querySelector("#composer").hidden, { what: "the composer" });
  assert.match(await page.eval(() => document.querySelector("#composer-where").textContent), /app\.js:9-11/);
  assert.equal((await tinted("data-selected-line")).length, 3, "the selection stays while the composer is open");
  await page.eval(() => document.querySelector("#composer-cancel").click());
  assert.deepEqual(await tinted("data-selected-line"), []);
});

test("an agent's reply shows up live, and resolving clears the line", options, async () => {
  const { page, home } = await openViewer();
  await commentOnLine11(page);
  const [{ id }] = await page.eval(railCards);
  const agentStore = await openStore(home);
  agentStore.reply(id, "To reuse compute().", { name: "agent", kind: "agent" });
  agentStore.close();
  await page.waitFor(() => document.querySelector("#rail .thread")?.innerText.includes("To reuse compute()"), { what: "the agent's reply" });
  assert.deepEqual(await page.eval(markedRows), ["11:turn"]);
  await page.eval(() => document.querySelector('#rail [data-action="resolved"]').click());
  await page.waitFor(() => !document.documentElement.classList.contains("rail-docked"), { what: "the rail to close" });
  assert.deepEqual(await page.eval(markedRows), []);
});

test("a batch stays hidden from agents until Send", options, async () => {
  const { page, home, started } = await openViewer();
  await clickLineNumber(page, 11);
  await page.waitFor(() => !document.querySelector("#composer").hidden);
  await typeAndPress(page, "Held back", "Enter", 1 /* Alt: start a batch */);
  await page.waitFor(() => !document.querySelector("#batch").hidden, { what: "the batch bar" });
  assert.equal(await page.eval(() => document.querySelector("#rail .thread").dataset.pending), "true");
  const agent = await openStore(home);
  assert.deepEqual(agent.waitingOnAgent({ repo: started.repo.commonDir }), []);
  await page.eval(() => document.querySelector("#batch-send").click());
  await page.waitFor(() => document.querySelector("#batch").hidden, { what: "the batch to send" });
  assert.equal(agent.waitingOnAgent({ repo: started.repo.commonDir }).length, 1);
  agent.close();
});

test("i moves threads inline under their lines, and back", options, async () => {
  const { page } = await openViewer();
  await commentOnLine11(page);
  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true })));
  await page.waitFor(() => document.querySelector(".inline-thread .thread"), { what: "an inline card" });
  assert.equal(await page.eval(() => document.documentElement.classList.contains("rail-docked")), false);
  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true })));
  await page.waitFor(() => document.querySelectorAll("#rail .thread").length === 1 && !document.querySelector(".inline-thread"), { what: "the card back in the rail" });
});

test("in a narrow window threads show inline, since the rail does not fit", options, async () => {
  const { page } = await openViewer({ width: 1000 });
  await clickLineNumber(page, 11);
  await page.waitFor(() => !document.querySelector("#composer").hidden);
  await typeAndPress(page, "Narrow");
  await page.waitFor(() => document.querySelector(".inline-thread .thread"), { what: "an inline card" });
  assert.equal(await page.eval(() => document.documentElement.classList.contains("rail-docked")), false);
});

test("marking a file viewed collapses it, and a commit that changes it clears the mark", options, async () => {
  const { page, repo } = await openViewer();
  await page.eval(() => document.querySelector(".file-diff > *").querySelector(".viewed input").click());
  await page.waitFor(() => document.querySelector("#tree .file-viewed"), { what: "the file list to mark it viewed" });
  assert.equal(await page.eval(() => !document.querySelector(".file-diff > *").shadowRoot.querySelector("[data-line]")), true, "collapsed");
  await page.waitFor(() => document.querySelector("#live").dataset.state === "on");
  repo.commit("edit app.js", { "src/app.js": lines(30, { 10: "const v10 = compute(10);", 20: "const v20 = 21;" }) });
  await page.waitFor(() => document.querySelector("#tree .file-changed"), { timeout: 10000, what: "the mark to show the file changed" });
  assert.match(await page.eval(() => document.querySelector(".file-diff > *").querySelector(".viewed").textContent), /Changed since viewed/);
});

test("v marks the whole branch viewed, and the stack shows which branches are viewed or changed since", options, async () => {
  const { page, repo } = await openViewer();
  const row = (branch) => `.stack-row[data-branch="${branch}"]`;
  await page.waitFor(() => document.querySelector("[data-branch-viewed]")?.textContent === "Mark branch viewed", { what: "the branch's viewed toggle" });
  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
  await page.waitFor(() => document.querySelector("[data-branch-viewed]")?.textContent === "✓ Branch viewed", { what: "the toggle to say viewed" });
  assert.equal(await page.eval(() => document.querySelectorAll("#tree .file-viewed").length), 2, "both files viewed");
  assert.equal(await page.eval(() => [...document.querySelectorAll(".file-diff > *")].every((f) => !f.shadowRoot.querySelector("[data-line]"))), true, "both collapsed");
  await page.waitFor((sel) => document.querySelector(sel)?.classList.contains("stack-viewed"), { what: "the stack to show feat/b viewed" }, row("feat/b"));
  assert.match(await page.eval((sel) => document.querySelector(`${sel} .stack-size`).textContent, row("feat/b")), /· ✓ viewed$/);
  assert.equal(await page.eval((sel) => document.querySelector(`${sel} .stack-size`).textContent.includes("viewed"), row("feat/a")), false);

  await page.waitFor(() => document.querySelector("#live").dataset.state === "on");
  repo.commit("triple", { "src/util.js": "export const compute = (x) => x * 3;\n" });
  await page.waitFor((sel) => document.querySelector(`${sel} .stack-size`)?.textContent.endsWith("· ↻ changed"), { timeout: 10000, what: "the stack to show feat/b changed" }, row("feat/b"));
  await page.waitFor(() => document.querySelector("[data-branch-viewed]")?.textContent === "Mark branch viewed", { what: "the toggle to offer marking it again" });

  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
  await page.waitFor(() => document.querySelector("[data-branch-viewed]")?.textContent === "✓ Branch viewed", { what: "v to mark it viewed again" });
  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
  await page.waitFor(() => !document.querySelector("#tree .file-viewed"), { what: "v again to clear every mark" });
  assert.deepEqual(page.errors, []);
});

test("the filter menu hides tests and generated files by default, filters by kind, what to hide and extension, and a comment brings a file into view", options, async () => {
  const repo = makeRepo();
  repo.write(".gitattributes", "docs/api.md linguist-generated\n");
  repo.commit("attributes", { ".gitattributes": "docs/api.md linguist-generated\n" });
  repo.git("checkout", "-q", "-b", "feat/a");
  repo.commit("a", { "src/app.js": "one\n", "src/app.test.js": "test one\ntest two\n", "docs/api.md": "generated\n" });
  await ensureVendorBundle();
  const started = await startServer({ dir: repo.dir, port: 4960, store: await openStore(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-kinds-"))) });
  servers.push(started);
  const page = await (await chrome()).open(`${started.url}view`, { width: 1700, height: 950 });
  const view = () =>
    page.eval(() => ({
      tree: [...document.querySelectorAll("#tree .file-name")].map((f) => f.textContent),
      diffs: [...document.querySelectorAll(".file-diff")].map((s) => s.dataset.path),
      head: document.querySelector(".branch-meta").textContent.replace(/\s+/g, " "),
      size: document.querySelector('.stack-row[data-branch="feat/a"] .stack-size')?.textContent,
      summary: document.querySelector("#hidden-summary").hidden ? null : document.querySelector("#hidden-summary-text").textContent,
    }));
  const menu = () =>
    page.eval(() =>
      document.querySelector("#filter-menu").hidden
        ? null
        : [...document.querySelectorAll("#filter-menu .menu-section")].map((s) =>
            [...s.querySelectorAll(".menu-item")].map((i) => `${i.textContent.trim()}${i.getAttribute("aria-checked") === "true" || i.querySelector("input")?.checked ? " ✓" : ""}`),
          ),
    );
  const click = (selector) => page.eval((sel) => document.querySelector(sel).click(), selector);
  await page.waitFor(() => document.querySelector(".file-diff") && document.querySelector(".branch-meta") && document.querySelector('.stack-row[data-branch="feat/a"] .stack-size .add'), {
    what: "the diff, its header and the stack's sizes",
  });
  let shown = await view();
  assert.deepEqual([shown.tree, shown.diffs, shown.size], [["app.js"], ["src/app.js"], "+1 −0"]);
  assert.match(shown.summary, /^2 files hidden: (tests, autogenerated|autogenerated, tests)$/);
  assert.match(shown.head, /1 file \+1 −0 \(2 hidden\)/);

  await click("#filter-btn");
  assert.deepEqual(await menu(), [
    ["All", "Code ✓", "Tests"],
    ["Viewed", "Deleted", "Autogenerated ✓"],
    [".js 2 ✓", ".md 1 ✓"],
  ]);
  await click('[data-filter-kind="all"]');
  shown = await view();
  assert.deepEqual([shown.diffs, shown.size, shown.summary], [["src/app.js", "src/app.test.js"], "+3 −0", "1 file hidden: autogenerated"]);
  assert.equal((await menu())[0][0], "All ✓", "the menu stays open, showing the choice");
  assert.equal(JSON.parse(await page.eval(() => localStorage.getItem("diffview.filters"))).kind, "all", "the choice is kept for the next visit");

  await click('[data-filter-ext=".js"]');
  shown = await view();
  assert.deepEqual(shown.diffs, [], "unchecking .js hides both .js files");
  assert.match(shown.head, /2 files \+3 −0 \(1 hidden\)/, "extensions hide files but leave the counts");
  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(await menu(), null, "Escape closes the menu");

  await click("#hidden-summary [data-reset-filters]");
  shown = await view();
  assert.deepEqual([shown.diffs.length, shown.summary], [3, null]);
  assert.match(shown.head, /3 files \+4 −0/);

  await click("#filter-btn");
  await click('[data-filter-kind="tests"]');
  shown = await view();
  assert.deepEqual([shown.diffs, shown.size], [["src/app.test.js"], "+2 −0"]);
  await click('[data-filter-kind="code"]');
  await click('[data-filter-hide="hideGenerated"]');
  await click("main");
  assert.equal(await menu(), null, "a click outside closes the menu");
  assert.deepEqual((await view()).diffs, ["src/app.js"]);
  const diff = await (await fetch(`${started.url}api/diff?branch=feat%2Fa`)).json();
  const origin = started.url.replace(/\/$/, "");
  const created = await fetch(`${origin}/api/comments`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ branch: "feat/a", sha: diff.sha, kind: "lines", path: "src/app.test.js", side: "new", startLine: 2, endLine: 2, body: "Why two?" }),
  });
  assert.equal(created.status, 201);
  await page.waitFor(() => document.querySelector('.file-diff[data-path="src/app.test.js"]'), { what: "the commented test file to come into view" });
  shown = await view();
  assert.match(shown.head, /1 file \+1 −0 \(2 hidden\)/, "shown for its comment, still not counted");
  assert.deepEqual(page.errors, []);
});

test("the agent's description shows above the diff, and selected text in it takes a comment", options, async () => {
  const { page, home, started } = await openViewer();
  assert.match(await page.eval(() => document.querySelector("#description").innerText), /No description yet/);
  const agent = await openStore(home);
  const body = "## Why\n\nCallers repeat the doubling logic.\n\n## How\n\n- Add `compute()` in util.js.\n";
  const file = descriptionFile(`---\ntitle: Share compute()\n---\n${body}`);
  agent.linkDescription(started.repo.commonDir, "feat/b", file, { name: "agent", kind: "agent" });
  await page.waitFor(() => document.querySelector(".description-title")?.textContent === "Share compute()", { what: "the description to arrive live" });

  await page.eval(() => {
    const paragraph = document.querySelector('#description-body [data-block="1"]');
    const text = paragraph.firstChild;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf("repeat"));
    range.setEnd(text, text.data.indexOf("repeat") + "repeat the doubling".length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitFor(() => !document.querySelector("#comment-btn").hidden, { what: "the Comment button" });
  await page.eval(() => document.querySelector("#comment-btn").click());
  await page.waitFor(() => !document.querySelector("#composer").hidden);
  assert.match(await page.eval(() => document.querySelector("#composer-where").textContent), /repeat the doubling/);
  await typeAndPress(page, "Which callers?");
  await page.waitFor(() => document.querySelector("#rail .thread"), { what: "the card" });
  const offset = await page.eval(() => {
    const block = document.querySelector('#description-body [data-block="1"]');
    return Math.abs(document.querySelector("#rail .thread").getBoundingClientRect().top - block.getBoundingClientRect().top);
  });
  assert.ok(offset < 6, `the card sits ${offset}px from its paragraph`);
  assert.equal(await page.eval(() => CSS.highlights.get("dv-description-open")?.size), 1);

  const [{ id }] = await page.eval(railCards);
  assert.equal(agent.thread(id).thread.quote, "repeat the doubling");
  agent.close();
  fs.writeFileSync(file, `---\ntitle: Share compute()\n---\n${body.replace("Callers repeat the doubling logic.", "Two callers repeat the doubling logic.")}`);
  await page.waitFor(() => document.querySelector("#description-body")?.textContent.includes("Two callers"), { what: "the edited file to reach the page" });
  await page.waitFor(() => !document.documentElement.classList.contains("rail-docked"), { what: "the outdated thread to leave the margin" });
  assert.equal(await page.eval(() => CSS.highlights.get("dv-description-open")?.size ?? 0), 0);
});

test("the overview shows the stack's description and its branches, and its text takes comments", options, async () => {
  const { page, home, started } = await openViewer();
  const repo = started.repo.commonDir;
  const agent = await openStore(home);
  const AGENT = { name: "agent", kind: "agent" };
  agent.linkDescription(repo, "feat/a", descriptionFile("---\ntitle: Thirty lines\n---\nLines for `compute()` to change.\n\n## More\n\nNot in the summary.\n"), AGENT);

  await page.eval(() => document.querySelector(".overview-row").click());
  await page.waitFor(() => document.querySelectorAll(".overview-branch").length === 2, { what: "the overview's branches" });
  assert.match(await page.eval(() => location.search), /overview/);
  assert.match(await page.eval(() => document.querySelector("#description").innerText), /No stack description yet/);
  assert.deepEqual(
    await page.eval(() => [...document.querySelectorAll(".overview-branch")].map((b) => [b.querySelector("a").textContent, b.querySelector(".overview-summary").innerHTML])),
    [
      ["feat/b", "No description yet."],
      ["Thirty lines", "Lines for <code>compute()</code> to change."],
    ],
    "top branch first, as the sidebar lists them",
  );

  agent.linkStackDescription(repo, ["feat/a", "feat/b"], descriptionFile("---\ntitle: Double with compute()\n---\n## Why\n\nTwo steps keep each review small.\n"), AGENT);
  await page.waitFor(() => document.querySelector(".description-title")?.textContent === "Double with compute()", { what: "the stack description to arrive live" });
  await page.eval(() => {
    const text = document.querySelector('#description-body [data-block="1"]').firstChild;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf("each review"));
    range.setEnd(text, text.data.indexOf("each review") + "each review".length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.waitFor(() => !document.querySelector("#comment-btn").hidden, { what: "the Comment button" });
  await page.eval(() => document.querySelector("#comment-btn").click());
  await page.waitFor(() => !document.querySelector("#composer").hidden);
  assert.match(await page.eval(() => document.querySelector("#composer-where").textContent), /the stack description: “each review”/);
  await typeAndPress(page, "How small?");
  await page.waitFor(() => document.querySelector("#rail .thread"), { what: "the card" });
  const [{ id }] = await page.eval(railCards);
  assert.deepEqual([agent.reviewOf(id).entry, agent.thread(id).thread.quote], ["stack:feat/a", "each review"]);
  await page.waitFor(() => document.querySelector(".overview-row .badge-comments")?.textContent === "1", { what: "the overview row's comment badge" });
  agent.close();

  await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true })));
  await page.waitFor(() => document.querySelector(".file-diff"), { what: "[ to move to the top branch" });
  assert.equal(await page.eval(() => document.querySelector("#branch-name").textContent), "feat/b");
  assert.deepEqual(page.errors, []);
});

test("a comment survives a commit elsewhere in the file, and goes outdated when one changes its line", options, async () => {
  const { page, repo } = await openViewer();
  await commentOnLine11(page);
  await page.waitFor(() => document.querySelector("#live").dataset.state === "on");
  repo.commit("edit elsewhere", { "src/app.js": lines(30, { 2: "const v2 = 'two';", 10: "const v10 = compute(10);" }) });
  await page.waitFor(() => document.querySelector("#version")?.textContent === "v2", { timeout: 10000, what: "v2" });
  assert.deepEqual(await page.eval(markedRows), ["11:open"]);
  assert.match((await page.eval(railCards))[0].text, /from v1/);
  repo.commit("edit the line", { "src/app.js": lines(30, { 10: "const v10 = compute(10) + 1;" }) });
  await page.waitFor(() => document.querySelector("#version")?.textContent === "v3", { timeout: 10000, what: "v3" });
  await page.waitFor(() => !document.documentElement.classList.contains("rail-docked") || document.querySelector("#rail .rail-head")?.innerText.includes("older"), { what: "the thread to leave the margin" });
  assert.deepEqual(await page.eval(markedRows), []);
  await page.eval(() => document.querySelector("#comments-btn").click());
  await page.waitFor(() => document.querySelector("#rail.listing .chip-outdated"), { what: "the outdated chip in the list" });
  assert.match(await page.eval(() => document.querySelector("#rail .now-reads").innerText), /Now reads: const v10 = compute\(10\) \+ 1;/);
});
