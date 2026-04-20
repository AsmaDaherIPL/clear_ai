# ClearAI

Resolves merchant invoice line items into precise 12-digit Saudi ZATCA HS codes.
 This repo is a monorepo split into three deployable apps plus a CI pipeline.

## Repo layout

### `.github/workflows/`
GitHub Actions. Holds the Cloudflare deploy workflow (`deploy.yml`) that auto-ships
the wiki (and later the frontend) to Cloudflare Pages on every push to `main`.

### `clearai-wiki/`
App documentation site — static docs and architecture notes. Hosted on Cloudflare Pages and gated by Cloudflare Zero Trust Access, which puts an authentication wall in front of the site. Access is currently restricted to emails from the @ipl, @splonline, and @microsoft domains.
### `clearai-frontend/`
Lightweight demo UI for exercising the classifier end-to-end. Built on Astro + React, input is free-text product description or not complete HS code to the backend API and renders the returned HS code alongside its W justification. Deployed to Cloudflare Pages.


### `clearai-backend/`
The Python brain that does the actual classification work. The clearai/ package is the core engine — business logic, data access, and LLM integration. 
Around it sit the supporting services: api/ (a FastAPI server exposing the engine over HTTPs), tests/, and tracker/ (architecture decisions and build progress).

---

See each subfolder's own `README.md` for setup + run commands.
