// Post-build Subresource Integrity (SRI) injector.
//
// Why: Astro emits content-hashed filenames (e.g. `ClassifyApp.neQ1uio1.js`)
// for cache-busting, but does NOT pin the file contents in the HTML via
// `integrity=` attributes. If someone with write access to the static host
// swaps a bundle file in place, the browser happily runs the substituted
// script. Adding SRI converts that compromise from immediate-script-execution
// to a hard browser error.
//
// What this does (called automatically by `pnpm build`):
//   1. Walks every HTML file under `dist/`
//   2. For each `<script src="/_astro/...">` and `<link rel="stylesheet"
//      href="/_astro/...">` tag found, reads the referenced file off disk
//      and computes a SHA-384 base64 digest
//   3. Rewrites the tag to include `integrity="sha384-..."` and
//      `crossorigin="anonymous"`
//   4. Leaves third-party / external URLs alone
//
// SHA-384 chosen because it's the SRI spec's recommended algorithm and what
// most tooling defaults to. SHA-256 is also accepted by browsers.
//
// Idempotent — running it twice produces the same output (existing
// `integrity=` attributes are overwritten with a freshly-computed value, so
// CI re-runs are safe).

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, stat } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

/** Recursively yield every regular file path under `root`. */
async function* walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

const fileHashCache = new Map();
async function sha384Base64(absPath) {
  if (fileHashCache.has(absPath)) return fileHashCache.get(absPath);
  const buf = await readFile(absPath);
  const digest = createHash('sha384').update(buf).digest('base64');
  fileHashCache.set(absPath, digest);
  return digest;
}

/** Map a `/foo/bar.js` URL path from HTML back to a `dist/foo/bar.js` path. */
function urlToDistPath(urlPath) {
  // Leading slash is required — relative refs aren't supported in this build.
  if (!urlPath.startsWith('/')) return null;
  return join(DIST, urlPath.replace(/^\//, ''));
}

// Two regexes — one for <script src=>, one for <link rel=stylesheet href=>.
// Tolerates attribute ordering: `src` may come before or after other attrs.
// Both are non-greedy and bounded so they don't accidentally swallow a
// trailing `<script>` block.
const SCRIPT_RE = /<script\b([^>]*?)\bsrc=("([^"]+)"|'([^']+)')([^>]*)>/g;
const LINK_RE = /<link\b([^>]*?)\brel=("stylesheet"|'stylesheet')([^>]*?)\bhref=("([^"]+)"|'([^']+)')([^>]*)>/g;

function stripExistingIntegrity(attrs) {
  return attrs
    .replace(/\s+integrity=("([^"]*)"|'([^']*)')/g, '')
    .replace(/\s+crossorigin=("([^"]*)"|'([^']*)')/g, '');
}

async function patchHtml(htmlPath) {
  let html = await readFile(htmlPath, 'utf8');
  let touched = 0;

  // ---- <script src=> ----
  // For each match, work out the target dist file. If it lives under dist/
  // we can hash it and inject integrity. External URLs (http://, https://)
  // are left alone — SRI is technically valid for cross-origin scripts too,
  // but we don't have a way to know the upstream hash here, and the SPA
  // doesn't actually load any external scripts at the moment.
  const scriptMatches = [...html.matchAll(SCRIPT_RE)];
  for (const m of scriptMatches.reverse()) {
    const [full, beforeSrc, , dq, sq, afterSrc] = m;
    const src = dq ?? sq;
    if (!src) continue;
    if (/^https?:\/\//i.test(src)) continue; // external, skip
    const distPath = urlToDistPath(src);
    if (!distPath) continue;
    let hash;
    try { hash = await sha384Base64(distPath); }
    catch { continue; } // file missing — leave tag as-is, fail loud at runtime
    const cleanBefore = stripExistingIntegrity(beforeSrc);
    const cleanAfter = stripExistingIntegrity(afterSrc);
    const replacement =
      `<script${cleanBefore} src="${src}"${cleanAfter} integrity="sha384-${hash}" crossorigin="anonymous">`;
    html = html.slice(0, m.index) + replacement + html.slice(m.index + full.length);
    touched++;
  }

  // ---- <link rel="stylesheet" href=> ----
  const linkMatches = [...html.matchAll(LINK_RE)];
  for (const m of linkMatches.reverse()) {
    const [full, beforeRel, , betweenRelHref, , dq, sq, afterHref] = m;
    const href = dq ?? sq;
    if (!href) continue;
    if (/^https?:\/\//i.test(href)) continue;
    const distPath = urlToDistPath(href);
    if (!distPath) continue;
    let hash;
    try { hash = await sha384Base64(distPath); }
    catch { continue; }
    const cleanBefore = stripExistingIntegrity(beforeRel);
    const cleanBetween = stripExistingIntegrity(betweenRelHref);
    const cleanAfter = stripExistingIntegrity(afterHref);
    const replacement =
      `<link${cleanBefore} rel="stylesheet"${cleanBetween} href="${href}"${cleanAfter} integrity="sha384-${hash}" crossorigin="anonymous">`;
    html = html.slice(0, m.index) + replacement + html.slice(m.index + full.length);
    touched++;
  }

  if (touched > 0) {
    await writeFile(htmlPath, html, 'utf8');
  }
  return touched;
}

async function main() {
  try {
    await stat(DIST);
  } catch {
    console.error(`[sri] dist/ not found at ${DIST}. Did \`astro build\` succeed?`);
    process.exit(1);
  }

  let htmlCount = 0;
  let tagCount = 0;
  for await (const p of walk(DIST)) {
    if (!p.endsWith('.html')) continue;
    const touched = await patchHtml(p);
    if (touched > 0) {
      htmlCount++;
      tagCount += touched;
      const rel = p.slice(DIST.length + 1);
      console.log(`[sri] ${rel}: ${touched} tag${touched === 1 ? '' : 's'}`);
    }
  }
  console.log(`[sri] done. ${tagCount} integrity attribute${tagCount === 1 ? '' : 's'} added across ${htmlCount} HTML file${htmlCount === 1 ? '' : 's'}.`);
}

await main();
