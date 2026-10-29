/**
 * Per-request timing for the Server-Timing header: how long a request's git
 * commands took in total, and how long the whole request took. Git calls
 * happen deep inside stack and diff loading, so the current request is
 * found through AsyncLocalStorage instead of being passed down.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage();

/** Runs `fn` as one request, timing what it does. */
export function timeRequest(fn) {
  return requests.run({ started: performance.now(), gitMs: 0, gitCalls: 0, diffCache: null }, fn);
}

/** Notes whether the request's diff came from the cache. */
export function recordCache(hit) {
  const timing = requests.getStore();
  if (timing) timing.diffCache = hit ? "hit" : "miss";
}

/** Adds a finished git command's duration to the current request, if there is one. */
export function recordGit(ms) {
  const timing = requests.getStore();
  if (!timing) return;
  timing.gitMs += ms;
  timing.gitCalls++;
}

/**
 * The current request's Server-Timing header value, or null outside a
 * request. `git` sums every git command's duration, so it can exceed
 * `total` when commands ran at the same time.
 */
export function serverTiming() {
  const timing = requests.getStore();
  if (!timing) return null;
  const total = performance.now() - timing.started;
  const calls = `${timing.gitCalls} git ${timing.gitCalls === 1 ? "call" : "calls"}`;
  const cache = timing.diffCache ? `, diff-cache;desc="${timing.diffCache}"` : "";
  return `git;dur=${timing.gitMs.toFixed(1)};desc="${calls}", total;dur=${total.toFixed(1)}${cache}`;
}
