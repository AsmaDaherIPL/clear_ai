# Architecture Decision Records

This directory holds ClearAI's accepted architectural decisions. An ADR
captures a decision that is durable, expensive to reverse, and material
enough that a future maintainer needs to understand the *why* before
proposing a change.

## How to read these

- Each ADR is self-contained. Read the one(s) relevant to your task
  before editing the code under their scope.
- "Status" is the source of truth. `accepted` decisions bind. `pending`
  means drafted but not yet ratified. `superseded by NNNN` means
  consult the newer ADR — but the older one explains the original
  reasoning, which is often still useful.
- The `Revisit triggers` section names the conditions under which the
  decision should be re-opened. If you encounter one of those triggers,
  open a new ADR rather than editing the old one.

## How to add a new one

1. Pick the next free number. Filenames are
   `NNNN-kebab-case-title.md`.
2. Use the structure of an existing ADR: Status, Scope, Owner,
   Context, Decision, Consequences (locks in / frees up / trades away),
   What this rules out, Revisit triggers, Memory pointer.
3. Add a row to the index below.
4. If the decision changes day-to-day behaviour, add or update a
   memory pointer at `~/.claude/projects/.../memory/`.

## Index

| # | Title | Status | Scope |
|---|---|---|---|
| [0001](0001-foundry-only-anthropic-access.md) | Anthropic API access is via Azure AI Foundry only | accepted, 2026-05-04 | backend LLM calls |
| [0002](0002-tenants-as-data-not-code.md) | Tenant configuration is data, not code | accepted, 2026-05-04 | backend tenants module |
| [0003](0003-two-phase-batch-processing.md) | Two-phase batch processing with mode default | accepted, 2026-05-04 | backend batches module |
| [0004](0004-uniform-scrutiny-pipeline.md) | Every classification path goes through the same scrutiny pipeline | accepted, 2026-05-05 | dispatch + hs-classification + batches |
| [0005](0005-embedder-is-swappable.md) | The embedder is a swappable component, not a baked-in dependency | accepted, 2026-05-05 | inference/embeddings + inference/retrieval |
| 0006 | Two-track classification with reconciliation | drafting | pipeline / dispatch |
| [0007](0007-pipeline-shaped-folder-structure.md) | Backend folder structure follows the classification pipeline stages | accepted, 2026-05-05 | clearai-backend/src/ |

## Companion notes

- [folder-structure.md](folder-structure.md) — backend folder layout
  reference. Not numbered because it documents an emergent structure
  rather than a single decision; updated as modules land.

## Related external rules

These live in user/global memory and are referenced by ADRs above:

- `rule_azure_only_identity` — Microsoft Entra is the only IdP.
- `project_anthropic_via_foundry_only` — referenced by ADR-0001.
- `project_zatca_two_step_flow` — referenced by ADR-0003.
- `project_embedder_swap_candidate` — referenced by ADR-0005.
