/**
 * Parses `git diff` output into files, hunks and lines.
 *
 * The parser expects the options diffArgs() passes, which pin down the parts
 * of the format that user config can change: a/ and b/ prefixes, no color,
 * no external diff or textconv, and renames detected.
 */

/** Options that make `git diff` output parseable here, whatever the user's git config says. */
export const DIFF_ARGS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const ESCAPES = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };

/**
 * Undoes git's C-style quoting of a path with unusual characters:
 * "a/tab\there" becomes a/tab<TAB>here. Octal escapes are UTF-8 bytes.
 */
export function unquotePath(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = text[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(text.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ESCAPES[next] ?? next, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path on a `--- a/x` or `+++ b/x` line. Git ends it with a tab when the path holds a space. */
function markerPath(line, prefix) {
  const raw = line.slice(4);
  return stripPrefix(raw.startsWith('"') ? unquotePath(raw) : raw.replace(/\t$/, ""), prefix);
}

function stripPrefix(file, prefix) {
  if (file === "/dev/null") return null;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * Reads the two paths from a `diff --git a/x b/y` line. Unquoted paths may
 * hold spaces, so when neither is quoted the line is split where both
 * halves name the same file. Renames and copies with spaces are ambiguous
 * here, but their `rename from`/`rename to` lines say the paths outright.
 */
function headerPaths(rest) {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return [stripPrefix(unquotePath(rest.slice(0, end + 1)), "a/"), stripPrefix(unquotePath(rest.slice(end + 2)), "b/")];
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    return [stripPrefix(rest.slice(0, start), "a/"), stripPrefix(unquotePath(rest.slice(start + 1)), "b/")];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
    return [rest.slice(2, half), rest.slice(half + 3)];
  }
  const space = rest.indexOf(" b/");
  return [stripPrefix(rest.slice(0, space), "a/"), stripPrefix(rest.slice(space + 1), "b/")];
}

function newFile(oldPath, newPath) {
  return { oldPath, newPath, status: "modified", binary: false, oldMode: null, newMode: null, similarity: null, hunks: [], additions: 0, deletions: 0 };
}

/**
 * Parses unified diff text from `git diff` into a list of files. Each file
 * has `oldPath` and `newPath` (null on the side where it does not exist),
 * a `status` (added, deleted, modified, renamed or copied), mode changes,
 * a `binary` flag, +/- counts, and hunks. Each hunk line has a `kind`
 * (context, add or del), its `old` and/or `new` line number, its `text`
 * without the leading marker, and `noNewline` when the file ends there
 * without a newline.
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = newFile(...headerPaths(line.slice("diff --git ".length)));
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    // A hunk's header says how many lines it holds, so a removed line that
    // reads "--- x" is never mistaken for the next file's header.
    if (hunk && line.startsWith("\\")) {
      hunk.lines.at(-1).noNewline = true;
      continue;
    }
    if (hunk && (oldLine < hunk.oldStart + hunk.oldLines || newLine < hunk.newStart + hunk.newLines)) {
      const marker = line[0];
      if (marker === "+") {
        hunk.lines.push({ kind: "add", old: null, new: newLine++, text: line.slice(1) });
        file.additions++;
      } else if (marker === "-") {
        hunk.lines.push({ kind: "del", old: oldLine++, new: null, text: line.slice(1) });
        file.deletions++;
      } else {
        hunk.lines.push({ kind: "context", old: oldLine++, new: newLine++, text: line.slice(1) });
      }
      continue;
    }
    hunk = null;

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const [, oldStart, oldCount, newStart, newCount, context] = header;
      hunk = {
        oldStart: Number(oldStart),
        oldLines: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart),
        newLines: newCount === undefined ? 1 : Number(newCount),
        context,
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length);
      file.oldPath = null;
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length);
      file.newPath = null;
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length);
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.status = line.startsWith("rename") ? "renamed" : "copied";
      file.oldPath = unquotePath(line.slice(line.indexOf(" from ") + " from ".length));
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.newPath = unquotePath(line.slice(line.indexOf(" to ") + " to ".length));
    } else if (line.startsWith("similarity index ")) {
      file.similarity = Number.parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    } else if (line.startsWith("--- ") && file.status !== "renamed" && file.status !== "copied") {
      const from = markerPath(line, "a/");
      if (from !== null) file.oldPath = from;
    } else if (line.startsWith("+++ ") && file.status !== "renamed" && file.status !== "copied") {
      const to = markerPath(line, "b/");
      if (to !== null) file.newPath = to;
    }
  }
  return files;
}

/**
 * Pairs a hunk's lines into rows for a side-by-side view. Context lines
 * fill both sides. Within each run of removed lines followed by added
 * lines, the i-th removed line sits beside the i-th added line, and the
 * longer side's leftovers face an empty cell, as GitHub lays them out.
 * Each row is {old, new}, where either side may be null.
 */
export function splitRows(hunkLines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ old: dels[i] ?? null, new: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of hunkLines) {
    if (line.kind === "del") {
      if (adds.length) flush();
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      rows.push({ old: line, new: line });
    }
  }
  flush();
  return rows;
}
