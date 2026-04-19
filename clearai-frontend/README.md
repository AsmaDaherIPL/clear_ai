# clearai-frontend

The classification UI for ClearAI — an Astro site with a single React
island that talks to the FastAPI backend in `../clearai-backend/`.

Deploys to Cloudflare Pages as a static build.

## Stack

- **Astro 6** — static shell, islands architecture
- **React 19** — the `ClassifyApp` island (form + result)
- **Tailwind 4** — via `@tailwindcss/vite`
- **TypeScript** — strict, shared contract types hand-kept in sync
  with `clearai-backend/api/schemas.py`

## Dev

Backend must be up first (port 8787):

```sh
# terminal 1 — backend
cd ../clearai-backend && .venv/bin/uvicorn api.main:app --port 8787 --reload

# terminal 2 — frontend
npm install
npm run dev          # http://localhost:3000
```

The backend's default CORS allowlist already includes `localhost:3000`
(see `clearai-backend/api/main.py`), so no extra config needed.

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PUBLIC_CLEARAI_API_BASE` | `http://localhost:8787` | Browser-exposed (Astro `PUBLIC_` prefix). |

## Project layout

```
src/
├── layouts/Layout.astro        # root layout, font preload, parchment canvas
├── pages/index.astro           # homepage — mounts the ClassifyApp island
├── components/ClassifyApp.tsx  # the single React island (M8 scaffold)
├── lib/api.ts                  # typed API client → FastAPI backend
└── styles/global.css           # design tokens + Tailwind
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
- Env var: `PUBLIC_CLEARAI_API_BASE` → your prod backend URL
