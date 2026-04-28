// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ClearAI Frontend v2 — sibling rebuild alongside v1.
// v1 runs on :5173 (or :5175). v2 runs on :5180 so both can run locally.
// Static output only (no SSR) — deploys to Azure Static Web Apps or
// Cloudflare Pages once v2 reaches feature-parity with v1.
//
// Backend target: https://apim-infp-clearai-be-dev-gwc-01.azure-api.net
// Swap PUBLIC_CLEARAI_API_BASE env var to point at the deployed APIM endpoint.
export default defineConfig({
  site: 'http://localhost:5180',
  server: { port: 5180, host: true },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
