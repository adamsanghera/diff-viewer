/**
 * `diffview comments <verb>`: how agents read and answer comments, and how
 * a human at a terminal resolves them. It writes the store directly, so it
 * works with no viewer running.
 *
 * Its scope is a repo's stack: by default, the stack of the branch checked
 * out where it runs, so an agent in a worktree needs no arguments. Before
 * reading, it records the current diff of every commented branch in scope,
 * so states reflect the code as it is now.
 */
import http from "node:http";
import { parseArgs } from "node:util";
import { branchDiff } from "./branch-diff.mjs";
import { authorFrom, readStdin, UsageError, when } from "./cli.mjs";
import { liveServers } from "./registry.mjs";
import { openRepo } from "./repo.mjs";
import { loadStack, StackError } from "./stack.mjs";
import { isStackEntry, openStore, STATUS_LABELS, StoreError, storeHome } from "./store.mjs";

const USAGE = `Usage: diffview comments <verb> [options]

Reads and answers comments left on branch diffs in diffview. Agents reply and
suggest resolving. Only a human resolves or reopens a thread.

Verbs:
  list [--all] [--waiting-on agent|human] [--full]
                                    Unresolved threads in scope, by branch. --all adds resolved
                                    threads, --waiting-on keeps the threads whose turn it is, and
                                    --full prints each one like show.
  show <id>...                      Threads in full: branch, file, the lines around them, messages
  reply <id> -m <text>              Add a message
  suggest-resolve <id> -m <text>    Say a thread is done, and what changed
  apply --stdin                     Apply a JSON list of replies and suggest-resolves in one go:
                                    [{"reply": 7, "message": "..."}, {"suggestResolve": 8, "message": "..."}]
  resolve <id> --human [-m <text>]  Resolve a thread
  reopen <id> --human [-m <text>]   Reopen a thread
  add --file <path> [--line <n>[-<m>]] [--side old] -m <text>
  add --whole-branch -m <text>      Start a thread on lines, a whole file, or the whole branch
  wait [--timeout 30m]              Return as soon as anything in scope waits on the agent, printing
                                    it in full. Answer every such thread before waiting again.

Scope (list, add, wait):
  -C, --dir <path>      The repo to look in (default: the current directory)
  -b, --branch <name>   One branch (repeatable) instead of the checked-out branch's stack
      --repo            Every commented branch in the repo

Options:
  -m, --message <text>  The message, in Markdown
      --json            Print JSON instead of text
      --human           Act as the human (DIFFVIEW_USER, or the OS username) instead of an agent
  -h, --help            Show this help

Exit codes: 0 done, 1 refused (unknown thread, disallowed status change),
2 malformed command, 3 wait timed out.

Environment:
  DIFFVIEW_AUTHOR       The agent's name on its messages (default: agent)
  DIFFVIEW_HOME         The store's folder (default: ~/.diffview)
`;

const DURATION = /^(\d+)(s|m|h)?$/;
const DURATION_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const POLL_MS = 100;
// How often `wait` prints a status line, in the agent-dash watch format ({next:1m}).
const HEARTBEAT_MS = 60_000;
const PREVIEW_CHARS = 100;
// Printed between threads shown in full, whose own blank lines would otherwise blur together.
const FULL_THREAD_SEPARATOR = "\n\n---\n\n";
// How each stacking tool moves to a branch and restacks what sits above it, for show's footer.
const EDIT_HINTS = {
  graphite: "gt checkout <branch>, edit, then gt modify (restacks the branches above)",
  origin: "git checkout <branch>, edit and commit, then origin stack restack",
  "gh-stack": "git checkout <branch>, edit and commit, then gh stack rebase",
  git: "git checkout <branch>, edit and commit, then rebase the branches above onto it",
};

