/**
 * Builds the browser bundle of Pierre's diff and file-tree components into
 * public/vendor/, which git ignores. Their packages import each other and
 * Shiki by bare name, which a browser cannot resolve, so esbuild bundles
 * them, splitting each Shiki language and theme into a chunk the page loads
 * only when a file needs it. It takes under a second, so the server just
 * rebuilds whenever the bundle is older than its inputs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "public", "js", "vendor-entry.js");
export const VENDOR_DIR = path.join(ROOT, "public", "vendor");
const BUNDLE = path.join(VENDOR_DIR, "pierre.js");
const INPUTS = [ENTRY, path.join(ROOT, "package-lock.json")];

function mtime(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** Builds the bundle unless it is newer than every input. */
export async function ensureVendorBundle() {
  const built = mtime(BUNDLE);
  if (built && INPUTS.every((input) => mtime(input) <= built)) return;
  const esbuild = await import("esbuild");
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: { pierre: ENTRY },
    bundle: true,
    format: "esm",
    splitting: true,
    minify: true,
    outdir: VENDOR_DIR,
    logLevel: "warning",
  });
}
