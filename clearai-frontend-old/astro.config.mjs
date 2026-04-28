// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ClearAI frontend — Astro + React island, deploys to Azure Static Web Apps.
// Dev server on :5173 (Vite default) so the local Fastify backend can keep
// :3000 — matching its deployed Container App port (which Azure ingress
// fronts on 443 in prod). Backend dev URL: http://localhost:3000.
export default defineConfig({
  site: 'https://yellow-glacier-05e43ee03.7.azurestaticapps.net',
  server: { port: 5173, host: true },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
