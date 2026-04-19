"""
ClearAI configuration.

Loads all settings from environment variables (with .env support) and validates
that required values are present. Fails fast at import time so downstream
modules can rely on config being valid.

V1 is API-only (Anthropic). No local inference. See tracker/ARCHITECTURE.md
ADR-004 for rationale. The axis of flexibility is per-task model tiering —
three tiers (Haiku for translation, Sonnet for ranking, Opus for reasoning) —
not API-vs-local.

Also exports BAYAN_CONSTANTS — the hardcoded values observed in Naqel's baseline
XMLs (see tracker/INSTRUCTIONS.md "Bayan XML schema" section).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------
# Load .env from the project root (same dir as this file) if present.
_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")


def _get(key: str, default: str | None = None, *, required: bool = False) -> str:
    """Read an env var with optional required/default semantics."""
    value = os.getenv(key, default)
    if required and (value is None or value == ""):
        raise RuntimeError(
            f"Config error: env var '{key}' is required but not set. "
            f"See .env.example for the full list."
        )
    return value or ""


def _get_float(key: str, default: float) -> float:
    raw = os.getenv(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as e:
        raise RuntimeError(f"Config error: env var '{key}' must be a number, got {raw!r}") from e


def _get_path(key: str, default: str) -> Path:
    raw = os.getenv(key, default)
    p = Path(raw)
    # Resolve relative paths against the project root, not the caller's cwd
    if not p.is_absolute():
        p = _PROJECT_ROOT / p
    return p


# ---------------------------------------------------------------------------
# LLM provider (Anthropic, API-only)
# ---------------------------------------------------------------------------
ANTHROPIC_API_KEY: str = _get("ANTHROPIC_API_KEY", required=True)

# Three-tier model split — pick the smallest model that does each task well.
# RANKER      — narrow comparison task: pick best candidate from a prefix shortlist
# TRANSLATION — very narrow task: Arabic description translation fallback
# REASONER    — hardest path: full HS inference from a free-text description
TRANSLATION_MODEL: str = _get("TRANSLATION_MODEL", "claude-haiku-4-6")
RANKER_MODEL: str = _get("RANKER_MODEL", "claude-sonnet-4-6")
REASONER_MODEL: str = _get("REASONER_MODEL", "claude-opus-4-6")

# ---------------------------------------------------------------------------
# Confidence gating & resolution tuning
# ---------------------------------------------------------------------------
CONFIDENCE_THRESHOLD: float = _get_float("CONFIDENCE_THRESHOLD", 0.75)
HV_THRESHOLD_SAR: float = _get_float("HV_THRESHOLD_SAR", 1000.0)

# Kept for backward-compat with BUILD.md; the production algorithm is
# longest-prefix-wins (deterministic) — see LESSONS.md entry 2026-04-16.
PREFIX_RANKER_MAX_CANDIDATES: int = int(_get_float("PREFIX_RANKER_MAX_CANDIDATES", 15))

# ---------------------------------------------------------------------------
# Storage paths (all relative to project root unless absolute)
# ---------------------------------------------------------------------------
DB_PATH: Path = _get_path("DB_PATH", "clear_ai.db")
FAISS_INDEX_PATH: Path = _get_path("FAISS_INDEX_PATH", "hs_master_faiss.index")
FAISS_CODES_PATH: Path = _get_path("FAISS_CODES_PATH", "hs_codes.json")
OUTPUT_DIR: Path = _get_path("OUTPUT_DIR", "output")
DATA_DIR: Path = _get_path("DATA_DIR", "data")

# ---------------------------------------------------------------------------
# Bayan XML constants
# ---------------------------------------------------------------------------
# Observed values in Naqel's 5 baseline XMLs (data/Baseline XML output/).
# These are broker-/integration-level constants that don't vary per declaration.
# Override via env if a specific deployment needs different values.
BAYAN_CONSTANTS: dict[str, str | int] = {
    # reference block
    "userid": _get("BAYAN_USERID", "uwqfr003"),
    "acctId": _get("BAYAN_ACCT_ID", "uwqf"),
    "regPort": _get("BAYAN_REG_PORT", "23"),
    "regPortType": _get("BAYAN_REG_PORT_TYPE", "4"),
    # senderInformation block
    "brokerLicenseType": int(_get("BAYAN_BROKER_LICENSE_TYPE", "5")),
    "brokerLicenseNo": int(_get("BAYAN_BROKER_LICENSE_NO", "1")),
    "brokerRepresentativeNo": int(_get("BAYAN_BROKER_REP_NO", "1749")),
    # declarationHeader block
    "declarationType": int(_get("BAYAN_DECLARATION_TYPE", "2")),
    "finalCountry": _get("BAYAN_FINAL_COUNTRY", "SA"),
    "inspectionGroupID": int(_get("BAYAN_INSPECTION_GROUP_ID", "10")),
    "paymentMethod": int(_get("BAYAN_PAYMENT_METHOD", "1")),
    # invoice-level defaults
    "invoiceType": int(_get("BAYAN_INVOICE_TYPE", "5")),
    "deal": int(_get("BAYAN_DEAL", "1")),
    "invoicePayment": int(_get("BAYAN_INVOICE_PAYMENT", "1")),
    "paymentDocumentsStatus": int(_get("BAYAN_PAYMENT_DOC_STATUS", "0")),
    # item-level defaults
    "invoiceMeasurementUnit": int(_get("BAYAN_INVOICE_MEASUREMENT_UNIT", "7")),
    "internationalMeasurementUnit": int(_get("BAYAN_INTL_MEASUREMENT_UNIT", "7")),
    "unitPerPackages": int(_get("BAYAN_UNIT_PER_PACKAGES", "1")),
    "itemDutyType": int(_get("BAYAN_ITEM_DUTY_TYPE", "1")),
    # ExpressMailInformation block (from Naqel fields spec)
    "transportType": int(_get("BAYAN_TRANSPORT_TYPE", "4")),
    "addCountryCode": int(_get("BAYAN_ADD_COUNTRY_CODE", "100")),
    "country": int(_get("BAYAN_COUNTRY", "100")),
    "cityDefault": int(_get("BAYAN_CITY_DEFAULT", "131")),
    "zipCode": int(_get("BAYAN_ZIP_CODE", "111")),
    "pob": int(_get("BAYAN_POB", "11")),
    # source company fallback
    "defaultSourceCompanyName": _get("BAYAN_DEFAULT_SOURCE_CO_NAME", "ناقل"),
    "defaultSourceCompanyNo": int(_get("BAYAN_DEFAULT_SOURCE_CO_NO", "340476")),
}

# ---------------------------------------------------------------------------
# XML namespaces (ZATCA/SaudiEDI)
# ---------------------------------------------------------------------------
BAYAN_NAMESPACES: dict[str, str] = {
    "decsub": "http://www.saudiedi.com/schema/decsub",
    "deccm": "http://www.saudiedi.com/schema/deccm",
    "sau": "http://www.saudiedi.com/schema/sau",
    "cm": "http://www.saudiedi.com/schema/common",
    "deckey": "http://www.saudiedi.com/schema/deckey",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "xsd": "http://www.w3.org/2001/XMLSchema",
}


# ---------------------------------------------------------------------------
# Startup summary (for logging / debugging)
# ---------------------------------------------------------------------------
def describe() -> str:
    """Return a human-readable summary of the loaded config. Excludes secrets."""
    api_key_status = "set" if ANTHROPIC_API_KEY else "missing"
    return (
        f"ClearAI config:\n"
        f"  ANTHROPIC_API_KEY    = {api_key_status}\n"
        f"  TRANSLATION_MODEL    = {TRANSLATION_MODEL}\n"
        f"  RANKER_MODEL         = {RANKER_MODEL}\n"
        f"  REASONER_MODEL       = {REASONER_MODEL}\n"
        f"  CONFIDENCE_THRESHOLD = {CONFIDENCE_THRESHOLD}\n"
        f"  HV_THRESHOLD_SAR     = {HV_THRESHOLD_SAR}\n"
        f"  DB_PATH              = {DB_PATH}\n"
        f"  FAISS_INDEX_PATH     = {FAISS_INDEX_PATH}\n"
        f"  OUTPUT_DIR           = {OUTPUT_DIR}\n"
        f"  DATA_DIR             = {DATA_DIR}\n"
        f"  BAYAN constants      = {len(BAYAN_CONSTANTS)} values\n"
        f"  XML namespaces       = {len(BAYAN_NAMESPACES)} prefixes\n"
    )


if __name__ == "__main__":
    print(describe())
