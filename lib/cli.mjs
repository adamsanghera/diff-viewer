/** What diffview's agent-facing commands (comments, describe) share. */
import fs from "node:fs/promises";
import { humanName } from "./store.mjs";

/** A malformed command: exit code 2. */
export class UsageError extends Error {}

// How much of a session id names an agent that set no DIFFVIEW_AUTHOR: enough to tell two apart.
const SESSION_NAME_CHARS = 8;

/**
 * Who a write comes from: the human with --human, else an agent named by
 * DIFFVIEW_AUTHOR, or by its session, so two agents' replies read apart.
 */
export function authorFrom(values, env) {
  if (values.human) return { name: humanName(env), kind: "human", session: null };
  const session = env.DIFFVIEW_SESSION || env.CURSOR_CONVERSATION_ID || env.TERM_SESSION_ID || null;
  return {
    name: env.DIFFVIEW_AUTHOR || (session ? `agent ${session.slice(0, SESSION_NAME_CHARS)}` : "agent"),
    kind: "agent",
    session,
  };
}

/** The text of the file `from` names, or of stdin when it is "-". */
export async function readFrom(from, stdin) {
  if (from === "-") return stdin();
  try {
    return await fs.readFile(from, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${from}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
  }
}

/** The text given with -m, or with --from (a file, or "-" for stdin); undefined when neither is. */
export async function textFrom(values, stdin) {
  if (values.message !== undefined && values.from !== undefined) throw new UsageError("give -m or --from, not both");
  return values.from === undefined ? values.message : readFrom(values.from, stdin);
}

/** The choice `word` was likely meant to be: one that starts with it, or is at most two edits away; else null. */
export function didYouMean(word, choices) {
  if (!word) return null;
  const prefixed = choices.filter((c) => c.startsWith(word));
  if (prefixed.length === 1) return prefixed[0];
  let best = null;
  let bestDistance = 3;
  for (const choice of choices) {
    const distance = editDistance(word, choice);
    if (distance < bestDistance) [best, bestDistance] = [choice, distance];
  }
  return best;
}

/** Levenshtein distance: the fewest insertions, deletions and substitutions that turn `a` into `b`. */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** A time as people read it in a terminal: the clock today, else the date too. */
export function when(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return clock;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}
