import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { branchDiff } from "../lib/branch-diff.mjs";
import { openRepo } from "../lib/repo.mjs";
import { loadStack } from "../lib/stack.mjs";
import { openStore, STACK_SNAPSHOT } from "../lib/store.mjs";
import { until } from "./helpers/browser.mjs";
import { makeRepo } from "./helpers/repo.mjs";

const BIN = fileURLToPath(new URL("../bin/diffview.mjs", import.meta.url));
const HUMAN = { name: "adam", kind: "human" };

/** main <- feat/a <- feat/b, b checked out; and a store home of its own. */
function setup() {
  const repo = makeRepo();
  repo.git("checkout", "-q", "-b", "feat/a");
  repo.commit("a", { "src/app.js": "const a = 1;\nconst b = 2;\nconst c = a + b;\n" });
  repo.git("checkout", "-q", "-b", "feat/b");
  repo.commit("b", { "src/app.js": "const a = 1;\nconst b = 2;\nconst c = add(a, b);\n", "src/add.js": "export const add = (x, y) => x + y;\n" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-cli-"));
  const env = { ...process.env, DIFFVIEW_HOME: home, DIFFVIEW_USER: "adam", DIFFVIEW_AUTHOR: "spec-agent" };
  delete env.DIFFVIEW_SESSION;
  const cli = (...args) => {
    const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", ...args], { cwd: repo.dir, env, encoding: "utf8" });
    return { status: res.status, out: res.stdout, err: res.stderr };
  };
  const cliWithStdin = (input, ...args) => {
    const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", ...args], { cwd: repo.dir, env, encoding: "utf8", input });
    return { status: res.status, out: res.stdout, err: res.stderr };
  };
  const cliInBackground = (...args) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", ...args], { cwd: repo.dir, env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    return { output: () => out, done: new Promise((resolve) => child.on("close", (status) => resolve({ status, out }))) };
  };
  return { repo, home, cli, cliWithStdin, cliInBackground };
}

/** Leaves a comment as the human would in the viewer: on what the branch's diff shows now. */
async function humanComment({ repo, home }, { entry, path: file, startLine, endLine = startLine, body, pending = false }) {
  const opened = await openRepo(repo.dir);
  const stack = await loadStack(opened, { entry });
  const e = stack.entries.find((x) => x.id === entry);
  const workingTree = entry === opened.branch;
  const { patch } = await branchDiff(opened, e, { workingTree });
  const store = await openStore(home);
  try {
    return store.createThread({
      repo: opened.commonDir,
      entry,
      snapshot: { base: e.base, head: e.head, workingTree, patch },
      kind: "lines",
      path: file,
      side: "new",
      startLine,
      endLine,
      body,
      author: HUMAN,
      pending,
    });
  } finally {
    store.close();
  }
}

test("with no comments, list says so", () => {
  const { cli } = setup();
  const res = cli("list");
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /No unresolved comments in scope/);
});

test("a human comment shows in list and show, with the lines around it and how to change it", async () => {
  const ctx = setup();
  const id = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "Inline add() instead?" });
  const list = ctx.cli("list", "--waiting-on", "agent");
  assert.equal(list.status, 0, list.err);
  assert.match(list.out, /^feat\/b · v1 · 1 open/m);
  assert.match(list.out, new RegExp(`#${id} open · waiting on agent · src/app.js line 3`));
  assert.match(list.out, /adam \(\d\d:\d\d, v1\): Inline add\(\) instead\?/);
  const show = ctx.cli("show", String(id));
  assert.match(show.out, /on branch feat\/b \(git stack\)/);
  assert.match(show.out, />\s+3 \+const c = add\(a, b\);/);
  assert.match(show.out, /To change it: git checkout feat\/b/);
});

test("reply and suggest-resolve hand the turn back, and only a human resolves", async () => {
  const ctx = setup();
  const id = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "Why?" });
  assert.match(ctx.cli("reply", String(id), "-m", "To reuse it.").out, /waiting on human/);
  assert.equal(ctx.cli("list", "--waiting-on", "agent").out.trim(), "Nothing is waiting on the agent.");
  const refused = ctx.cli("resolve", String(id));
  assert.equal(refused.status, 1);
  assert.match(refused.err, /Only a human/);
  assert.match(ctx.cli("suggest-resolve", String(id), "-m", "Kept add().").out, /suggested resolved · waiting on human/);
  assert.equal(ctx.cli("resolve", String(id), "--human").status, 0);
  assert.match(ctx.cli("list").out, /No unresolved comments/);
  assert.match(ctx.cli("list", "--all").out, /resolved/);
});

