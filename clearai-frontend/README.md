# clearai-frontend

The classification UI for ClearAI — an Astro site with a single React
island that talks to the **Fastify backend** in `../clearai-backend/`.

Deploys to Cloudflare Pages as a static build.

## Stack

- **Astro 6** — static shell, islands architecture
- **React 19** — the `ClassifyApp` island (form + result)
- **Tailwind 4** — via `@tailwindcss/vite`
- **TypeScript** — strict; contract types hand-mirrored from
  `clearai-backend/src/decision/types.ts` and `src/routes/*.ts` in
  `src/lib/api.ts`

## Endpoints we hit

| Mode | Endpoint | Backend route |
|---|---|---|
| Generate | `POST /classify/describe` | `clearai-backend/src/routes/describe.ts` |
| Expand   | `POST /classify/expand`   | `clearai-backend/src/routes/expand.ts` |
| Boost    | `POST /boost`             | `clearai-backend/src/routes/boost.ts` |

The batch lane is **not** wired in v1 — the Fastify backend has no
`/api/batch/*` endpoints yet. When that lands we'll re-add the lane
switch + batch UI from git history (commit before this rewrite).

## Dev

Backend must be up first on port 3000 (its default and prod port):

```sh
# terminal 1 — backend
cd ../clearai-backend && pnpm dev      # http://localhost:3000

# terminal 2 — frontend
npm install
npm run dev                            # http://localhost:5173
```

CORS is configured server-side to allow `http://localhost:5173` by default
(see `clearai-backend/src/config/env.ts` → `CORS_ORIGINS`). Override
`CORS_ORIGINS` in the backend's `.env` for prod.

## Env

| Var | Default | Notes |
|---|---|---|
| `PUBLIC_CLEARAI_API_BASE` | `http://localhost:3000` | Browser-exposed (Astro `PUBLIC_` prefix). Set to the Container App FQDN in prod. |

## Project layout

```
src/
├── layouts/Layout.astro          # root layout, font preload
├── pages/index.astro             # mounts ClassifyWorkbench
├── lib/api.ts                    # typed API client (single source of truth for the contract)
└── components/
    ├── ClassifyWorkbench.tsx     # passthrough wrapper
    ├── ClassifyApp.tsx           # the React island — owns mode, inputs, dispatch, render
    ├── ModeTabs.tsx              # generate / expand / boost
    ├── InputCard.tsx             # mode-aware input surface
    ├── HSResultCard.tsx          # accepted-decision result + segmented 12-digit code
    ├── AlternativesCard.tsx      # shortlist with retrieval scores
    ├── MetaPanel.tsx             # dev-view: model + round-trip
    ├── Pipeline.tsx              # cosmetic 6-stage progress animation
    ├── Suggestions.tsx           # preset descriptions for Generate
    ├── TopBar.tsx / Hero.tsx / Footer.tsx
    └── styles/global.css
```

## Design system

See `src/styles/global.css`. Parchment palette (warm neutrals), Najdi
green accent, amber stamp for HS codes. Typography: Fraunces (display),
JetBrains Mono (code), IBM Plex Sans Arabic (RTL). Deliberately avoids
generic AI-slop defaults (Inter, Roboto, purple gradients).

## Build & deploy

```sh
npm run build       # → dist/
```

Cloudflare Pages config:
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `clearai-frontend`
- Env var: `PUBLIC_CLEARAI_API_BASE` → your prod Container App URL
  (e.g. `https://ca-infp-clearai-be-dev-gwc-01.<env-hash>.<region>.azurecontainerapps.io`)
