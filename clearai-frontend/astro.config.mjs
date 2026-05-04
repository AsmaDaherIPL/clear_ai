// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ClearAI Frontend v2 — sibling rebuild alongside v1.
// v1 runs on :5173 (or :5175). v2 runs on :5180 so both can run locally.
// Static output only (no SSR) — deploys to Azure Static Web Apps.
//
// Backend target: same-origin /api/* (SWA managed Function BFF) →
// https://apim-infp-clearai-be-dev-gwc-01.azure-api.net (server-side fetch).
// The browser never speaks to APIM directly anymore — the BFF holds the
// Entra client-credentials secret + APIM subscription key. See ADR and
// docs/SECURITY-REMEDIATION-PLAN.md §1 for the architecture.
// Local dev proxy target. Defaults to the local Fastify backend on :3000.
// Override with CLEARAI_DEV_API_TARGET if you want to point at a remote
// backend (e.g. a preview deployment). Production is unaffected — the
// `vite.server.proxy` block ONLY runs during `astro dev`; `astro build`
// (what SWA's CI runs) ignores it entirely.
//
// Why this exists: in production the SPA's /api/* lands on the SWA
// managed-function BFF (clearai-frontend/api/clearaiProxy.ts) which adds
// Entra Bearer auth and forwards to APIM. In dev, that BFF needs Entra
// credentials we don't bootstrap until Phase 1 lands — so for local
// testing we skip the BFF entirely and proxy /api/* straight to a local
// Fastify backend that bypasses auth via NODE_ENV=development.
//
// This proxy:
//   - Server-side only (Vite dev), zero JS-bundle exposure
//   - Strips /api prefix so the Fastify routes (mounted at root) match
//   - Adds an x-apim-shared-secret header IF set, otherwise omits — local
//     Fastify only enforces the header in production mode
const DEV_API_TARGET = process.env.CLEARAI_DEV_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  site: 'http://localhost:5180',
  server: { port: 5180, host: true },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // Dev-only: forward /api/* to the local backend.
    server: {
      proxy: {
        '/api': {
          target: DEV_API_TARGET,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  },

  // CSP nonce injection.
  //
  // Astro emits a small set of inline <script> blocks (Astro hydration
  // runtime, language switcher). Strict CSP (no 'unsafe-inline') would
  // block them unless we explicitly allow each one. `experimental.csp`
  // automates that: every inline script gets a per-build nonce, the
  // emitted <meta http-equiv="Content-Security-Policy"> includes the
  // matching `'nonce-...'` source, and external scripts loaded from
  // /_astro get pinned by integrity hash. The page-level CSP overrides
  // staticwebapp.config.json's `script-src 'self'` with `script-src
  // 'self' 'nonce-...' 'sha256-...'` so the static-host header is the
  // floor and Astro tightens it per page.
  //
  // Rationale per finding: frontend security review H2 (no CSP) and M3
  // (no SRI on script/link). Astro 4.7 shipped this under `experimental.csp`;
  // it graduated to a top-level `csp` option in Astro 6.x — moved out of
  // `experimental` here so the config validator on 6.1.10 stops rejecting
  // the dev server boot.
  csp: {
    algorithm: 'SHA-256',
  },
});
