#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { runComments } from "../lib/comments-cli.mjs";
import { register } from "../lib/registry.mjs";
import { startServer } from "../lib/server.mjs";
import { SOURCES } from "../lib/stack.mjs";
import { openStore, storeHome } from "../lib/store.mjs";
import { ensureVendorBundle } from "../lib/vendor.mjs";

if (process.argv[2] === "comments") process.exit(await runComments(process.argv.slice(3)));

const SOURCE_NAMES = SOURCES.map((s) => s.name);

const USAGE = `Usage: diffview [repo-dir] [options]
       diffview comments <verb> [options]

Opens the stack of the checked-out branch in a local diff viewer: every
branch from trunk to the top, each with its own diff. Stacks made with
Graphite, Origin, gh stack, or plain git branches all work. "diffview
comments --help" lists the verbs agents use to read and answer comments.

Options:
  -b, --branch <name>        Open this branch's stack instead of the checked-out one.
      --stack-source <name>  Read stacks from one tool only: ${SOURCE_NAMES.join(", ")}.
  -p, --port <n>             First port to try (default: 4645; moves up if taken).
      --no-open              Print the URL without opening a browser.
  -h, --help                 Show this help.

Environment:
  DIFFVIEW_TRACE=1           Log every git call and how long it took.`;

function fail(message) {
  console.error(`diffview: ${message}`);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: "string", short: "b" },
      "stack-source": { type: "string" },
      port: { type: "string", short: "p" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
const { values, positionals } = args;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const source = values["stack-source"];
if (source && !SOURCE_NAMES.includes(source)) fail(`--stack-source must be one of ${SOURCE_NAMES.join(", ")}`);
const port = values.port === undefined ? undefined : Number(values.port);
if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail(`--port must be a port number, not ${values.port}`);

await ensureVendorBundle();
const store = await openStore().catch((err) => {
  console.error(`diffview: comments are off because the comment store did not open: ${err.message}`);
  return null;
});
let started;
try {
  started = await startServer({ dir: positionals[0] ?? ".", initialBranch: values.branch ?? null, source: source ?? null, port, store });
} catch (err) {
  fail(err.message);
}
console.log(`diffview serving ${started.repo.top}\n  ${started.url}`);
if (store) {
  const unregister = register(storeHome(), { port: started.port, root: started.repo.top });
  process.on("exit", unregister);
  // SIGHUP stays default, so a viewer started under nohup keeps running when its terminal goes.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}
if (!values["no-open"]) spawn("open", [started.url], { stdio: "ignore", detached: true }).unref();
