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
  assert.equal(view.active, "b");
  assert.match(view.prefix, /^feat\//);
  assert.deepEqual(view.files, ["app.js"]);
  assert.ok(view.removed.some((text) => text.includes("const b = 2;")), JSON.stringify(view.removed));
  assert.deepEqual(page.errors, []);
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

test("f shows and hides the sidebar", options, async () => {
  const { page } = await openViewer();
  const hidden = () => document.documentElement.classList.contains("no-sidebar");
  const pressF = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
  await page.eval(pressF);
  assert.equal(await page.eval(hidden), true);
  await page.eval(pressF);
  assert.equal(await page.eval(hidden), false);
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

test("an edit in the working tree shows up without a reload", options, async () => {
  const { repo, page } = await openViewer();
  await page.waitFor(() => document.querySelector("#live").dataset.state === "on", { what: "live reload to connect" });
  repo.write("src/app.js", "const a = 1;\nconst b = 4;\n");
  await page.waitFor(() => document.querySelector("#branch-head").textContent.includes("uncommitted"), { timeout: 10000, what: "the uncommitted edit" });
  const added = await page.eval(() =>
    [...document.querySelector(".file-diff > *").shadowRoot.querySelectorAll('[data-line-type="change-addition"]')].map((el) => el.textContent),
  );
  assert.ok(added.some((text) => text.includes("const b = 4;")), JSON.stringify(added));
});
