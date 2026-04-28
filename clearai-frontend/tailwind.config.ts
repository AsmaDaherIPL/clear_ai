import type { Config } from 'tailwindcss';

// Tailwind v4 minimal config.
// Design tokens from the new landing page :root are exposed here so they
// can be used in Tailwind utility classes alongside global.css CSS variables.
// Logical CSS (ps-*, pe-*, ms-*, me-*, border-s, border-e, text-start,
// text-end) is built into Tailwind v4 by default — no plugin required.
const config: Config = {
  content: [
    './src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx,svelte,vue}',
  ],
  theme: {
    extend: {
      colors: {
        // Mirroring the design's CSS variables as Tailwind color tokens.
        // Use bg-[var(--bg)] or the token shorthand bg-clearai-bg.
        'clearai-bg': 'var(--bg)',
        'clearai-surface': 'var(--surface)',
        'clearai-ink': 'var(--ink)',
        'clearai-ink-2': 'var(--ink-2)',
        'clearai-ink-3': 'var(--ink-3)',
        'clearai-line': 'var(--line)',
        'clearai-line-2': 'var(--line-2)',
        'clearai-accent': 'var(--accent)',
        'clearai-accent-ink': 'var(--accent-ink)',
        'clearai-accent-soft': 'var(--accent-soft)',
      },
      borderRadius: {
        'clearai': 'var(--radius)',
        'clearai-lg': 'var(--radius-lg)',
      },
      boxShadow: {
        'clearai': 'var(--shadow)',
        'clearai-lift': 'var(--shadow-lift)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        'sans-arabic': ['IBM Plex Sans Arabic', 'IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
};

export default config;
