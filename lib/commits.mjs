/**
 * Reads commits through one long-lived `git cat-file --batch` process, so
 * walking thousands of commits costs one process instead of thousands.
 * Each commit is read once and remembered.
 */
import { spawn } from "node:child_process";

export class CommitReader {
  #child;
  #buffer = Buffer.alloc(0);
  #waiting = [];
  #cache = new Map();

  constructor(cwd) {
    this.#child = spawn("git", ["cat-file", "--batch"], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    this.#child.stdout.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    this.#child.on("error", (err) => this.#failAll(err));
    this.#child.on("close", () => this.#failAll(new Error("git cat-file exited")));
  }

  /** The commit `sha`: {sha, parents, committedAt (unix seconds)}, or null when the repo lacks it. */
  read(sha) {
    if (!this.#cache.has(sha)) {
      this.#cache.set(
        sha,
        new Promise((resolve, reject) => {
          this.#waiting.push({ resolve, reject });
          this.#child.stdin.write(`${sha}\n`);
        }),
      );
    }
    return this.#cache.get(sha);
  }

  close() {
    this.#child.stdin.end();
  }

  /** Answers waiting reads in order, as whole responses arrive: "<sha> <type> <size>\n<content>\n" or "<sha> missing\n". */
  #drain() {
    while (this.#waiting.length) {
      const newline = this.#buffer.indexOf(10);
      if (newline === -1) return;
      const header = this.#buffer.subarray(0, newline).toString("utf8").split(" ");
      if (header[1] === "missing" || header.length < 3) {
        this.#buffer = this.#buffer.subarray(newline + 1);
        this.#waiting.shift().resolve(null);
        continue;
      }
      const size = Number(header[2]);
      if (this.#buffer.length < newline + 1 + size + 1) return;
      const content = this.#buffer.subarray(newline + 1, newline + 1 + size).toString("utf8");
      this.#buffer = this.#buffer.subarray(newline + 1 + size + 1);
      this.#waiting.shift().resolve(header[1] === "commit" ? parseCommit(header[0], content) : null);
    }
  }

  #failAll(err) {
    for (const { reject } of this.#waiting.splice(0)) reject(err);
  }
}

function parseCommit(sha, content) {
  const parents = [];
  let committedAt = 0;
  for (const line of content.split("\n")) {
    if (line === "") break;
    if (line.startsWith("parent ")) parents.push(line.slice("parent ".length));
    else if (line.startsWith("committer ")) committedAt = Number(line.split(" ").at(-2));
  }
  return { sha, parents, committedAt };
}
