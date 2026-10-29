/**
 * `diffview describe`: links a Markdown file as a branch's (or a stack's)
 * description, or prints the description as its file reads now. The file
 * is the agent's to keep and edit; diffview only remembers where it is.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { authorFrom, when } from "./cli.mjs";
import { readDescriptionFile } from "./descriptions.mjs";
import { git } from "./git.mjs";
import { localBranches, openRepo } from "./repo.mjs";
import { loadStack, StackError } from "./stack.mjs";
import { openStore, StoreError, storeHome } from "./store.mjs";

const USAGE = `Usage: diffview describe [<file>] [options]

A branch's description is a Markdown file you keep wherever you like and edit
with your usual tools. diffview shows it above the branch's diff, takes
comments on it, and prints it as the PR's body. The PR title goes in front
matter:

  ---
  title: Share compute()
  ---
  ## Why
  ...

With <file>, links it as the description, replacing any file linked before.
Without, prints the description as its file reads now.

With --stack, the whole stack's description instead: what the stack is for
and how its branches fit together, shown on the stack's Overview page. It
belongs to the stack's branches, so it stays with the stack as branches are
added on top or merge from the bottom.

Keep the file outside the worktree, or in a gitignored folder there: an
untracked file in the worktree shows up in the checked-out branch's diff.

Options:
  -b, --branch <name>   The branch (default: the one checked out); with
                        --stack, any branch in the stack
      --stack           The stack's description, not the branch's
  -C, --dir <path>      The repo (default: the current directory)
      --print           Print only the body, as a PR's body
      --print-title     Print only the title
      --path            Print only the file's path
      --json            Print JSON
  -h, --help            Show this help

Exit codes: 0 done, 1 no description or its file is missing, 2 malformed
command.
`;

/** Whether `file` would show in the checked-out branch's diff as an untracked file: inside the worktree, neither tracked nor ignored. */
async function showsAsUntracked(repo, file) {
  const inRepo = path.relative(repo.top, file);
  if (inRepo.startsWith("..") || path.isAbsolute(inRepo)) return false;
  const ignored = (await git(repo.top, ["check-ignore", "--", inRepo], { allowExit: [1] })).trim();
  if (ignored) return false;
  const tracked = (await git(repo.top, ["ls-files", "--", inRepo])).trim();
  return !tracked;
}

/** Runs `diffview describe <args>` and returns the exit code. */
export async function runDescribe(args, { out = process.stdout, err = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        branch: { type: "string", short: "b" },
        stack: { type: "boolean" },
        dir: { type: "string", short: "C" },
        print: { type: "boolean" },
        "print-title": { type: "boolean" },
        path: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err.write(`diffview describe: ${error.message}. See diffview describe --help.\n`);
    return 2;
  }
  if (values.help) {
    out.write(USAGE);
    return 0;
  }
  const fail = (message, code = 2) => {
    err.write(`diffview describe: ${message}\n`);
    return code;
  };
  if (positionals.length > 1) return fail(`takes one file, not ${positionals.length}`);
  const [file] = positionals;

  const repo = await openRepo(values.dir ?? cwd).catch(() => null);
  if (!repo) return fail(`Not inside a git repo: ${values.dir ?? cwd}`);
  const branch = values.branch ?? repo.branch;
  if (!branch) return fail("HEAD is detached. Name a branch with --branch.");
  if (!(await localBranches(repo)).has(branch)) return fail(`No local branch named ${branch}.`);
  let branches = null;
  if (values.stack) {
    try {
      branches = (await loadStack(repo, { entry: branch })).entries.map((e) => e.id);
    } catch (error) {
      if (error instanceof StackError) return fail(error.message);
      throw error;
    }
  }
  const subject = values.stack ? `the stack of ${branch}` : branch;

  const store = await openStore(storeHome(env));
  try {
    if (file !== undefined) {
      const absolute = path.resolve(cwd, file);
      const read = readDescriptionFile(absolute);
      if (read.missing) return fail(`${file} cannot be a description: ${read.reason}.`);
      if (await showsAsUntracked(repo, absolute)) {
        err.write(`diffview describe: warning: ${file} is untracked in the worktree, so it shows in the checked-out branch's diff. Move it outside the repo or into a gitignored folder.\n`);
      }
      const author = authorFrom({}, env);
      const linked = values.stack ? store.linkStackDescription(repo.commonDir, branches, absolute, author) : store.linkDescription(repo.commonDir, branch, absolute, author);
      out.write(values.json ? `${JSON.stringify(linked, null, 2)}\n` : `Linked ${absolute} as the description of ${subject}.\n`);
      return 0;
    }

    const entry = values.stack ? store.stackEntry(repo.commonDir, branches) : branch;
    const current = entry && store.description(repo.commonDir, entry);
    if (values.json) {
      out.write(`${JSON.stringify(current ? { ...current, entry } : null, null, 2)}\n`);
      return current && !current.missing ? 0 : 1;
    }
    if (!current) return fail(`${subject} has no description. Link a Markdown file with: diffview describe${values.stack ? " --stack" : ""} <file>`, 1);
    if (values.path) {
      out.write(`${current.path}\n`);
      return 0;
    }
    if (current.missing) return fail(`the description file of ${subject} is missing: ${current.path} (${current.reason}).`, 1);
    if (values.print) out.write(current.body);
    else if (values["print-title"]) out.write(`${current.title ?? ""}\n`);
    else out.write(`${current.path} · edited ${when(current.editedAt)}\n\n${current.title ? `# ${current.title}\n\n` : ""}${current.body}`);
    return 0;
  } catch (error) {
    if (error instanceof StoreError) return fail(error.message, 1);
    throw error;
  } finally {
    store.close();
  }
}
