// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ClearAI Frontend — Astro static SPA, deploys to Azure Static Web Apps.
// Listens on :5180 in dev. Static output only (no SSR).
//
// Backend access: the SPA holds an MSAL.js (Authorization Code + PKCE)
// access token and calls APIM directly at PUBLIC_APIM_BASE_URL. There is
// no /api/* path on the SWA origin — the previous SWA-managed-Function
// BFF (clearai-frontend/api/clearaiProxy.ts) was removed on 2026-05-07.
// To run the SPA against a local backend, set PUBLIC_APIM_BASE_URL=
// http://localhost:3000 in clearai-frontend/.env (no Vite proxy needed).

export default defineConfig({
  site: 'http://localhost:5180',
  server: { port: 5180, host: true },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
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
