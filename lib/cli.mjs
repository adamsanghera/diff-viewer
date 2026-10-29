/** What diffview's agent-facing commands (comments, describe) share. */
import { humanName } from "./store.mjs";

/** A malformed command: exit code 2. */
export class UsageError extends Error {}

/** Who a write comes from: the human with --human, else an agent named by DIFFVIEW_AUTHOR. */
export function authorFrom(values, env) {
  if (values.human) return { name: humanName(env), kind: "human", session: null };
  return {
    name: env.DIFFVIEW_AUTHOR || "agent",
    kind: "agent",
    session: env.DIFFVIEW_SESSION || env.CURSOR_CONVERSATION_ID || env.TERM_SESSION_ID || null,
  };
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
