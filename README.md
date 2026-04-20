# ClearAI

Resolves merchant invoice line items into precise 12-digit Saudi ZATCA HS codes.
 This repo is a monorepo split into three deployable apps plus a CI pipeline.

## Repo layout

### `.github/workflows/`
GitHub Actions. Holds the Cloudflare deploy workflow (`deploy.yml`) that auto-ships
the wiki (and later the frontend) to Cloudflare Pages on every push to `main`.

### `clearai-wiki/`
The public documentation site. Static docs + architecture notes, deployed to
Cloudflare Pages. This is what end-users and reviewers read to understand the
system.

### `clearai-frontend/`
The classification UI — an Astro + React island styled with Tailwind. Talks to
the backend API (`:8787`) and renders the HS code, 7-section justification,
and FAISS evidence table. Deploys to Cloudflare Pages.

### `clearai-backend/`
The Python brain. Hexagonal architecture: `clearai/` is the core (domain,
ports, adapters, services, parsing, rendering, data setup), with `api/` exposing
a FastAPI surface, `cli/` for batch scripts, `tests/` for the test pyramid, and
`tracker/` holding the ADRs, build progress, and architecture rules enforced
by import-linter.

---

See each subfolder's own `README.md` for setup + run commands.
