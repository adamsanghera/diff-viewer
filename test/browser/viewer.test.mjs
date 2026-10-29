import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../../lib/server.mjs";
import { ensureVendorBundle } from "../../lib/vendor.mjs";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { makeRepo } from "../helpers/repo.mjs";

const chrome = sharedChrome();
const servers = [];
after(() => Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve)))));

/** feat/a <- feat/b on main, b checked out and changing a two-line file. */
async function openViewer() {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "feat/a");
  repo.commit("a", { "src/app.js": "const a = 1;\nconst b = 2;\n" });
  repo.git("checkout", "-q", "-b", "feat/b");
  repo.commit("b", { "src/app.js": "const a = 1;\nconst b = 3;\n" });
  await ensureVendorBundle();
  const started = await startServer({ dir: repo.dir, port: 4950 });
  servers.push(started);
  const page = await (await chrome()).open(`${started.url}view`);
  await page.waitFor(() => document.querySelector(".file-diff > *")?.shadowRoot?.querySelector("[data-line]"), { what: "a rendered diff" });
  return { repo, page };
}

const options = { skip: chromeMissing };

test("the page shows the stack, the branch's files, and its diff", options, async () => {
  const { page } = await openViewer();
  const view = await page.eval(() => ({
    stack: [...document.querySelectorAll("#stack .stack-row .name")].map((el) => el.textContent),
    active: document.querySelector(".stack-row.active .name")?.textContent,
    prefix: document.querySelector("#stack-meta").textContent,
    files: [...document.querySelectorAll("#tree .file-name")].map((el) => el.textContent),
    removed: [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll('[data-line-type="change-deletion"]')].map((el) => el.textContent),
  }));
  assert.deepEqual(view.stack, ["Overview", "b", "a", "main"]);
  const line = await page.eval(() =>
    [...document.querySelectorAll("#stack .stack-row")].map((row) => {
      const { content, top, bottom } = getComputedStyle(row, "::before");
      const half = `${row.getBoundingClientRect().height / 2}px`;
      return content === "none" ? "none" : `${top === half ? "mid" : "edge"}-${bottom === half ? "mid" : "edge"}`;
    }),
  );
  assert.deepEqual(line, ["none", "mid-edge", "edge-edge", "edge-mid"], "a line runs from the top branch's dot down to trunk's");
  await page.waitFor(() => document.querySelector("#stack .stack-size .add"), { what: "each branch's size" });
  assert.deepEqual(
    await page.eval(() => [...document.querySelectorAll("#stack .stack-size")].map((s) => s.textContent)),
    ["+1 −1", "+2 −0"],
    "b changes one line of app.js; a adds its two",
  );
  assert.equal(view.active, "b");
  assert.match(view.prefix, /^feat\//);
  assert.deepEqual(view.files, ["app.js"]);
  assert.ok(view.removed.some((text) => text.includes("const b = 2;")), JSON.stringify(view.removed));
  assert.deepEqual(page.errors, []);
});

test("a branch's dot grows with its changed lines and stays centered on the stack's line", options, async () => {
  const { repo, page } = await openViewer();
  await page.waitFor(() => document.querySelector("#live").dataset.state === "on", { what: "live reload to connect" });
  repo.commit("big", { "src/big.js": Array.from({ length: 40 }, (_, i) => `export const n${i} = ${i};\n`).join("") });
  await page.waitFor(() => document.querySelector('.stack-row[data-branch="feat/b"] .stack-size')?.textContent.startsWith("+41"), {
    timeout: 10000,
    what: "b's new size",
  });
  const dots = await page.eval(() =>
    Object.fromEntries(
      [...document.querySelectorAll("#stack .stack-row:has(.dot)")].map((row) => {
        const dot = row.querySelector(".dot").getBoundingClientRect();
        const line = getComputedStyle(row, "::before");
        const lineCenter = row.getBoundingClientRect().left + parseFloat(line.left) + parseFloat(line.width) / 2;
        return [row.querySelector(".name").textContent, { width: dot.width, offCenter: dot.left + dot.width / 2 - lineCenter }];
      }),
    ),
  );
  assert.ok(dots.b.width > dots.a.width, JSON.stringify(dots));
  assert.deepEqual(Object.values(dots).map((d) => d.offCenter), [0, 0, 0], JSON.stringify(dots));
});

test("clicking a branch shows its diff, and Unified switches to one column", options, async () => {
  const { page } = await openViewer();
  await page.eval(() => document.querySelector('.stack-row[data-branch="feat/a"]').click());
  await page.waitFor(() => document.querySelector("#branch-name").textContent === "feat/a");
  assert.match(await page.eval(() => location.search), /branch=feat%2Fa/);
  await page.eval(() => document.querySelector('[data-layout="unified"]').click());
  await page.waitFor(() => document.querySelector(".file-diff > *").shadowRoot.querySelector("[data-diff-type]")?.dataset.diffType === "single", {
    what: "one column",
  });
  assert.deepEqual(page.errors, []);
});

test("s shows and hides the stack and f the files, each on its own; with both hidden the sidebar goes", options, async () => {
  const { page } = await openViewer();
  const press = (key) => page.eval((k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })), key);
  const shown = () =>
    page.eval(() => ["#stack-panel", "#files-panel", ".sidebar"].map((sel) => getComputedStyle(document.querySelector(sel)).display !== "none"));
  const layout = () => page.eval(() => document.querySelector('[data-layout][aria-pressed="true"]').dataset.layout);
  const before = await layout();
  assert.deepEqual(await shown(), [true, true, true]);
  await press("s");
  assert.deepEqual(await shown(), [false, true, true]);
  assert.equal(await layout(), before, "s no longer changes the diff layout");
  await press("f");
  assert.deepEqual(await shown(), [false, false, false]);
  await press("s");
  assert.deepEqual(await shown(), [true, false, true]);
  assert.equal(await page.eval(() => localStorage.getItem("diffview.panel.files")), "hidden", "the choice is kept for the next visit");
  await press("f");
  assert.deepEqual(await shown(), [true, true, true]);
});