function parseDuration(text, flag) {
  const match = DURATION.exec(text);
  if (!match || Number(match[1]) === 0) throw new UsageError(`${flag} must look like 30s, 10m or 1h, not ${text}`);
  return Number(match[1]) * DURATION_MS[match[2] ?? "s"];
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60}m` : `${seconds}s`;
}

function requireMessage(values, verb) {
  if (!values.message?.trim()) throw new UsageError(`${verb} needs a message: -m <text>`);
  return values.message;
}

function requireHuman(values, verb) {
  if (!values.human) throw new StoreError(`Only a human may ${verb} a thread (pass --human if that is you). Agents use suggest-resolve.`);
}

/* Scope */

/**
 * What a command covers: the repo, the stack entries in scope, and a way to
 * record each commented entry's current diff. Building a stack takes
 * seconds on a large repo, so `names()` builds it only when asked, and
 * callers first check `hasComments()`, which costs one query.
 */
async function resolveScope(store, values) {
  const repo = await openRepo(values.dir ?? process.cwd()).catch(() => {
    throw new UsageError(`Not inside a git repo: ${values.dir ?? process.cwd()}`);
  });
  const key = repo.commonDir;
  const checkedOut = repo.branch;
  if (!values.repo && !values.branch?.length && !checkedOut) {
    throw new UsageError("HEAD is detached. Name a branch with --branch, or pass --repo for every commented branch.");
  }

  const stacks = new Map();
  const entryOf = async (name) => {
    for (const stack of stacks.values()) {
      const found = stack.entries.find((e) => e.id === name);
      if (found) return { entry: found, stack };
    }
    try {
      const stack = await loadStack(repo, { entry: name });
      stacks.set(name, stack);
      return { entry: stack.entries.find((e) => e.id === name), stack };
    } catch (err) {
      if (err instanceof StackError) return null;
      throw err;
    }
  };
  let cachedNames = null;
  const names = async () => {
    if (cachedNames) return cachedNames;
    if (values.repo) return store.trackedEntries(key);
    if (values.branch?.length) return (cachedNames = values.branch);
    const { stack } = (await entryOf(checkedOut)) ?? {};
    if (!stack) throw new UsageError(`${checkedOut} has no stack to review. Name a branch with --branch.`);
    const branches = stack.entries.map((e) => e.id);
    const stackEntry = store.stackEntry(key, branches);
    return (cachedNames = stackEntry ? [stackEntry, ...branches] : branches);
  };
  const hasComments = () => store.trackedEntries(key).length > 0;

  /** Records each commented entry's diff as it is now. Returns notes for entries that cannot be read. */
  const observe = async (entries) => {
    const notes = [];
    for (const name of entries ?? (await names())) {
      if (isStackEntry(name) || !store.findReview(key, name)) continue;
      const found = await entryOf(name);
      if (!found) {
        notes.push(`${name} is no longer a local branch, so its comments show its last stored version.`);
        continue;
      }
      const workingTree = name === checkedOut;
      const diff = await branchDiff(repo, found.entry, { workingTree });
      store.observe(key, name, { base: found.entry.base, head: found.entry.head, workingTree, patch: diff.patch });
    }
    return notes;
  };
  return { repo, key, names, hasComments, entryOf, observe };
}

/* Text output */

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function lineRange(start, end) {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/** How an entry reads in a sentence: the branch's name, or "the stack" for a stack description's entry. */
function entryName(entry) {
  return isStackEntry(entry) ? "the stack" : entry;
}

/**
 * Where a thread's anchor is, in words: "app.js lines 3-4", "app.js (old
 * side) line 9", "the whole file app.js", "the whole branch". On a stack's
 * entry: "the stack description ..." and "the whole stack".
 */
function anchorText({ kind, path, side, startLine, endLine, heading }, onStack = false) {
  if (kind === "description") return `the ${onStack ? "stack " : ""}description${heading ? ` under "${truncate(heading, 60)}"` : ""}`;
  if (kind === "branch") return onStack ? "the whole stack" : "the whole branch";
  if (kind === "file") return `the whole file ${path}`;
  return `${path}${side === "old" ? " (old side)" : ""} ${lineRange(startLine, endLine)}`;
}

function where(t, onStack) {
  if (t.kind === "description") {
    if (t.state === "current") return anchorText(t, onStack);
    if (t.state === "carried") return `${anchorText(t, onStack)} · from description v${t.madeOn.seq}, unchanged`;
    return `outdated: made on description v${t.madeOn.seq}, its paragraph changed since`;
  }
  if (t.state === "current") return anchorText(t, onStack);
  if (t.state === "carried") return `${anchorText(t, onStack)} · from v${t.madeOn.seq}, lines unchanged`;
  return `outdated: made on v${t.madeOn.seq}, its lines changed since (were ${anchorText({ ...t, ...t.madeOn })})`;
}

function headline(t, onStack) {
  return [`#${t.id} ${STATUS_LABELS[t.status]}`, t.waitingOn && `waiting on ${t.waitingOn}`, where(t, onStack)].filter(Boolean).join(" · ");
}

