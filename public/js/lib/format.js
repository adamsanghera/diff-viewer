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
