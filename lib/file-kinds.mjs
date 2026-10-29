/**
 * Which changed files are tests and which are generated, so the viewer can
 * hide them by default and leave them out of a branch's stats.
 *
 * Generated files follow GitHub's convention: the `linguist-generated` or
 * `linguist-vendored` attribute in .gitattributes. Without either, a short
 * list of files that are generated nearly everywhere (lockfiles, protobuf
 * output, minified bundles, test snapshots) counts too.
 *
 * Tests have no shared attribute, so a repo may set `diffview-test`;
 * without it, paths shaped like tests in the common ecosystems count.
 *
 * An attribute set to false (`-linguist-generated`, `diffview-test=false`)
 * overrides the guess either way. Attributes are read from the worktree's
 * .gitattributes files with one `git check-attr` for all paths.
 */
import { git } from "./git.mjs";

const ATTRIBUTES = ["linguist-generated", "linguist-vendored", "diffview-test"];

const GENERATED_PATHS = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock)$/,
  /(^|\/)(__generated__|generated)\//,
  /\.(generated|gen)\.[^/]+$/,
  /\.pb(\.gw)?\.go$|_grpc\.pb\.go$|\.connect\.go$|_pb2(_grpc)?\.pyi?$|_pb\.(js|ts|d\.ts)$/,
  /\.min\.(js|css)$|\.map$/,
  /\.snap$|(^|\/)__snapshots__\//,
];

const TEST_PATHS = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|testdata|fixtures)\//,
  /\.(test|spec|e2e)\.[^/]+$/,
  /_test\.(go|py|rb|exs?|dart)$|(^|\/)test_[^/]+\.py$|_spec\.rb$/,
  /(Test|Tests|Spec)\.(java|kt|scala|cs|swift|php)$/,
];

/** A check-attr value as true, false, or null when the file does not say. */
function attributeValue(info) {
  if (info === "set" || info === "true") return true;
  if (info === "unset" || info === "false") return false;
  return null;
}

/**
 * Each path's kind: "generated", "test", or null for an ordinary file.
 * Generated wins over test, so a test snapshot counts as generated.
 */
export async function fileKinds(repo, paths) {
  const kinds = new Map();
  if (!paths.length) return kinds;
  const attributes = new Map(paths.map((p) => [p, {}]));
  const out = await git(repo.top, ["check-attr", "-z", "--stdin", ...ATTRIBUTES], { input: paths.join("\0") + "\0" });
  // -z output is path, attribute, value, each ended by NUL, for every path and attribute asked.
  const fields = out.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const said = attributes.get(fields[i]);
    if (said) said[fields[i + 1]] = attributeValue(fields[i + 2]);
  }
  for (const p of paths) {
    const said = attributes.get(p);
    const generatedSaid = said["linguist-generated"] ?? said["linguist-vendored"] ?? null;
    const generated = generatedSaid ?? GENERATED_PATHS.some((re) => re.test(p));
    const test = said["diffview-test"] ?? TEST_PATHS.some((re) => re.test(p));
    kinds.set(p, generated ? "generated" : test ? "test" : null);
  }
  return kinds;
}
