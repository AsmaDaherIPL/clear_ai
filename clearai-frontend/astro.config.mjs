// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ClearAI frontend — Astro + React island, deploys to Cloudflare Pages.
// Dev server on :3000 to match the backend's default CORS allowlist
// (see clearai-backend/api/main.py _DEFAULT_ORIGINS).
export default defineConfig({
  site: 'https://clearai-frontend.pages.dev',
  server: { port: 3000, host: true },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
