"""
batch_row_policy.py — row-level input hygiene for the batch XML pipeline.

Centralizes the "missing or suspect data" rules so the CLI + future REST
endpoint + unit tests all share one definition. Each policy function returns
a `(value, flag)` pair; the CLI accumulates flags into `review.csv`.

Session 1 policies:

  - country_of_manufacture: null/empty → "XX" placeholder + flag
    "missing_country_of_origin". The merchant fixes the flagged rows in
    Excel and re-uploads only those.

Why the builder doesn't embed this:
  The XML builder is a pure renderer — given `DeclarationItem(country="XX")`
  it emits `<countryOfOrigin>XX</countryOfOrigin>` unconditionally. Policy
  (what to do when input is missing) lives here so the renderer stays
  deterministic and reusable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ---------------------------------------------------------------------------
# Flag codes — kept as short strings so they sort nicely in review.csv and
# a human operator can grep for one.
# ---------------------------------------------------------------------------
FLAG_MISSING_COUNTRY = "missing_country_of_origin"
FLAG_LOW_CONFIDENCE_HS = "low_confidence_hs"
FLAG_RESOLVER_FAILED = "resolver_failed"
FLAG_NO_ARABIC_DESCRIPTION = "no_arabic_description"

# Placeholder used in XML when country is unknown. ISO 3166 reserves
# codes starting with X for user-assigned use — "XX" is the conventional
# "unknown origin" marker in customs systems, including SaudiEDI.
UNKNOWN_COUNTRY = "XX"


@dataclass(frozen=True)
class PolicyResult:
    """Outcome of applying one policy. Flags are additive — a single row
    can accumulate multiple flags as it moves through the pipeline."""

    value: str
    flag: str | None = None   # None if the value was acceptable as-is


def resolve_country_of_manufacture(raw: Any) -> PolicyResult:
    """Normalize CountryofManufacture.

    Rules:
      - Empty, None, or whitespace-only  → ("XX", FLAG_MISSING_COUNTRY)
      - Any non-empty value              → (value.strip().upper(), None)

    We upper-case ISO-2 codes because downstream SaudiEDI ingress is
    case-sensitive (sample uses "US", "GB"). We do NOT validate that the
    value is a valid ISO-2 code; that's a heavier check worth adding in
    a later session once we have the ZATCA country-code allowlist.
    """
    if raw is None:
        return PolicyResult(UNKNOWN_COUNTRY, FLAG_MISSING_COUNTRY)
    s = str(raw).strip()
    if not s or s.lower() in {"nan", "none", "null"}:
        return PolicyResult(UNKNOWN_COUNTRY, FLAG_MISSING_COUNTRY)
    return PolicyResult(s.upper(), None)