function excerptText(lines, side) {
  return lines
    .map((l) => {
      const number = String((side === "old" ? l.old : l.new) ?? (side === "old" ? l.new : l.old) ?? "").padStart(5);
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      return `${l.marked ? ">" : " "}${number} ${sign}${l.text}`;
    })
    .join("\n");
}

function listedMessage(m) {
  const [first, ...rest] = m.body.split("\n");
  return [`  ${m.author} (${when(m.sentAt)}, v${m.versionSeq}): ${first}`, ...rest.map((line) => `      ${line}`)].join("\n");
}

function showText({ entry, version, descriptionPath, thread: t }, source) {
  const onStack = isStackEntry(entry);
  const on = onStack ? "on the stack" : `on branch ${entry}${source ? ` (${source} stack)` : ""}`;
  const parts = [`#${t.id} ${STATUS_LABELS[t.status]}${t.waitingOn ? ` · waiting on ${t.waitingOn}` : ""} · ${on}`];
  parts.push(onStack ? where(t, onStack) : `${where(t)} · latest is v${version.latestSeq}`);
  if (t.kind === "description" && t.blockText !== null) {
    parts.push("", t.state === "outdated" ? `As it read in description v${t.madeOn.seq}:` : "In the description:", indent(t.blockText, "    "));
    if (t.state === "outdated") {
      parts.push(
        "",
        t.nowReads ? `Now reads:\n${indent(t.nowReads.text, "    ")}` : "Nothing in the description resembles it now, so it was removed or rewritten.",
      );
    }
  }
  if (t.excerpt.length) {
    const label = t.state === "outdated" ? `As it read in v${t.madeOn.seq}:` : `In v${version.seq}:`;
    parts.push("", label, excerptText(t.excerpt, t.side));
  }
  if (t.state === "outdated" && t.kind === "lines") {
    parts.push(
      "",
      t.nowReads
        ? `Now reads, in v${version.seq}, ${t.nowReads.path} ${lineRange(t.nowReads.startLine, t.nowReads.endLine)}:\n${indent(t.nowReads.text, "    ")}`
        : `Nothing in v${version.seq} resembles those lines, so they were removed or rewritten.`,
    );
  }
  if (t.quote) parts.push("", `> ${truncate(t.quote.replace(/\s+/g, " "), PREVIEW_CHARS)}`);
  parts.push("", t.messages.map((m) => `${m.author} · ${when(m.sentAt)} · v${m.versionSeq}\n${indent(m.body, "    ")}`).join("\n\n"));
  if (t.status === "resolved") return `${parts.join("\n")}\n`;
  if (t.kind === "description") {
    parts.push("", descriptionPath ? `To change it: edit ${descriptionPath}.` : `To change it: link a description file with diffview describe ${onStack ? "--stack" : `--branch ${entry}`} <file>.`);
  } else if (source) {
    parts.push("", `To change it: ${EDIT_HINTS[source].replace("<branch>", entry)}.`);
  }
  return `${parts.join("\n")}\n`;
}

/* Verbs */

