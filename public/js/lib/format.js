const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 8) : "";
}

// Files no one reviews line by line: lockfiles and generated code. They start collapsed.
const GENERATED = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/,
  /\.(pb\.go|pb\.ts|pb\.js|_pb2\.py|_pb\.ts|min\.js|min\.css|snap)$/,
  /(^|\/)(dist|build|vendor|__generated__|generated)\//,
];
const LARGE_FILE_LINES = 500;

/** Whether a file's diff starts collapsed: it is generated, or too big to read in place. */
export function startsCollapsed(file) {
  return GENERATED.some((pattern) => pattern.test(file.path)) || file.additions + file.deletions > LARGE_FILE_LINES;
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How long before `now` the time `ms` was: "just now", "5m ago", "3h ago", or a date. */
export function ago(ms, now = Date.now()) {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
