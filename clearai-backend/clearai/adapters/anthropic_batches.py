"""
anthropic_batches.py — pseudo-batch wrapper that loops sync Messages calls.

Originally a wrapper over Anthropic's Message Batches API (`/v1/messages/batches`),
which delivers ~50% cost savings but is NOT forwarded by Azure AI Foundry's
Anthropic-compatible endpoint (404 api_not_supported). Since the project's
default deployment target is Foundry → Claude (sync only), this module now
runs a **sequential loop over the sync `/v1/messages` endpoint** that every
Anthropic-compatible provider (direct, Azure, Bedrock, Vertex) supports.

Trade-offs (accepted explicitly):
  - No async SLA: results are computed during submit() and stored in-memory.
    Returned "batch id" is a local token; status() reports `ended` immediately.
  - No 50% batch discount.
  - Hard row cap (`MAX_BATCH_ROWS`, default 10) — keeps per-submission
    latency bounded and protects against accidental thousand-row uploads
    while Claude-on-Foundry is the only path.

Public surface (unchanged from the original Batches wrapper) — so the
orchestrator, tests, and endpoints keep working without churn:

    submit(requests) → batch_id
    status(batch_id) → BatchStatus
    fetch_results(batch_id) → Iterator[BatchResultItem]

Live test mode: `CLEARAI_BATCH_DRY=1` short-circuits real API calls and
echoes a canned stub response per request.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Iterable, Iterator

from anthropic import Anthropic, APIError

from clearai import config

logger = logging.getLogger("clearai.anthropic_batches")

# Hard cap on rows per submission. The sync loop is serial, so each additional
# row adds ~Sonnet latency to the end-user's wait — 10 keeps total runtime
# under ~1-2 minutes on a warm Foundry deployment. Bump deliberately when
# the provider supports async batches.
MAX_BATCH_ROWS = 10


# ---------------------------------------------------------------------------
# Dataclasses — lightweight, typed surface for callers
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class BatchRequest:
    """One row's request payload. `custom_id` ties the result back to the
    caller's row index. `params` is the raw Messages API payload."""
    custom_id: str
    params: dict[str, Any]


@dataclass(frozen=True)
class BatchResultItem:
    """One row's decoded result. Exactly one of `text` / `error` is populated."""
    custom_id: str
    text: str | None               # assistant's text content, joined
    stop_reason: str | None
    tokens_in: int
    tokens_out: int
    error: str | None              # None when succeeded


@dataclass(frozen=True)
class BatchStatus:
    """Snapshot of a running batch. Terminal when `ended_at` is set."""
    id: str
    processing_status: str         # in_progress | ended | canceling | ...
    request_counts: dict[str, int] # processing / succeeded / errored / canceled / expired
    ended_at: str | None
    results_url: str | None