async function list(store, _targets, values) {
  const waitingOn = values["waiting-on"];
  if (waitingOn !== undefined && waitingOn !== "agent" && waitingOn !== "human") {
    throw new UsageError(`--waiting-on must be agent or human, not ${waitingOn}`);
  }
  const scope = await resolveScope(store, values);
  const names = scope.hasComments() ? await scope.names() : [];
  const sections = await scope.observe(names);
  const json = [];
  for (const name of names) {
    const result = store.threadsAt(scope.key, name);
    if (!result?.threads.length) continue;
    const threads = result.threads.filter((t) => (values.all || t.status !== "resolved") && (!waitingOn || t.waitingOn === waitingOn));
    if (!threads.length) continue;
    const onStack = isStackEntry(name);
    const source = onStack ? null : (await scope.entryOf(name))?.entry.source;
    json.push({ ...result, source, threads });
    const counts = Object.entries(STATUS_LABELS)
      .map(([status, label]) => [result.threads.filter((t) => t.status === status).length, label])
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(", ");
    const head = onStack ? `${entryName(name)} · ${counts}` : `${name} · v${result.version.latestSeq} · ${counts}`;
    const body = values.full
      ? threads.map((t) => showText({ ...result, entry: name, thread: t }, source).trimEnd()).join(FULL_THREAD_SEPARATOR)
      : threads.map((t) => [headline(t, onStack), ...(t.quote ? [`  > ${truncate(t.quote, PREVIEW_CHARS)}`] : []), ...t.messages.map(listedMessage)].join("\n")).join("\n\n");
    sections.push(`${head}\n\n${body}`);
  }
  if (!json.length) sections.push(waitingOn ? `Nothing is waiting on the ${waitingOn}.` : "No unresolved comments in scope. Pass --all to include resolved ones.");
  return { text: `${sections.join(values.full ? FULL_THREAD_SEPARATOR : "\n\n")}\n`, json };
}

/** Records a thread's branch's current diff before reading it, when its repo is the one here. */
async function observeThread(store, id, values) {
  const { repo: key, entry } = store.reviewOf(id);
  const repo = await openRepo(values.dir ?? process.cwd()).catch(() => null);
  if (repo?.commonDir !== key || isStackEntry(entry)) return null;
  const scope = await resolveScope(store, { ...values, branch: [entry], repo: false });
  await scope.observe([entry]);
  return (await scope.entryOf(entry))?.entry.source ?? null;
}

async function show(store, ids, values) {
  const results = [];
  for (const id of ids) {
    const source = await observeThread(store, id, values);
    results.push({ ...store.thread(id), source });
  }
  return { text: `${results.map((r) => showText(r, r.source).trimEnd()).join(FULL_THREAD_SEPARATOR)}\n`, json: results };
}

function acted(store, id, sentence) {
  const result = store.thread(id);
  return { text: `${sentence}\n${headline(result.thread, isStackEntry(result.entry))}\n`, json: result };
}

async function reply(store, id, values, author) {
  await observeThread(store, id, values);
  store.reply(id, requireMessage(values, "reply"), author);
  return acted(store, id, `Replied to #${id}.`);
}

async function suggestResolve(store, id, values, author) {
  await observeThread(store, id, values);
  store.setStatus(id, "suggested", author, requireMessage(values, "suggest-resolve"));
  return acted(store, id, `Suggested resolving #${id}. It now waits on the human.`);
}

async function resolve(store, id, values, author) {
  requireHuman(values, "resolve");
  store.setStatus(id, "resolved", author, values.message);
  return acted(store, id, `Resolved #${id}.`);
}

async function reopen(store, id, values, author) {
  requireHuman(values, "reopen");
  store.setStatus(id, "open", author, values.message);
  return acted(store, id, `Reopened #${id}.`);
}

async function apply(store, _targets, values, author, { stdin }) {
  if (!values.stdin) throw new UsageError("apply reads its actions from stdin: pass --stdin");
  let actions;
  try {
    actions = JSON.parse(await stdin());
  } catch (err) {
    throw new UsageError(`stdin is not JSON: ${err.message}`);
  }
  if (!Array.isArray(actions)) actions = actions?.actions;
  store.apply(actions, author);
  const ids = actions.map((a) => a.reply ?? a.suggestResolve);
  const lines = [...new Set(ids)].map((id) => {
    const { entry, thread } = store.thread(id);
    return headline(thread, isStackEntry(entry));
  });
  return { text: `Applied ${actions.length} ${actions.length === 1 ? "action" : "actions"}.\n${lines.join("\n")}\n`, json: ids.map((id) => store.thread(id)) };
}

