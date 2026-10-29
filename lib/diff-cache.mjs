/**
 * Diffs already computed, so a branch shown again runs no git.
 *
 * A diff between two commits never changes, so it is keyed by their shas
 * and kept until evicted. Values are promises, so callers asking while a
 * diff is still being computed share that computation.
 */
const MAX_ENTRIES = 64;

export class DiffCache {
  #entries = new Map();
  // What each cached promise resolved to, for peek().
  #settled = new WeakMap();

  /** The key for the diff from commit `base` to commit `head`. */
  key(base, head) {
    return `${base}..${head}`;
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
    Promise.resolve(value).then(
      (settled) => this.#settled.set(value, settled),
      () => {},
    );
    if (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
  }

  /** The finished diff under `key`, without waiting or marking it used; null while it is computed, or when absent. */
  peek(key) {
    const value = key ? this.#entries.get(key) : undefined;
    return value ? (this.#settled.get(value) ?? null) : null;
  }

  /** Forgets `key`, as when its computation failed. */
  delete(key) {
    if (key) this.#entries.delete(key);
  }
}
