"""SaudiEDI lookup tables derived from the Naqel sample pairs.

These are field translators — not classification logic. The merchant-supplied
Excel uses human labels ("AED", "Piece") or Naqel-internal IDs
("DestinationStationID=501"), and the SaudiEDI H2HDECSUB XML expects specific
numeric codes. Each table here was reverse-engineered from the post-processed
sample XMLs at
`sharepoint/sample_data/sample_input_commercial_invoice/client_commercial_invoices_sample1/`.

Policy for unknown keys: return a documented fallback and let the caller log
a warning. We never silently drop a row — customs filings with the wrong
numeric code will reject at ZATCA ingress.

To extend: add the row, leave a `# source: <file>` comment so the next engineer
can audit. If a field is proven client-specific, move it out of this module
into a per-client override dict.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("clearai.saudi_edi_mappings")


# ---------------------------------------------------------------------------
# DestinationStationID → (regPort, cityCode)
# ---------------------------------------------------------------------------
# Naqel station numbers map to a ZATCA registration port AND a destination
# city code inside expressMailInformation. Both samples used regPort=23 but
# different city codes, so the mapping can't collapse to a single field.
#
#   501 → Riyadh delivery    (from sample 1, NQD26033110789)
#   503 → Dammam delivery    (from sample 2, NQD26033110790)
#
# When extending, confirm the port number at the Naqel dispatch origin, NOT
# the delivery city. ZATCA's regPort is the INGRESS port (where goods enter
# the Kingdom), not the last-mile depot.
STATION_TO_REGPORT_CITY: dict[str, tuple[int, int]] = {
    "501": (23, 131),   # Riyadh
    "503": (23, 111),   # Dammam
    # TODO: extend once a fuller Naqel station list is available.
}

DEFAULT_REGPORT = 23        # fallback → Jeddah air cargo
DEFAULT_CITY_CODE = 131     # fallback → Riyadh


def lookup_station(station_id: str | int | None) -> tuple[int, int]:
    """Return `(regPort, cityCode)` for a Naqel station, with logged fallback."""
    if station_id is None or str(station_id).strip() == "":
        return DEFAULT_REGPORT, DEFAULT_CITY_CODE
    key = str(station_id).strip()
    if key in STATION_TO_REGPORT_CITY:
        return STATION_TO_REGPORT_CITY[key]
    logger.warning(
        "saudi_edi_mappings: unknown DestinationStationID=%r; "
        "falling back to (regPort=%d, city=%d). Add to STATION_TO_REGPORT_CITY.",
        key, DEFAULT_REGPORT, DEFAULT_CITY_CODE,
    )
    return DEFAULT_REGPORT, DEFAULT_CITY_CODE


# ---------------------------------------------------------------------------
# Currency → invoiceCurrency numeric code
# ---------------------------------------------------------------------------
# Observed from samples:
#   sample 1: CurrencyID=2  Currency="AED" → invoiceCurrency=120
#   sample 2: CurrencyID=1  Currency="SAR" → invoiceCurrency=100
#
# Pre-processed excel carries BOTH the numeric CurrencyID (1/2) and the ISO
# currency string ("SAR"/"AED"). We accept either; prefer the numeric ID.
CURRENCY_ID_TO_INVOICE_CURRENCY: dict[str, int] = {
    "1": 100,   # SAR
    "2": 120,   # AED
}

ISO_CURRENCY_TO_INVOICE_CURRENCY: dict[str, int] = {
    "SAR": 100,
    "AED": 120,
    "USD": 110,   # commonly seen; not in current samples — verify before use
}

DEFAULT_INVOICE_CURRENCY = 100   # SAR — safest default for KSA imports


def lookup_currency(currency_id: str | int | None, iso_currency: str | None) -> int:
    """Resolve invoiceCurrency numeric code from either input.

    The excel template carries both `CurrencyID` (Naqel numeric) and `Currency`
    (ISO string). Prefer the numeric ID; it's what the post-processed samples
    expose as authoritative. Fall back to ISO if ID is missing, then to SAR.
    """
    if currency_id is not None and str(currency_id).strip() != "":
        k = str(currency_id).strip()
        if k in CURRENCY_ID_TO_INVOICE_CURRENCY:
            return CURRENCY_ID_TO_INVOICE_CURRENCY[k]
    if iso_currency:
        k = iso_currency.strip().upper()
        if k in ISO_CURRENCY_TO_INVOICE_CURRENCY:
            return ISO_CURRENCY_TO_INVOICE_CURRENCY[k]
    logger.warning(
        "saudi_edi_mappings: unknown currency (id=%r, iso=%r); "
        "defaulting to invoiceCurrency=%d (SAR).",
        currency_id, iso_currency, DEFAULT_INVOICE_CURRENCY,
    )
    return DEFAULT_INVOICE_CURRENCY


# ---------------------------------------------------------------------------
# UnitType → measurement-unit numeric code
# ---------------------------------------------------------------------------
# Both samples emit `invoiceMeasurementUnit=7` and `internationalMeasurementUnit=7`
# (7 = "piece/unit" in SaudiEDI). Sample 1's excel had an empty UnitType; sample
# 2's excel had "Piece". Both resolved to 7. Extend once we see a shipment with
# a different unit (KG, LITER, etc).
UNIT_TYPE_TO_CODE: dict[str, int] = {
    "PIECE": 7,
    "PCS": 7,
    "UNIT": 7,
    "EACH": 7,
    # TODO: KG → ? , METER → ? — extend when observed.
}

DEFAULT_UNIT_CODE = 7   # piece — matches both baseline samples


def lookup_unit_type(unit: str | None) -> int:
    if not unit or not unit.strip():
        return DEFAULT_UNIT_CODE
    k = unit.strip().upper()
    if k in UNIT_TYPE_TO_CODE:
        return UNIT_TYPE_TO_CODE[k]
    logger.warning(
        "saudi_edi_mappings: unknown UnitType=%r; "
        "defaulting to code=%d (piece).", unit, DEFAULT_UNIT_CODE,
    )
    return DEFAULT_UNIT_CODE


# ---------------------------------------------------------------------------
# ClientID → source company (sourceCompanyName, sourceCompanyNo)
# ---------------------------------------------------------------------------
# Observed:
#   9019628 → Amazon AE / 509769           (sample 1)
#   9022381 → Vogacloset / 383668          (sample 2)
#
# This is the likely mapping layer between Naqel's merchant registration
# (`ClientID`) and the customs source-company record. When a ClientID is
# unknown the batch builder uses a documented fallback so the XML still
# validates on ingress — the review queue flags it for the operator.
@dataclass(frozen=True)
class SourceCompany:
    name: str
    number: str   # kept as str to preserve leading zeros in numeric codes


CLIENT_TO_SOURCE_COMPANY: dict[str, SourceCompany] = {
    "9019628": SourceCompany(name="AMAZON AE", number="509769"),
    "9022381": SourceCompany(name="Vogacloset", number="383668"),
    # TODO: populate from Naqel's full client roster.
}

DEFAULT_SOURCE_COMPANY = SourceCompany(name="UNKNOWN", number="0")


def lookup_source_company(client_id: str | int | None) -> SourceCompany:
    if client_id is None or str(client_id).strip() == "":
        return DEFAULT_SOURCE_COMPANY
    k = str(client_id).strip()
    if k in CLIENT_TO_SOURCE_COMPANY:
        return CLIENT_TO_SOURCE_COMPANY[k]
    logger.warning(
        "saudi_edi_mappings: unknown ClientID=%r; using placeholder source "
        "company (UNKNOWN/0). Add to CLIENT_TO_SOURCE_COMPANY to resolve.",
        k,
    )
    return DEFAULT_SOURCE_COMPANY


# ---------------------------------------------------------------------------
# WaybillNo → carrier prefix
# ---------------------------------------------------------------------------
# Samples diverge: 279274301 → carrierPrefix 141 (Amazon / QR freight)
#                  394613346 → carrierPrefix 346 (Vogacloset / DHL or similar)
# The pattern looks like "first 3 digits of waybill" for sample 2 but NOT for
# sample 1. Safest default: use a single constant and flag unknowns.
#
# ClientID seems the real discriminator here, because the carrier is typically
# the e-commerce platform's contracted freight partner. Map by client until
# we have a real carrier-routing rule.
CLIENT_TO_CARRIER_PREFIX: dict[str, int] = {
    "9019628": 141,   # Amazon AE
    "9022381": 346,   # Vogacloset
}

DEFAULT_CARRIER_PREFIX = 141


def lookup_carrier_prefix(client_id: str | int | None, waybill_no: str | None) -> int:
    """Pick a carrier prefix. Client-specific mapping first, then waybill heuristic."""
    if client_id is not None:
        k = str(client_id).strip()
        if k in CLIENT_TO_CARRIER_PREFIX:
            return CLIENT_TO_CARRIER_PREFIX[k]
    # Fallback heuristic: first 3 digits of waybill — matches sample 2 only.
    if waybill_no and str(waybill_no).strip()[:3].isdigit():
        return int(str(waybill_no).strip()[:3])
    logger.warning(
        "saudi_edi_mappings: no carrier prefix for client_id=%r waybill=%r; "
        "defaulting to %d.", client_id, waybill_no, DEFAULT_CARRIER_PREFIX,
    )
    return DEFAULT_CARRIER_PREFIX


# ---------------------------------------------------------------------------
# ConsigneeNationalID → transportIDType
# ---------------------------------------------------------------------------
# Saudi IDs start with 1 (citizen) or 2 (resident/iqama). Sample 1 (Roshan)
# had ID starting 2…  → transportIDType=3. Sample 2 (Arabic consignee) had
# ID starting 1… → transportIDType=5. Ordering is counter-intuitive but
# matches SaudiEDI spec: 3=Iqama, 5=National ID.
def lookup_transport_id_type(national_id: str | int | None) -> int:
    if national_id is None:
        return 3
    s = str(national_id).strip()
    if not s:
        return 3
    if s.startswith("1"):
        return 5   # Saudi citizen national ID
    if s.startswith("2"):
        return 3   # Iqama (resident permit)
    return 3


# ---------------------------------------------------------------------------
# City code → Arabic city name (for `<deccm:address>` when none supplied)
# ---------------------------------------------------------------------------
# The pre-processed Excel doesn't carry a street address. Naqel's post-processor
# emits the city name in Arabic in `<deccm:address>` — sample 1: "الريـاض"
# (Riyadh, city code 131) and sample 2: "الدمام" (Dammam, city code 111).
# This table resolves city-code → Arabic name for the same effect.
CITY_CODE_TO_ARABIC_NAME: dict[int, str] = {
    131: "الريـاض",   # sample 1 (note: sample uses a soft-hyphen / ZWNJ; preserved as-is)
    111: "الدمام",   # sample 2
    # TODO: extend with full KSA city code table.
}


def lookup_city_arabic_name(city_code: int | None) -> str:
    if city_code is None:
        return ""
    return CITY_CODE_TO_ARABIC_NAME.get(int(city_code), "")


# ---------------------------------------------------------------------------
# Phone normalization — strip "+", validate 12-digit, fall back on garbage
# ---------------------------------------------------------------------------
def normalize_phone(raw: str | int | None) -> str:
    if raw is None:
        return ""
    s = str(raw).strip().replace("+", "").replace(" ", "").replace("-", "")
    return s if s.isdigit() else ""
