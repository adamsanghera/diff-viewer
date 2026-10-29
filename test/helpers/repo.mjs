/** Builds throwaway git repos for tests. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** A fresh repo on `main` with one empty commit. */
export function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "diffview-repo-")));
  const repo = {
    dir,
    git: (...args) => execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" }).trim(),
    write(file, content) {
      const abs = path.join(dir, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    /**
     * Writes `files` ({path: content, or null to delete}) and commits them,
     * dated `date` (unix seconds) when given. Returns the new commit.
     */
    commit(message, files = {}, { date } = {}) {
      for (const [file, content] of Object.entries(files)) {
        if (content === null) fs.rmSync(path.join(dir, file));
        else repo.write(file, content);
      }
      repo.git("add", "-A");
      const env = date ? { ...ENV, GIT_COMMITTER_DATE: `${date} +0000`, GIT_AUTHOR_DATE: `${date} +0000` } : ENV;
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: dir, env });
      return repo.git("rev-parse", "HEAD");
    },
    sha: (ref) => repo.git("rev-parse", ref),
    /** Stores `value` as a blob and points `ref` at it, as Graphite does for its branch metadata. */
    writeRefBlob(ref, value) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, env: ENV, input: value, encoding: "utf8" }).trim();
      repo.git("update-ref", ref, blob);
    },
    commonDir: () => path.resolve(dir, repo.git("rev-parse", "--git-common-dir")),
  };
  repo.git("init", "-q", "-b", "main");
  repo.commit("root");
  return repo;
}