test("apply answers a batch from stdin, all or nothing", async () => {
  const ctx = setup();
  const one = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "One" });
  const two = await humanComment(ctx, { entry: "feat/a", path: "src/app.js", startLine: 1, body: "Two" });
  const bad = ctx.cliWithStdin(JSON.stringify([{ reply: one, message: "ok" }, { reply: 999, message: "?" }]), "apply", "--stdin");
  assert.equal(bad.status, 1);
  assert.match(ctx.cli("list", "--waiting-on", "agent").out, new RegExp(`#${one}`), "the failed batch changed nothing");
  const good = ctx.cliWithStdin(JSON.stringify([{ reply: one, message: "Done." }, { suggestResolve: two, message: "Fixed." }]), "apply", "--stdin");
  assert.equal(good.status, 0, good.err);
  assert.match(good.out, /Applied 2 actions/);
  assert.equal(ctx.cli("list", "--waiting-on", "agent").out.trim(), "Nothing is waiting on the agent.");
});

test("messages and batches come from files, or stdin with --from -", async () => {
  const ctx = setup();
  const one = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "One" });
  const two = await humanComment(ctx, { entry: "feat/a", path: "src/app.js", startLine: 1, body: "Two" });
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), "diffview-notes-"));
  const reply = path.join(notes, "reply.md");
  fs.writeFileSync(reply, "Because:\n\n```js\nconst c = add(a, b);\n```\n");
  assert.equal(ctx.cli("reply", String(one), "--from", reply).status, 0);
  assert.match(ctx.cli("show", String(one)).out, /```js\n {4}const c = add\(a, b\);\n {4}```/);
  assert.equal(ctx.cliWithStdin("Fixed in add().\n", "suggest-resolve", String(two), "-F", "-").status, 0);
  assert.match(ctx.cli("show", String(two)).out, /Fixed in add\(\)\./);

  const actions = path.join(notes, "actions.json");
  fs.writeFileSync(actions, JSON.stringify([{ reply: one, message: "And another thing." }]));
  assert.match(ctx.cli("apply", "--from", actions).out, /Applied 1 action/);

  assert.match(ctx.cli("reply", String(one), "-m", "x", "--from", reply).err, /give -m or --from, not both/);
  assert.match(ctx.cli("reply", String(one), "--from", path.join(notes, "nope.md")).err, /cannot read .*nope\.md: no such file/);
  assert.match(ctx.cli("apply").err, /--from <actions\.json>, or --stdin/);
});

test("a mistyped verb gets a guess, not the whole help", () => {
  const { cli } = setup();
  const typo = cli("lst");
  assert.equal(typo.status, 2);
  assert.equal(typo.err, 'diffview comments: unknown verb "lst"; did you mean "list"? Verbs: list, show, reply, suggest-resolve, apply, resolve, reopen, add, wait.\n');
  assert.match(cli("suggest").err, /did you mean "suggest-resolve"\?/);
  assert.doesNotMatch(cli("frobnicate").err, /did you mean/);
  assert.match(cli("list", "--nope").err, /^diffview comments: Unknown option '--nope'.*See diffview comments --help\.\n$/);
});

test("an agent without DIFFVIEW_AUTHOR is named for its session", async () => {
  const ctx = setup();
  const id = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "Who?" });
  const env = { ...process.env, DIFFVIEW_HOME: ctx.home, CURSOR_CONVERSATION_ID: "940d8cee-dac1-4aae" };
  delete env.DIFFVIEW_AUTHOR;
  delete env.DIFFVIEW_SESSION;
  const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", "reply", String(id), "-m", "Me."], { cwd: ctx.repo.dir, env, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(ctx.cli("show", String(id)).out, /agent 940d8cee · /);
});

test("add starts a thread on lines, a file, or the whole branch", () => {
  const { cli } = setup();
  assert.match(cli("add", "--file", "src/add.js", "--line", "1", "-m", "Is this exported on purpose?").out, /Started thread #\d+ on src\/add\.js line 1 of feat\/b/);
  assert.match(cli("add", "--file", "src/add.js", "-m", "New file?").out, /the whole file src\/add\.js/);
  assert.match(cli("add", "--whole-branch", "--branch", "feat/a", "-m", "Merge first?").out, /the whole branch of feat\/a/);
  const refused = cli("add", "--file", "src/app.js", "--line", "1-9", "-m", "x");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /not shown together/);
});

