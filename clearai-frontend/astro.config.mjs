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

  // CSP is enforced via the HTTP response header configured in
  // public/staticwebapp.config.json (NOT via a <meta> tag emitted
  // here). The static-host header is the single source of truth.
  //
  // Astro's `csp: { algorithm: 'SHA-256' }` was tried previously but
  // didn't emit a <meta http-equiv="Content-Security-Policy"> on
  // 6.1.10 (verified by inspecting dist/index.html), and even if it
  // had, the browser intersects HTTP-header CSP with <meta> CSP — a
  // <meta> tag can only TIGHTEN, never loosen. So the only working
  // path for our static-deploy setup is to list every inline-script
  // SHA-256 directly in staticwebapp.config.json's script-src.
  //
  // The 3 inline scripts Astro emits are:
  //   1. lang detection IIFE (src/layouts/Layout.astro <head>)
  //   2. Astro hydration loader (window.Astro.load)
  //   3. astro-island custom-element definition
  // Their hashes are pinned in staticwebapp.config.json.
});
