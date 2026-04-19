"""ClearAI — HS code resolution pipeline for Saudi customs (ZATCA Bayan XML).

Package layout (hexagonal):

    clearai.domain       — pure types, no I/O
    clearai.ports        — abstract interfaces (HSReasoner, …)
    clearai.adapters     — concrete implementations of ports (Anthropic, …)
    clearai.services     — orchestration (resolver, lookup, arabic translation)
    clearai.parsing      — invoice intake
    clearai.rendering    — XML / output builders (stub until Phase 3)
    clearai.data_setup   — one-time DB + FAISS build scripts

Import direction is strictly inward: api/ and cli/ (outside this package)
import from clearai; clearai never imports from api or cli.
"""