function parseLines(text) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(text ?? "");
  if (!match) throw new UsageError(`--line must look like 12 or 12-15, not ${text}`);
  return [Number(match[1]), Number(match[2] ?? match[1])];
}

async function add(store, _targets, values, author) {
  const body = requireMessage(values, "add");
  if (!values.file && !values["whole-branch"]) throw new UsageError("add needs --file <path> (with --line for lines), or --whole-branch");
  if (values.branch?.length > 1) throw new UsageError("add takes one --branch");
  const scope = await resolveScope(store, values);
  const name = values.branch?.[0] ?? scope.repo.branch;
  const found = await scope.entryOf(name);
  if (!found) throw new UsageError(`${name} has no stack entry to comment on.`);
  const workingTree = name === scope.repo.branch;
  const diff = await branchDiff(scope.repo, found.entry, { workingTree });
  const [startLine, endLine] = values.line === undefined ? [null, null] : parseLines(values.line);
  const kind = values["whole-branch"] ? "branch" : values.line === undefined ? "file" : "lines";
  const id = store.createThread({
    repo: scope.key,
    entry: name,
    snapshot: { base: found.entry.base, head: found.entry.head, workingTree, patch: diff.patch },
    kind,
    path: values.file,
    side: values.side ?? "new",
    startLine,
    endLine,
    body,
    author,
  });
  const result = store.thread(id);
  return { text: `Started thread #${id} on ${anchorText(result.thread)} of ${name}.\n`, json: result };
}

/**
 * Calls `onChange` whenever the store may have changed. A running viewer's
 * doorbell rings within milliseconds of a browser comment. SQLite's change
 * counter, read every POLL_MS, covers writes when no viewer runs and any ring
 * that gets lost. Returns a function that stops listening.
 */
function listenForChanges(store, home, onChange) {
  let token = store.changeToken();
  const poller = setInterval(() => {
    const next = store.changeToken();
    if (next !== token) {
      token = next;
      onChange();
    }
  }, POLL_MS);
  const viewer = liveServers(home)[0];
  const request =
    viewer &&
    http.get({ host: "127.0.0.1", port: viewer.port, path: "/api/store-events" }, (res) => {
      if (res.statusCode !== 200) return res.resume();
      // Anything that landed while the stream was opening has rung nobody, so look once now.
      onChange();
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          if (/^event: change$/m.test(buffer.slice(0, end))) onChange();
          buffer = buffer.slice(end + 2);
        }
      });
    });
  request?.on("error", () => {});
  return () => {
    clearInterval(poller);
    request?.destroy();
  };
}

/**
 * Returns once anything in scope waits on the agent: at once if something
 * already does, otherwise the moment a write makes it so. Prints those
 * threads in full, as list --waiting-on agent --full does. There is no
 * cursor, so an agent must answer every thread waiting on it before it waits
 * again, or the same threads return at once.
 */
