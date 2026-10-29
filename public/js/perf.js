/** With ?perf in the URL, each load reports where its time went: in the console, and in window.diffviewPerf. */
import { toast } from "./state.js";

const PERF = new URLSearchParams(location.search).has("perf");
globalThis.diffviewPerf = { loads: [] };

/**
 * Reports a load that started at `started` (performance.now()): every API
 * request since, with the server's total and git time from its
 * Server-Timing header, and the time spent rendering diffs.
 */
export function reportLoad(label, started) {
  if (!PERF) return;
  const serverMs = (entry, name) => Math.round(entry.serverTiming?.find((t) => t.name === name)?.duration ?? 0);
  const rows = performance
    .getEntriesByType("resource")
    .filter((r) => r.startTime >= started && r.name.includes("/api/"))
    .map((r) => ({ request: new URL(r.name).pathname, ms: Math.round(r.duration), serverMs: serverMs(r, "total"), gitMs: serverMs(r, "git") }));
  for (const m of performance.getEntriesByName("diffview:render-files", "measure").filter((m) => m.startTime >= started)) {
    rows.push({ request: "render files", ms: Math.round(m.duration), serverMs: 0, gitMs: 0 });
  }
  const totalMs = Math.round(performance.now() - started);
  globalThis.diffviewPerf.loads.push({ label, totalMs, rows });
  console.log(`diffview: ${label} in ${totalMs} ms`);
  console.table(rows);
  toast(`${label} in ${totalMs} ms (see the console)`);
}
