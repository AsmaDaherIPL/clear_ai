# ClearAI Frontend v2

Sibling rebuild on `feat/v2-shadcn-rebuild`. Lives in `clearai-frontend-v2/` alongside
the original `clearai-frontend/` (v1, still in production).

## Why this exists alongside v1

The new design (see `new landing page.html` in the repo root) introduces proper i18n/RTL
support, shadcn/ui primitives, self-hosted IBM Plex fonts, and a richer classification
result layout. Rather than modify v1 in place — risking the live Azure deployment —
this sibling folder lets the rebuild progress independently until it reaches feature
parity, at which point the deploy workflow is swapped to point at `clearai-frontend-v2/dist`.

## Stack

- **Astro 6** — static-site generator with island architecture
- **React 19** — for interactive islands (`client:load`)
- **Tailwind v4** — via `@tailwindcss/vite` plugin (no PostCSS required)
- **shadcn/ui** — initialized; add components on demand (`npx shadcn@latest add <name>`)
- **IBM Plex Sans + IBM Plex Sans Arabic + IBM Plex Mono** — self-hosted via `@fontsource`

## Locale strategy

Language is determined by a `lang` cookie (`en` | `ar`). Two mechanisms set it:

1. **`?lang=ar` query param** — sets the cookie for this and future visits.
   See `src/layouts/Layout.astro` lines 21-45 for the server-side logic.
2. **`LanguageToggle` button** — calls `setLocale()` in `src/lib/i18n.ts`, which
   writes the cookie and hot-flips `html[lang/dir]` without a page reload.

A pre-hydrate `<script is:inline>` (Layout.astro lines 72-82) re-reads the cookie
before any React island hydrates, preventing a left-to-right flash for Arabic users
when the statically-built HTML defaulted to `lang="en"`.

SEO: `<link rel="alternate" hreflang>` tags in the `<head>` signal the alternate language to search engines.

## Logical-CSS rule

See the comment block at the top of `src/styles/global.css`.

Never write `padding-left/right`, `margin-left/right`, `border-left/right`, or
`text-align: left/right`. Always use logical properties (`inline-start/end`) so RTL
works without per-locale overrides. In Tailwind: `ps-*`, `pe-*`, `ms-*`, `me-*`,
`border-s`, `border-e`, `text-start`, `text-end`.

## How to run

```bash
cd clearai-frontend-v2
npm install
npm run dev        # http://localhost:5180
```

v1 remains on port 5173-5175 so both can run simultaneously.

## How to add a shadcn component

```bash
npx shadcn@latest add button
npx shadcn@latest add dialog
# etc.
```

Generated files land in `src/components/ui/`.

## Backend wiring

`src/lib/api.ts` is ported verbatim from v1. It targets `http://localhost:3000` by
default; set `PUBLIC_CLEARAI_API_BASE` to point at the deployed APIM endpoint:

```
PUBLIC_CLEARAI_API_BASE=https://apim-infp-clearai-be-dev-gwc-01.azure-api.net
PUBLIC_CLEARAI_API_KEY=your-subscription-key
```

Components do not yet call the API — that wiring is the next step.

## What is next

1. **Component bodies** — each file in `src/components/` is a stub; implement the real
   layout and interactions component by component.
2. **API wiring** — connect `ClassifyApp.tsx`'s `handleSubmit` to `api.describe`,
   `api.expand`, and file-upload batch flow.
3. **shadcn components** — add `Dialog`, `Select`, `Toast`, `Tooltip` etc. as needed.
4. **Design CSS** — port the exact CSS from `new landing page.html` into Tailwind
   utility classes within each component.
5. **CORS update** — if hitting the deployed APIM from `localhost:5180`, the backend
   CORS allow-list needs `:5180` added alongside v1's origin.
6. **Deploy** — once feature-parity is reached, update the GitHub Actions workflow to
   build from `clearai-frontend-v2/` and deploy to Azure Static Web Apps or
   Cloudflare Pages.