async function wait(store, targets, values, author, context) {
  const timeout = parseDuration(values.timeout ?? "30m", "--timeout");
  const scope = await resolveScope(store, values);
  const found = () => list(store, targets, { ...values, "waiting-on": "agent", full: true }, author, context);
  // The repo-wide query is one cheap read per ring; the stack is built only once something in the repo waits.
  const waiting = async () => {
    if (!store.waitingOnAgent({ repo: scope.key }).length) return false;
    if (values.repo) return true;
    return store.waitingOnAgent({ repo: scope.key, entries: await scope.names() }).length > 0;
  };
  if (await waiting()) return found();

  const label = values.repo
    ? `every branch in ${scope.repo.top}`
    : values.branch?.length
      ? values.branch.join(", ")
      : `the stack of ${scope.repo.branch}`;
  context.progress(`waiting for comments on ${label} {next:1m}\n`);
  const arrived = await new Promise((resolve) => {
    let done = false;
    let stop = () => {};
    let timer;
    let heartbeat;
    // A ring can still arrive after finishing, when the store is about to close, so later calls do nothing.
    const finish = (value) => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve(value);
    };
    // A ring during a check (which may be building the stack) is not dropped: the check runs again after.
    let checking = false;
    let again = false;
    const check = async () => {
      if (done) return;
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        do {
          again = false;
          if (await waiting()) finish(true);
        } while (again && !done);
      } finally {
        checking = false;
      }
    };
    stop = listenForChanges(store, context.home, check);
    timer = setTimeout(() => finish(false), timeout);
    heartbeat = setInterval(() => context.progress(`waiting for comments on ${label} {next:1m}\n`), HEARTBEAT_MS);
    check();
  });
  if (arrived) return found();
  return { text: `Nothing waited on the agent in ${label} after ${formatDuration(timeout)}.\n`, json: { timedOut: true }, code: 3 };
}

// Verbs marked `many` take every positional argument, `none` take none, and the rest exactly one id.
const VERBS = {
  list: { arity: "none", run: list },
  show: { arity: "many", arg: "<id>...", run: show },
  reply: { arity: "one", arg: "<id>", run: reply },
  "suggest-resolve": { arity: "one", arg: "<id>", run: suggestResolve },
  apply: { arity: "none", run: apply },
  resolve: { arity: "one", arg: "<id>", run: resolve },
  reopen: { arity: "one", arg: "<id>", run: reopen },
  add: { arity: "none", run: add },
  wait: { arity: "none", run: wait },
};

/**
 * Runs `diffview comments <args>` and returns the exit code: 0 on success,
 * 1 when the store refuses, 2 for a malformed command, 3 when `wait` times
 * out.
 */
export async function runComments(args, { out = process.stdout, err = process.stderr, env = process.env, stdin = readStdin } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        message: { type: "string", short: "m" },
        json: { type: "boolean" },
        human: { type: "boolean" },
        all: { type: "boolean" },
        full: { type: "boolean" },
        "waiting-on": { type: "string" },
        dir: { type: "string", short: "C" },
        branch: { type: "string", short: "b", multiple: true },
        repo: { type: "boolean" },
        file: { type: "string" },
        line: { type: "string" },
        side: { type: "string" },
        "whole-branch": { type: "boolean" },
        stdin: { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`diffview comments: ${error.message}\n\n${USAGE}`);
    return 2;
  }

  const [verb, ...targets] = positionals;
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  const spec = VERBS[verb];
  if (!spec) {
    err.write(`${verb ? `diffview comments: unknown verb "${verb}"\n\n` : ""}${USAGE}`);
    return 2;
  }
  if (spec.arity === "none" && targets.length) {
    err.write(`diffview comments ${verb}: takes no arguments, not ${targets.join(" ")}\n`);
    return 2;
  }
  if (spec.arity !== "none" && !targets.length) {
    err.write(`diffview comments ${verb}: missing ${spec.arg}\n`);
    return 2;
  }
  if (spec.arity === "one" && targets.length > 1) {
    err.write(`diffview comments ${verb}: takes one ${spec.arg}, not ${targets.length}\n`);
    return 2;
  }
  if (values.side !== undefined && values.side !== "new" && values.side !== "old") {
    err.write(`diffview comments ${verb}: --side must be new or old, not ${values.side}\n`);
    return 2;
  }

  let store;
  try {
    store = await openStore(storeHome(env));
    // Progress lines would break JSON on stdout, so they move to stderr with --json.
    const progress = (line) => (values.json ? err : out).write(line);
    const target = spec.arity === "many" ? targets : spec.arity === "one" ? targets[0] : null;
    const result = await spec.run(store, target, values, authorFrom(values, env), { progress, home: storeHome(env), stdin });
    out.write(values.json ? `${JSON.stringify(result.json, null, 2)}\n` : result.text);
    return result.code ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`diffview comments ${verb}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof StoreError || error instanceof StackError) {
      err.write(`diffview comments ${verb}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    store?.close();
  }
}