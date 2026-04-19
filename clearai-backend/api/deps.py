"""FastAPI dependencies.

Holds the singletons the router needs — HSResolver (owns DB + FAISS + reasoner)
and the reasoner itself (exposed separately so endpoints can call
build_justification without going through the resolver).

Lifespan management: the resolver is built once at app startup and torn down
at shutdown. This mirrors the CLI's `with HSResolver(...) as r:` idiom.
Uvicorn workers get their own instance per process, so the SQLite connection
isn't shared across threads (sqlite3 default policy).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request

from clearai.adapters import AnthropicReasoner
from clearai.ports.reasoner import HSReasoner
from clearai.services.hs_resolver import HSResolver

logger = logging.getLogger("clearai.api.deps")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Instantiate resolver + reasoner once per worker process.

    FastAPI's `Depends(get_resolver)` reads them off `app.state` so route
    handlers don't carry plumbing noise.
    """
    logger.info("lifespan: building reasoner + resolver")
    reasoner: HSReasoner = AnthropicReasoner()
    resolver = HSResolver(reasoner=reasoner)
    # Open the SQLite connection + pre-load FAISS right away so the first
    # real request doesn't eat the cold-start cost.
    resolver.__enter__()
    app.state.reasoner = reasoner
    app.state.resolver = resolver
    logger.info("lifespan: ready")
    try:
        yield
    finally:
        logger.info("lifespan: closing resolver")
        resolver.__exit__(None, None, None)


def get_resolver(request: Request) -> HSResolver:
    return request.app.state.resolver  # type: ignore[no-any-return]


def get_reasoner(request: Request) -> HSReasoner:
    return request.app.state.reasoner  # type: ignore[no-any-return]
