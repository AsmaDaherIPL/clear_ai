"""
Lookup engine — fast indexed queries against the SQLite mapping tables that
feed the XML builder.

Covers the four non-HS reference domains:

  currency        — InfoTrack CurrencyCode  →  Tabadul tabdul_currency_id
  city            — info_city_id            →  tabdul_city (name, country)
  source company  — (client_id, port_code)  →  (source_company_name, source_company_no)
  country origin  — client_id               →  Tabadul country_origin numeric

All lookups return `None` or a fallback when no mapping exists. The source-company
fallback is `BAYAN_CONSTANTS["defaultSourceCompanyName"]` / `defaultSourceCompanyNo`
(default `"ناقل"`, per INSTRUCTIONS.md).

Connection is owned by the caller (one `sqlite3.Connection` per batch run);
this keeps the engine cheap to instantiate and easy to test with an in-memory DB.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from typing import Any

import config

logger = logging.getLogger("clearai.lookup_engine")


# ---------------------------------------------------------------------------
# Result shapes
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CurrencyLookup:
    infotrack_currency_id: int
    tabdul_currency_id: int
    iso_code: str


@dataclass(frozen=True)
class CityLookup:
    tabdul_city_id: int
    country_code: int
    arabic_name: str
    english_name: str
    intl_code: str


@dataclass(frozen=True)
class SourceCompany:
    name: str
    number: str
    is_fallback: bool


@dataclass(frozen=True)
class CountryLookup:
    country_code: int
    arabic_name: str
    english_name: str
    intl_code: str


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
class LookupEngine:
    """All non-HS reference lookups for the XML builder.

    The connection is not closed by this class; owner handles lifecycle.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        # Make sure row_factory is sqlite3.Row — callers may not set it.
        if self._conn.row_factory is not sqlite3.Row:
            self._conn.row_factory = sqlite3.Row

    # ---- currency -----------------------------------------------------
    def currency_by_iso(self, iso_code: str) -> CurrencyLookup | None:
        """Lookup by ISO-4217 currency code (SAR, USD, AED, …)."""
        if not iso_code:
            return None
        cur = self._conn.execute(
            "SELECT infotrack_currency_id, tabdul_currency_id, iso_code "
            "FROM currency_mapping WHERE iso_code = ? LIMIT 1",
            (iso_code.strip().upper(),),
        )
        row = cur.fetchone()
        if row is None:
            logger.warning("currency_by_iso: no mapping for iso=%r", iso_code)
            return None
        return CurrencyLookup(
            infotrack_currency_id=row["infotrack_currency_id"],
            tabdul_currency_id=row["tabdul_currency_id"],
            iso_code=row["iso_code"] or "",
        )

    def currency_by_infotrack_id(self, infotrack_id: Any) -> CurrencyLookup | None:
        if infotrack_id in (None, ""):
            return None
        try:
            key = int(infotrack_id)
        except (TypeError, ValueError):
            logger.warning("currency_by_infotrack_id: not an int: %r", infotrack_id)
            return None
        cur = self._conn.execute(
            "SELECT infotrack_currency_id, tabdul_currency_id, iso_code "
            "FROM currency_mapping WHERE infotrack_currency_id = ? LIMIT 1",
            (key,),
        )
        row = cur.fetchone()
        if row is None:
            logger.warning("currency_by_infotrack_id: no mapping for %s", key)
            return None
        return CurrencyLookup(
            infotrack_currency_id=row["infotrack_currency_id"],
            tabdul_currency_id=row["tabdul_currency_id"],
            iso_code=row["iso_code"] or "",
        )

    # ---- city ---------------------------------------------------------
    def city_by_info_id(self, info_city_id: Any) -> CityLookup | None:
        """Resolve an InfoTrack city id through the bridge into tabdul_city."""
        if info_city_id in (None, ""):
            return None
        try:
            key = int(info_city_id)
        except (TypeError, ValueError):
            return None
        cur = self._conn.execute(
            """
            SELECT tc.city_cd AS tabdul_city_id,
                   tc.ctry_cd  AS country_code,
                   tc.city_arb_name AS arabic_name,
                   tc.city_eng_name AS english_name,
                   tc.city_intl_cd  AS intl_code
            FROM city_mapping_bridge b
            JOIN tabdul_city tc ON b.tabdul_city_id = tc.city_cd
            WHERE b.info_city_id = ?
            LIMIT 1
            """,
            (key,),
        )
        row = cur.fetchone()
        if row is None:
            logger.warning("city_by_info_id: no mapping for info_city_id=%s", key)
            return None
        return CityLookup(
            tabdul_city_id=row["tabdul_city_id"],
            country_code=row["country_code"],
            arabic_name=row["arabic_name"] or "",
            english_name=row["english_name"] or "",
            intl_code=row["intl_code"] or "",
        )

    # ---- source company ----------------------------------------------
    def source_company(
        self, client_id: Any, port_code: Any
    ) -> SourceCompany:
        """Look up (client, port) source company. Falls back to Naqel default.

        Per INSTRUCTIONS.md §Data Handling Rules: when no mapping exists for
        (client_id, port_code), use BAYAN_CONSTANTS default — name `"ناقل"`,
        number from config.
        """
        try:
            cid = int(client_id) if client_id not in (None, "") else None
            port = int(port_code) if port_code not in (None, "") else None
        except (TypeError, ValueError):
            cid = port = None

        if cid is not None and port is not None:
            cur = self._conn.execute(
                "SELECT source_company_name, source_company_no "
                "FROM source_company_mapping "
                "WHERE client_id = ? AND cust_reg_port_code = ? LIMIT 1",
                (cid, port),
            )
            row = cur.fetchone()
            if row is not None:
                return SourceCompany(
                    name=row["source_company_name"] or "",
                    number=str(row["source_company_no"] or ""),
                    is_fallback=False,
                )

        logger.info(
            "source_company: falling back to default for (client=%s, port=%s)",
            cid, port,
        )
        return SourceCompany(
            name=str(config.BAYAN_CONSTANTS["defaultSourceCompanyName"]),
            number=str(config.BAYAN_CONSTANTS["defaultSourceCompanyNo"]),
            is_fallback=True,
        )

    # ---- country of origin -------------------------------------------
    def country_of_origin(self, client_id: Any) -> CountryLookup | None:
        """Origin always comes from CountryOfOriginClientMapping keyed by client_id,
        not from the Excel `CountryofManufacture` column (INSTRUCTIONS.md rule)."""
        if client_id in (None, ""):
            return None
        try:
            cid = int(client_id)
        except (TypeError, ValueError):
            return None
        cur = self._conn.execute(
            """
            SELECT cc.country_code,
                   cc.name_arabic AS arabic_name,
                   cc.name_english AS english_name,
                   cc.intl_code
            FROM country_origin_mapping com
            JOIN country_code cc ON com.country_origin = cc.country_code
            WHERE com.client_id = ?
            LIMIT 1
            """,
            (cid,),
        )
        row = cur.fetchone()
        if row is None:
            logger.warning("country_of_origin: no mapping for client_id=%s", cid)
            return None
        return CountryLookup(
            country_code=row["country_code"],
            arabic_name=row["arabic_name"] or "",
            english_name=row["english_name"] or "",
            intl_code=row["intl_code"] or "",
        )

    # ---- country by ISO-2 (helper) -----------------------------------
    def country_by_intl_code(self, intl_code: str) -> CountryLookup | None:
        """Lookup a country by 2-letter ISO code (e.g. "CN", "SA")."""
        if not intl_code:
            return None
        cur = self._conn.execute(
            "SELECT country_code, name_arabic AS arabic_name, "
            "name_english AS english_name, intl_code "
            "FROM country_code WHERE intl_code = ? LIMIT 1",
            (intl_code.strip().upper(),),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return CountryLookup(
            country_code=row["country_code"],
            arabic_name=row["arabic_name"] or "",
            english_name=row["english_name"] or "",
            intl_code=row["intl_code"] or "",
        )