test("long lines wrap instead of scrolling sideways", options, async () => {
  const { repo, page } = await openViewer();
  repo.commit("long", { "src/app.js": `const a = 1;\nconst b = "${"x".repeat(600)}";\n` });
  await page.waitFor(() => document.querySelector(".file-diff > *")?.shadowRoot?.textContent.includes("x".repeat(600)), { timeout: 10000, what: "the long line" });
  const overflow = await page.eval(() =>
    [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll("pre, code")].map((el) => el.scrollWidth - el.clientWidth).filter((extra) => extra > 1),
  );
  assert.deepEqual(overflow, [], "no part of the diff is wider than it shows");
  const rows = await page.eval(() => {
    const line = [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll("code[data-additions] [data-line]")].find((l) => l.textContent.includes("xxx"));
    return Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight));
  });
  assert.ok(rows > 1, `the long line wraps onto ${rows} rows`);
});

test("Auto shows split diffs in a wide window and one column in a narrow one", options, async () => {
  const { page } = await openViewer();
  // Pierre marks its <pre> "split" or, for one column, "single".
  const diffTypeIs = (type) => document.querySelector(".file-diff > *").shadowRoot.querySelector("[data-diff-type]")?.dataset.diffType === type;
  assert.equal(await page.eval(() => document.querySelector('[data-layout="auto"]').getAttribute("aria-pressed")), "true");
  await page.waitFor(diffTypeIs, { what: "split in a wide window" }, "split");
  await page.resize(900, 900);
  await page.waitFor(diffTypeIs, { what: "one column in a narrow window" }, "single");
});

test("with ?perf, a load reports its requests' server and git time, and its render time", options, async () => {
  const { page } = await openViewer();
  await page.goto(`${await page.eval(() => location.origin)}/view?perf`);
  const load = await page.waitFor(() => globalThis.diffviewPerf?.loads[0], { what: "a load report" });
  const diff = load.rows.find((r) => r.request === "/api/diff");
  assert.ok(diff && diff.gitMs > 0 && diff.serverMs > 0, JSON.stringify(load.rows));
  assert.ok(load.rows.some((r) => r.request === "render files"), JSON.stringify(load.rows));
  assert.ok(load.totalMs > 0);
});

test("a commit shows up without a reload, and an uncommitted edit never does", options, async () => {
  const { repo, page } = await openViewer();
  await page.waitFor(() => document.querySelector("#live").dataset.state === "on", { what: "live reload to connect" });
  const added = () =>
    page.eval(() => [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll('[data-line-type="change-addition"]')].map((el) => el.textContent).join("\n"));
  repo.write("src/app.js", "const a = 1;\nconst b = 4;\n");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(await added(), /const b = 3;/, "the edit on disk does not show");
  repo.commit("four");
  await page.waitFor(() => document.querySelector(".file-diff > *")?.shadowRoot?.textContent.includes("const b = 4;"), { timeout: 10000, what: "the commit" });
  assert.match(await added(), /const b = 4;/);
});