# ---------------------------------------------------------------------------
# Wrapper
# ---------------------------------------------------------------------------
class AnthropicBatches:
    """Pseudo-batch adapter: loops sync `/v1/messages` calls.

    Public surface is unchanged from the original Batches API wrapper so the
    orchestrator, routes, and tests keep working. Internally, `submit()` now
    does the work synchronously — it fires one sync Messages call per row,
    stashes decoded results in an in-memory store, and returns a local batch
    id. `status()` immediately reports `ended`; `fetch_results()` streams
    from the store.

    Ops pattern (unchanged):

        ab = AnthropicBatches()
        batch_id = ab.submit(requests=[BatchRequest(...), ...])
        while ab.status(batch_id).processing_status != "ended":
            time.sleep(30)
        for item in ab.fetch_results(batch_id):
            handle(item)

    With the sync-loop implementation, `submit()` already blocks until all
    rows are classified, so the outer poll loop terminates on its first
    iteration. No caller change required.
    """

    def __init__(self, client: Anthropic | None = None) -> None:
        if client is not None:
            self._client = client
        else:
            client_kwargs: dict[str, str] = {"api_key": config.ANTHROPIC_API_KEY}
            # Honour the project-wide Foundry/Anthropic base-URL toggle —
            # same semantics as AnthropicReasoner.__init__.
            if config.ANTHROPIC_BASE_URL:
                client_kwargs["base_url"] = config.ANTHROPIC_BASE_URL
                logger.info(
                    "AnthropicBatches: using custom base_url=%s",
                    config.ANTHROPIC_BASE_URL,
                )
            self._client = Anthropic(**client_kwargs)
        self._dry_run = os.getenv("CLEARAI_BATCH_DRY", "").strip() == "1"
        if self._dry_run:
            logger.warning(
                "AnthropicBatches: CLEARAI_BATCH_DRY=1 → no real API calls."
            )

    # -----------------------------------------------------------------------
    # submit — sync loop, computes all results upfront
    # -----------------------------------------------------------------------
    def submit(self, requests: Iterable[BatchRequest]) -> str:
        """Run all requests synchronously via `/v1/messages` and store the
        decoded items under a local batch id.

        Why a local id: Azure AI Foundry does NOT forward
        `/v1/messages/batches`. Rather than juggle two code paths, we emulate
        the async surface by computing results immediately and serving them
        from memory — callers keep using the same submit/status/fetch_results
        interface.

        Hard-capped at MAX_BATCH_ROWS (default 10). Over-cap submissions
        raise ValueError to protect the user from accidentally kicking off a
        multi-minute sync loop on a 1000-row file.
        """
        reqs = list(requests)
        if not reqs:
            raise ValueError("submit: at least one request required")
        if len(reqs) > MAX_BATCH_ROWS:
            raise ValueError(
                f"submit: {len(reqs)} rows exceeds MAX_BATCH_ROWS={MAX_BATCH_ROWS}. "
                "The batch lane currently runs sync calls in a loop — until the "
                "provider exposes an async Batches API, keep uploads small."
            )

        fake_id = f"msgbatch_sync_{int(time.time())}_{id(reqs) & 0xFFFF:04x}"

        if self._dry_run:
            # Pre-compute canned responses so fetch_results can yield them.
            self._results_store[fake_id] = [_dry_result_for(r) for r in reqs]
            logger.info("[dry] submit: %d request(s) → %s", len(reqs), fake_id)
            return fake_id

        # Real path: loop sync calls. Each row is independent — a failure on
        # one row becomes a BatchResultItem(error=...) so the orchestrator
        # still produces XMLs for the successes.
        items: list[BatchResultItem] = []
        t0 = time.perf_counter()
        for i, r in enumerate(reqs, start=1):
            item = self._call_one_sync(r)
            items.append(item)
            logger.info(
                "sync_loop: %d/%d custom_id=%s ok=%s",
                i, len(reqs), r.custom_id, item.error is None,
            )
        dur_s = time.perf_counter() - t0
        self._results_store[fake_id] = items
        logger.info(
            "submit: %d request(s) via sync loop in %.1fs → %s",
            len(reqs), dur_s, fake_id,
        )
        return fake_id

    def _call_one_sync(self, req: BatchRequest) -> BatchResultItem:
        """Single `/v1/messages` call → BatchResultItem. Catches APIError so
        one bad row doesn't abort the whole "batch"."""
        params = dict(req.params)  # shallow copy; don't mutate caller's dict
        try:
            resp = self._client.messages.create(**params)
        except APIError as e:
            logger.warning("sync_loop: %s failed: %s", req.custom_id, e)
            return BatchResultItem(
                custom_id=req.custom_id, text=None, stop_reason=None,
                tokens_in=0, tokens_out=0, error=f"APIError: {e}",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "sync_loop: %s unexpected error: %s", req.custom_id, e,
            )
            return BatchResultItem(
                custom_id=req.custom_id, text=None, stop_reason=None,
                tokens_in=0, tokens_out=0, error=f"{type(e).__name__}: {e}",
            )

        text_parts: list[str] = []
        for block in getattr(resp, "content", None) or []:
            if getattr(block, "type", None) == "text":
                text_parts.append(block.text)
        usage = getattr(resp, "usage", None)
        return BatchResultItem(
            custom_id=req.custom_id,
            text="".join(text_parts) or None,
            stop_reason=getattr(resp, "stop_reason", None),
            tokens_in=int(getattr(usage, "input_tokens", 0) or 0) if usage else 0,
            tokens_out=int(getattr(usage, "output_tokens", 0) or 0) if usage else 0,
            error=None,
        )

    # -----------------------------------------------------------------------
    # status — always "ended" because submit() already did the work
    # -----------------------------------------------------------------------
    def status(self, batch_id: str) -> BatchStatus:
        items = self._results_store.get(batch_id, [])
        succeeded = sum(1 for i in items if i.error is None)
        errored = sum(1 for i in items if i.error is not None)
        return BatchStatus(
            id=batch_id,
            processing_status="ended",
            request_counts={
                "processing": 0,
                "succeeded": succeeded,
                "errored": errored,
                "canceled": 0,
                "expired": 0,
            },
            ended_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            results_url=f"memory://{batch_id}",
        )

    # -----------------------------------------------------------------------
    # fetch_results
    # -----------------------------------------------------------------------
    def fetch_results(self, batch_id: str) -> Iterator[BatchResultItem]:
        """Yield decoded result items previously computed by submit()."""
        for item in self._results_store.get(batch_id, []):
            yield item

    # -----------------------------------------------------------------------
    # In-memory result store — class-level so a single test can submit+fetch
    # cleanly. Dry-run and live paths both use it; the only difference is
    # where each item's `text` comes from (canned stub vs real Sonnet reply).
    # -----------------------------------------------------------------------
    _results_store: dict[str, list[BatchResultItem]] = {}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _dry_result_for(req: BatchRequest) -> BatchResultItem:
    """Canned success response for CLEARAI_BATCH_DRY=1 mode.

    Echoes a minimal-but-valid JSON payload that the orchestrator's parser
    can consume. Keeps wiring tests deterministic + free.
    """
    # Pull the user text out of the messages payload so the stub reflects the
    # input — easier to eyeball in logs.
    user_text = ""
    for m in req.params.get("messages", []):
        if m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                user_text = content[:80]
            elif isinstance(content, list) and content:
                first = content[0]
                if isinstance(first, dict):
                    user_text = str(first.get("text", ""))[:80]
            break
    fake_payload = {
        "hs_code": "000000000000",
        "arabic_description": "وصف تجريبي",
        "confidence": 0.5,
        "rationale": f"[dry-run] echoing: {user_text}",
    }
    return BatchResultItem(
        custom_id=req.custom_id,
        text=json.dumps(fake_payload, ensure_ascii=False),
        stop_reason="end_turn",
        tokens_in=0, tokens_out=0, error=None,
    )