test("an edit to the commented line makes the thread outdated, with what it now reads", async () => {
  const ctx = setup();
  const id = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "Rename c?" });
  ctx.repo.write("src/app.js", "const a = 1;\nconst b = 2;\nconst sum = add(a, b);\n");
  const show = ctx.cli("show", String(id));
  assert.match(show.out, /outdated: made on v1, its lines changed since \(were src\/app\.js line 3\)/);
  assert.match(show.out, /Now reads, in v2, src\/app\.js line 3:\n {4}const sum = add\(a, b\);/);
});

test("wait returns at once when something waits, wakes on a new comment, and times out with exit 3", async () => {
  const ctx = setup();
  const timedOut = ctx.cli("wait", "--timeout", "1s");
  assert.equal(timedOut.status, 3);
  const waiting = ctx.cliInBackground("wait", "--timeout", "20s");
  await until(() => waiting.output().includes("waiting for comments"), { what: "wait to start" });
  const started = Date.now();
  const id = await humanComment(ctx, { entry: "feat/a", path: "src/app.js", startLine: 2, body: "Woken?" });
  const { status, out } = await waiting.done;
  assert.equal(status, 0, out);
  assert.match(out, new RegExp(`#${id} open · waiting on agent`));
  assert.ok(Date.now() - started < 2000, `woke after ${Date.now() - started} ms`);
  assert.equal(ctx.cli("wait", "--timeout", "1s").status, 0, "a thread still waiting returns at once");
});

test("a pending comment wakes nobody until the batch is sent", async () => {
  const ctx = setup();
  await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "Draft", pending: true });
  assert.equal(ctx.cli("wait", "--timeout", "1s").status, 3);
});

/** Runs `diffview describe` in the fixture repo. */
function describe(ctx, ...args) {
  const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "describe", ...args], {
    cwd: ctx.repo.dir,
    env: { ...process.env, DIFFVIEW_HOME: ctx.home, DIFFVIEW_AUTHOR: "spec-agent" },
    encoding: "utf8",
  });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

