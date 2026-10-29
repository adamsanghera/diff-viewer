/**
 * Diffs already computed, so a branch shown again runs no git.
 *
 * A diff between two commits never changes, so it is keyed by their shas
 * and kept until evicted. The checked-out branch's diff is against the
 * working tree, which changes without any commit, so its key also carries
 * an epoch that the file watcher bumps on every change. That diff is cached
 * only while the watcher runs (while a page is open): without it, an edit
 * could go unnoticed and the cache would show stale code. Its cost is
 * listing untracked files, seconds on a large monorepo, which is what the
 * cache saves.
 */
const MAX_ENTRIES = 64;

export class DiffCache {
  #entries = new Map();
  #epoch = 0;
  #watching = false;

  /** Called on every file change the watcher sees, before it settles. */
  noteChange() {
    this.#epoch++;
  }

  /** Whether the file watcher is running, so working-tree diffs may be cached. */
  setWatching(watching) {
    this.#watching = watching;
    this.#epoch++;
  }

  /** The key for a diff from `base` to `head`, or to the working tree; null when it must not be cached. */
  key(base, head, workingTree) {
    if (!workingTree) return `${base}..${head}`;
    return this.#watching ? `${base}..${head}+worktree@${this.#epoch}` : null;
  }

  get(key) {
    if (!key || !this.#entries.has(key)) return null;
    const value = this.#entries.get(key);
    // Re-inserting marks it most recently used, so eviction takes the oldest.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (!key) return;
    this.#entries.set(key, value);
    if (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
  }
}