# ---------------------------------------------------------------------------
# Prompt assembler — single place to build a row's Batches request
# ---------------------------------------------------------------------------
_SYSTEM_ROW = (
    "You are an expert Saudi customs HS classifier. For ONE product line, "
    "return a JSON object with keys `hs_code` (12 digits), "
    "`arabic_description` (ZATCA tariff-style Arabic), `confidence` (0-1), "
    "and `rationale` (one sentence). Respond only with the JSON object — "
    "no markdown, no prose."
)


def build_row_request(
    *,
    custom_id: str,
    description: str,
    declared_code: str = "",
    model: str | None = None,
    max_tokens: int = 512,
) -> BatchRequest:
    """Assemble a BatchRequest for resolving one Excel row.

    Intentionally minimal — this is the classify-only hot path. The rich
    justifier (7-section) is NOT used in batch mode: at ~1000 rows it would
    blow the token budget, and operators don't need it per-row — only for
    individual drill-down via /api/justify in the live UI.
    """
    user = (
        f"Declared code: {declared_code or 'N/A'}\n"
        f"Product description: {description}\n"
        "Return the JSON object now."
    )
    return BatchRequest(
        custom_id=custom_id,
        params={
            "model": model or config.REASONER_MODEL,
            "max_tokens": max_tokens,
            "system": _SYSTEM_ROW,
            "messages": [{"role": "user", "content": user}],
            "temperature": 0,
        },
    )