/** Writes a description file outside the fixture repo and returns its path. */
function descriptionFile(ctx, name, text) {
  const file = path.join(ctx.home, "notes", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test("describe links a file as a branch's description, and prints it as the file reads now", () => {
  const ctx = setup();
  assert.match(describe(ctx).err, /feat\/b has no description\. Link a Markdown file with: diffview describe <file>/);
  const file = descriptionFile(ctx, "b.md", "---\ntitle: Use add()\n---\n## Why\n\nAdd add().\n");
  assert.equal(describe(ctx, file).out, `Linked ${file} as the description of feat/b.\n`);
  assert.match(describe(ctx).out, new RegExp(`^${file} · edited \\d\\d:\\d\\d\\n\\n# Use add\\(\\)\\n\\n## Why\\n\\nAdd add\\(\\)\\.\\n$`));
  assert.equal(describe(ctx, "--print").out, "## Why\n\nAdd add().\n");
  assert.equal(describe(ctx, "--print-title").out, "Use add()\n");
  assert.equal(describe(ctx, "--path").out, `${file}\n`);

  fs.writeFileSync(file, "---\ntitle: Use add() everywhere\n---\n## Why\n\nAdd add().\n");
  assert.equal(describe(ctx, "--print-title").out, "Use add() everywhere\n", "an edit to the file is the description");
  fs.rmSync(file);
  assert.match(describe(ctx, "--print").err, /the description file of feat\/b is missing: .*b\.md \(no file there\)/);
  assert.equal(describe(ctx, "--print").status, 1);

  assert.equal(describe(ctx, "nope.md").status, 2);
  assert.equal(describe(ctx, "--branch", "nope").status, 2);
});

test("describe warns when the file would show in the checked-out branch's diff", () => {
  const ctx = setup();
  ctx.repo.write("notes.md", "In the worktree, untracked.\n");
  assert.match(describe(ctx, "notes.md").err, /notes\.md is untracked in the worktree, so it shows in the checked-out branch's diff/);
  ctx.repo.write(".gitignore", ".notes/\n");
  ctx.repo.write(".notes/b.md", "In a gitignored folder.\n");
  const linked = describe(ctx, ".notes/b.md");
  assert.equal(linked.err, "");
  assert.equal(linked.status, 0);
});

test("a comment on the description shows in list and show with its paragraph", async () => {
  const ctx = setup();
  const file = descriptionFile(ctx, "b.md", "## Why\n\nAdd add() so callers share it.\n");
  describe(ctx, file);
  const opened = await openRepo(ctx.repo.dir);
  const stack = await loadStack(opened, { entry: "feat/b" });
  const entry = stack.entries.find((e) => e.id === "feat/b");
  const { patch } = await branchDiff(opened, entry, { workingTree: true });
  const store = await openStore(ctx.home);
  const id = store.createThread({
    repo: opened.commonDir,
    entry: "feat/b",
    snapshot: { base: entry.base, head: entry.head, workingTree: true, patch },
    kind: "description",
    descriptionSha: store.description(opened.commonDir, "feat/b").sha256,
    quote: "callers share it",
    body: "Which callers?",
    author: HUMAN,
  });
  store.close();
  assert.match(ctx.cli("list").out, new RegExp(`#${id} open · waiting on agent · the description under "Why"`));
  const show = ctx.cli("show", String(id));
  assert.match(show.out, /In the description:\n {4}Add add\(\) so callers share it\./);
  assert.match(show.out, new RegExp(`To change it: edit ${file}\\.`));
});

test("describe --stack links the stack's description, readable from any of its branches", () => {
  const ctx = setup();
  assert.match(describe(ctx, "--stack").err, /the stack of feat\/b has no description\. Link a Markdown file with: diffview describe --stack <file>/);
  const file = descriptionFile(ctx, "stack.md", "---\ntitle: add()\n---\nShip add() in two steps.\n");
  assert.equal(describe(ctx, "--stack", file).out, `Linked ${file} as the description of the stack of feat/b.\n`);
  assert.match(describe(ctx, "--stack", "--branch", "feat/a").out, /\n\n# add\(\)\n\nShip add\(\) in two steps\.\n$/);
  assert.equal(describe(ctx, "--stack", "--print").out, "Ship add() in two steps.\n");
  assert.equal(JSON.parse(describe(ctx, "--stack", "--json").out).entry, "stack:feat/a");
  assert.equal(describe(ctx, "--print").status, 1, "the branch's own description is separate");
});

test("a comment on the stack's description shows in list and show, with how to change it", async () => {
  const ctx = setup();
  const file = descriptionFile(ctx, "stack.md", "## Why\n\nShip add() in two steps.\n");
  describe(ctx, "--stack", file);
  const opened = await openRepo(ctx.repo.dir);
  const store = await openStore(ctx.home);
  const { sha256 } = store.description(opened.commonDir, "stack:feat/a");
  const id = store.createThread({
    repo: opened.commonDir,
    entry: "stack:feat/a",
    snapshot: STACK_SNAPSHOT,
    kind: "description",
    descriptionSha: sha256,
    quote: "two steps",
    body: "Why two?",
    author: HUMAN,
  });
  store.close();
  const list = ctx.cli("list").out;
  assert.match(list, /^the stack · 1 open\n/m);
  assert.match(list, new RegExp(`#${id} open · waiting on agent · the stack description under "Why"`));
  const show = ctx.cli("show", String(id)).out;
  assert.match(show, /· on the stack\n/);
  assert.match(show, new RegExp(`To change it: edit ${file}\\.`));
  assert.match(ctx.cli("suggest-resolve", String(id), "-m", "Explained in the Why.").out, /the stack description under "Why"/);
});

test("a second diffview on the same checkout prints the running viewer's link instead of starting another", async (t) => {
  const ctx = setup();
  const env = { ...process.env, DIFFVIEW_HOME: ctx.home };
  const viewer = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "--no-open", "--port", "4960", "-b", "feat/a"], { cwd: ctx.repo.dir, env });
  t.after(() => viewer.kill());
  let out = "";
  viewer.stdout.on("data", (chunk) => (out += chunk));
  await until(() => out.includes("http://"), { what: "the first viewer's link" });
  assert.match(out, /http:\/\/127\.0\.0\.1:4960\/view\?branch=feat%2Fa/);

  const second = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "--no-open", "-b", "feat/b"], { cwd: ctx.repo.dir, env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const link = second.stdout.match(/http:\S+/)?.[0];
  assert.equal(link, "http://127.0.0.1:4960/view?branch=feat%2Fb");
  assert.match(second.stdout, /already serving/);
  assert.equal((await fetch(link)).status, 200);
});

test("no verb changes the repo", async () => {
  const ctx = setup();
  const snapshot = () => [ctx.repo.git("for-each-ref"), ctx.repo.git("status", "--porcelain"), fs.readFileSync(path.join(ctx.repo.commonDir(), "config"), "utf8")];
  const before = snapshot();
  const id = await humanComment(ctx, { entry: "feat/b", path: "src/app.js", startLine: 3, body: "x" });
  ctx.cli("list", "--full");
  ctx.cli("show", String(id));
  ctx.cli("reply", String(id), "-m", "y");
  ctx.cli("add", "--whole-branch", "-m", "z");
  assert.deepEqual(snapshot(), before);
});
