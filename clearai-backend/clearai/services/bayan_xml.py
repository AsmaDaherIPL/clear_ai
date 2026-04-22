"""
bayan_xml.py — SaudiEDI H2HDECSUB declaration builder.

Produces the exact XML shape Naqel files into ZATCA for express-mail imports,
one declaration per waybill. Element order, namespace prefixes, and attribute
layout are copied from two post-processed production samples at
`sharepoint/sample_data/sample_input_commercial_invoice/client_commercial_invoices_sample1/`
so output diffs against those samples are meaningful regression signals.

Schema shape (top-level):
  <decsub:saudiEDI docType="DEC" id="{docRefNo}" msgType="H2HDECSUB" ...>
    <decsub:record>
      <sau:payload xsi:type="decsub:declarationSubInfoType">
        <decsub:reference>                    — broker userid / acctId / regPort
        <decsub:senderInformation>            — broker license
        <decsub:declarationHeader>            — fixed SaudiEDI constants
        <decsub:invoices>                     — one per waybill; items nested
          <decsub:items> × N                  — classified HS row(s)
        <decsub:exportAirBL>                  — air waybill + carrier prefix
        <decsub:declarationDocuments>         — invoice doc metadata
        <decsub:expressMailInformation>       — consignee + delivery address
      </sau:payload>
    </decsub:record>
  </decsub:saudiEDI>

What the builder does NOT do:
  - Validate against an XSD. The two baseline samples ARE our schema; if they
    parsed upstream, so will identically-shaped output.
  - Run HS-code classification. Callers must supply a resolved `tariffCode`
    and `goodsDescription` (Arabic). Pair this with `HSResolver` +
    `ArabicTranslationEngine` for the full pipeline.
  - Group multi-item invoices. `build_declaration_xml` accepts a list of
    items for one waybill; callers group rows upstream.

Why stdlib ElementTree instead of lxml: we ship no new runtime dependency
here. The baseline samples use a tiny subset of XML features (namespaces +
one attribute with an `xmlns` collision) that ET handles fine. We DO register
namespace prefixes manually so output matches the sample byte-close.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from clearai import config
from clearai.services import saudi_edi_mappings as mappings

logger = logging.getLogger("clearai.bayan_xml")

_NS = config.BAYAN_NAMESPACES

# Qualified names — we write them as strings with the prefix because ET's
# `{uri}localname` Clark notation emits `ns0:` style, not the `decsub:` /
# `deccm:` / `sau:` / `cm:` prefixes the samples use.
DECSUB = "decsub"
DECCM = "deccm"
SAU = "sau"
CM = "cm"


# ---------------------------------------------------------------------------
# Public dataclasses — callers populate these; the builder does the rest.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DeclarationItem:
    """One classified product row within a waybill's invoice block.

    Fields map 1:1 to `<decsub:items>` in the post-processed samples. All
    numeric fields accept either int/float or pre-formatted strings —
    formatting is deferred to the builder to keep callers simple.
    """

    seq_no: int                              # 1-based item sequence
    country_of_origin: str                   # ISO-2, e.g. "US", "GB"
    tariff_code: str                         # resolved 12-digit ZATCA HS code
    goods_description_ar: str                # Arabic product description
    quantity: float = 1.0
    gross_weight: float = 0.0
    net_weight: float = 0.0
    unit_invoice_cost: float | None = None   # may be None; sample 2 omits it
    item_cost: float = 0.0
    unit_type_code: int = mappings.DEFAULT_UNIT_CODE


@dataclass(frozen=True)
class ConsigneeInfo:
    """Consignee + delivery address. Maps to `<decsub:expressMailInformation>`."""

    name: str
    national_id: str
    phone: str
    address: str = ""             # e.g. "الرياض" or a street; free-form
    city_code: int | None = None  # if None, derived from station


@dataclass(frozen=True)
class WaybillDeclaration:
    """Full input bundle for one SaudiEDI declaration (= one XML file).

    Separated into sub-dataclasses so the batch pipeline can construct each
    block from a different stage of the pipeline (resolver output → items;
    excel row → consignee; config → broker constants).
    """

    doc_ref_no: str                          # e.g. "NQD26033110789"
    invoice_no: str                          # usually the WaybillNo reused
    waybill_no: str
    invoice_date: date                       # used for airBLDate / documentDate
    invoice_currency_code: int               # 100=SAR, 120=AED, …
    reg_port: int                            # SaudiEDI ingress port
    client_id: str                           # for source-company lookup
    items: tuple[DeclarationItem, ...] = field(default_factory=tuple)
    consignee: ConsigneeInfo | None = None

    # Optional per-shipment overrides. If None, the builder uses the mapping
    # tables + config fallbacks.
    source_company_name: str | None = None
    source_company_no: str | None = None
    carrier_prefix: int | None = None


# ---------------------------------------------------------------------------
# Top-level entrypoint
# ---------------------------------------------------------------------------
def build_declaration_xml(decl: WaybillDeclaration) -> str:
    """Render a `WaybillDeclaration` to a UTF-8 XML string.

    The output is pretty-indented with 2 spaces and ends without a trailing
    newline — matching the baseline samples. Callers that need a newline
    (e.g. writing to `.XML` files for a batch ZIP) should append one.
    """
    if not decl.items:
        raise ValueError("WaybillDeclaration.items must contain at least one item")

    const = config.BAYAN_CONSTANTS

    # Resolve source company (explicit override > ClientID lookup > default).
    if decl.source_company_name and decl.source_company_no:
        src_name = decl.source_company_name
        src_no = str(decl.source_company_no)
    else:
        src = mappings.lookup_source_company(decl.client_id)
        src_name = src.name
        src_no = src.number

    # Resolve carrier prefix.
    carrier = (
        decl.carrier_prefix
        if decl.carrier_prefix is not None
        else mappings.lookup_carrier_prefix(decl.client_id, decl.waybill_no)
    )

    # --- root element -------------------------------------------------------
    # The sample uses a SPECIFIC attribute ordering and a schemaLocation that
    # ET can't preserve natively (attribute order is insertion-order in ET
    # but xmlns-prefix attrs come FIRST in the sample). We emit the
    # attributes in insertion order matching the sample.
    root = ET.Element(f"{DECSUB}:saudiEDI")
    # xmlns attrs — order matters for byte-closeness to the sample.
    root.set(f"xmlns:{DECCM}", _NS["deccm"])
    root.set("xmlns:xsi", _NS["xsi"])
    root.set(f"xmlns:{SAU}", _NS["sau"])
    root.set(f"xmlns:{CM}", _NS["cm"])
    root.set(f"xmlns:{DECSUB}", _NS["decsub"])
    root.set("xmlns:deckey", _NS["deckey"])
    root.set("xmlns:schemaLocation", "http://www.saudiedi.com/schema/decsub.xsd")
    root.set(f"{DECSUB}:docType", "DEC")
    root.set(f"{DECSUB}:id", decl.doc_ref_no)
    root.set(f"{DECSUB}:msgType", "H2HDECSUB")

    record = ET.SubElement(root, f"{DECSUB}:record")
    payload = ET.SubElement(record, f"{SAU}:payload")
    payload.set("xsi:type", "decsub:declarationSubInfoType")

    _build_reference(payload, const, decl.reg_port, decl.doc_ref_no)
    _build_sender(payload, const)
    _build_header(payload, const)
    _build_invoices(payload, const, decl, src_name, src_no)
    _build_export_air_bl(payload, carrier, decl.waybill_no, decl.invoice_date)
    _build_declaration_documents(payload, decl.waybill_no, decl.invoice_date)
    _build_express_mail(payload, const, decl)

    # Pretty-print — 2-space indent, no trailing newline.
    ET.indent(root, space="  ")
    xml_body = ET.tostring(root, encoding="unicode")
    return f'<?xml version="1.0" encoding="utf-8"?>\n{xml_body}'


# ---------------------------------------------------------------------------
# Block builders (private)
# ---------------------------------------------------------------------------
def _build_reference(parent: ET.Element, const: dict, reg_port: int, doc_ref: str) -> None:
    ref = ET.SubElement(parent, f"{DECSUB}:reference")
    _text(ref, f"{DECSUB}:userid", const["userid"])
    _text(ref, f"{DECSUB}:acctId", const["acctId"])
    _text(ref, f"{DECSUB}:docRefNo", doc_ref)
    port = _text(ref, f"{DECSUB}:regPort", reg_port)
    port.set(f"{CM}:type", str(const.get("regPortType", "4")))


def _build_sender(parent: ET.Element, const: dict) -> None:
    sender = ET.SubElement(parent, f"{DECSUB}:senderInformation")
    _text(sender, f"{DECCM}:brokerLicenseType", const["brokerLicenseType"])
    _text(sender, f"{DECCM}:brokerLicenseNo", const["brokerLicenseNo"])
    _text(sender, f"{DECCM}:brokerRepresentativeNo", const["brokerRepresentativeNo"])


def _build_header(parent: ET.Element, const: dict) -> None:
    hdr = ET.SubElement(parent, f"{DECSUB}:declarationHeader")
    _text(hdr, f"{DECSUB}:declarationType", const["declarationType"])
    _text(hdr, f"{DECSUB}:finalCountry", const["finalCountry"])
    _text(hdr, f"{DECSUB}:inspectionGroupID", const["inspectionGroupID"])
    _text(hdr, f"{DECSUB}:paymentMethod", const["paymentMethod"])
    _text(hdr, f"{DECSUB}:totalNoOfInvoice", 1)


def _build_invoices(
    parent: ET.Element,
    const: dict,
    decl: WaybillDeclaration,
    src_name: str,
    src_no: str,
) -> None:
    inv = ET.SubElement(parent, f"{DECSUB}:invoices")
    _text(inv, f"{DECSUB}:invoiceSeqNo", 1)
    _text(inv, f"{DECCM}:invoiceType", const["invoiceType"])
    _text(inv, f"{DECCM}:invoiceNo", decl.invoice_no)
    _text(inv, f"{DECCM}:totalNoItems", len(decl.items))

    total_cost = sum(i.item_cost for i in decl.items)
    total_gross = sum(i.gross_weight for i in decl.items)
    total_net = sum(i.net_weight for i in decl.items)

    _text(inv, f"{DECCM}:invoiceCost", _fmt_money(total_cost))
    _text(inv, f"{DECCM}:invoiceCurrency", decl.invoice_currency_code)
    _text(inv, f"{DECCM}:totalGrossWeight", _fmt_weight(total_gross))
    _text(inv, f"{DECCM}:totalNetWeight", _fmt_weight(total_net))

    src = ET.SubElement(inv, f"{DECSUB}:sourceCompany")
    _text(src, f"{DECCM}:sourceCompanyName", src_name)
    _text(src, f"{DECSUB}:sourceCompanyNo", src_no)

    _text(inv, f"{DECCM}:deal", const["deal"])

    pay = ET.SubElement(inv, f"{DECSUB}:paymentInfo")
    _text(pay, f"{DECCM}:paymentInfoSeqNo", 1)
    _text(pay, f"{DECCM}:invoicePayment", const["invoicePayment"])
    _text(pay, f"{DECCM}:paymentDocumentsStatus", const["paymentDocumentsStatus"])
    _text(pay, f"{DECCM}:documentAmount", _fmt_money(total_cost))

    # The sample nests EACH item as a `<decsub:items>` sibling, not as
    # children of a wrapper. Preserve that shape.
    for item in decl.items:
        _build_item(inv, const, item)


def _build_item(parent: ET.Element, const: dict, item: DeclarationItem) -> None:
    # Note: in the samples, items are top-level children of <invoices> — NOT
    # wrapped in a collection element. We emit the same way.
    it = ET.SubElement(parent, f"{DECSUB}:items")
    _text(it, f"{DECCM}:itemSeqNo", item.seq_no)
    _text(it, f"{DECCM}:countryOfOrigin", item.country_of_origin)
    _text(it, f"{DECCM}:tariffCode", item.tariff_code)
    _text(it, f"{DECCM}:goodsDescription", item.goods_description_ar)
    _text(it, f"{DECCM}:invoiceMeasurementUnit", item.unit_type_code)
    _text(it, f"{DECCM}:quantityInvoiceUnit", _fmt_int_if_whole(item.quantity))
    _text(it, f"{DECCM}:internationalMeasurementUnit", item.unit_type_code)
    _text(it, f"{DECCM}:quantityInternationalUnit", _fmt_int_if_whole(item.quantity))
    _text(it, f"{DECCM}:grossWeight", _fmt_weight(item.gross_weight))
    _text(it, f"{DECCM}:netWeight", _fmt_weight(item.net_weight))
    _text(it, f"{DECCM}:unitPerPackages", const["unitPerPackages"])
    # Sample 2 omits unitInvoiceCost; we mirror that if caller passes None.
    if item.unit_invoice_cost is not None:
        _text(it, f"{DECCM}:unitInvoiceCost", _fmt_money(item.unit_invoice_cost))
    _text(it, f"{DECCM}:itemCost", _fmt_money(item.item_cost))
    _text(it, f"{DECCM}:itemDutyType", const["itemDutyType"])


def _build_export_air_bl(
    parent: ET.Element, carrier_prefix: int, waybill_no: str, bl_date: date
) -> None:
    abl = ET.SubElement(parent, f"{DECSUB}:exportAirBL")
    _text(abl, f"{DECCM}:carrierPrefix", carrier_prefix)
    _text(abl, f"{DECCM}:airBLNo", waybill_no)
    _text(abl, f"{DECCM}:airBLDate", bl_date.isoformat())


def _build_declaration_documents(parent: ET.Element, waybill_no: str, doc_date: date) -> None:
    dd = ET.SubElement(parent, f"{DECSUB}:declarationDocuments")
    _text(dd, f"{DECCM}:documentSeqNo", 1)
    _text(dd, f"{DECCM}:documentType", 3)
    _text(dd, f"{DECCM}:documentNo", waybill_no)
    _text(dd, f"{DECCM}:documentDate", doc_date.isoformat())


def _build_express_mail(
    parent: ET.Element, const: dict, decl: WaybillDeclaration
) -> None:
    # Consignee is optional at the dataclass level but required for a valid
    # declaration. If missing, we emit defaults so the XML still parses.
    c = decl.consignee or ConsigneeInfo(
        name="UNKNOWN", national_id="", phone="",
    )
    emi = ET.SubElement(parent, f"{DECSUB}:expressMailInfomation")  # sic: sample typo
    _text(emi, f"{DECCM}:transportType", const["transportType"])
    _text(emi, f"{DECCM}:transportIDType", mappings.lookup_transport_id_type(c.national_id))
    _text(emi, f"{DECCM}:transportID", c.national_id or "0")
    _text(emi, f"{DECCM}:name", c.name)
    _text(emi, f"{DECCM}:addCtryCd", const["addCountryCode"])
    _text(emi, f"{DECCM}:country", const["country"])

    city = c.city_code if c.city_code is not None else const["cityDefault"]
    _text(emi, f"{DECCM}:city", city)
    _text(emi, f"{DECCM}:zipCode", const["zipCode"])
    _text(emi, f"{DECCM}:poBox", const["pob"])
    # `<deccm:address>`: the baseline samples carry the Arabic city name when
    # no street address is known. Pre-processed Excel has no address column,
    # so we fall back on the city-code → Arabic-name mapping.
    address = c.address or mappings.lookup_city_arabic_name(city)
    _text(emi, f"{DECCM}:address", address)
    _text(emi, f"{DECCM}:telephone", mappings.normalize_phone(c.phone))


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------
def _text(parent: ET.Element, tag: str, value: Any) -> ET.Element:
    el = ET.SubElement(parent, tag)
    el.text = "" if value is None else str(value)
    return el


def _fmt_money(v: float | int | None) -> str:
    """Format money matching the samples: `3426.35` (no trailing zeros if
    already a whole number, e.g. `1080`)."""
    if v is None:
        return "0"
    # Match sample behavior: 1080 (int-looking) stays integer, 3426.35 stays 2-dp.
    if float(v).is_integer():
        return str(int(v))
    return f"{float(v):.2f}"


def _fmt_weight(v: float | int | None) -> str:
    """Weights in samples: `0.38` (2 dp) even when net == gross. Keep 2 dp."""
    if v is None or v == 0:
        return "0"
    return f"{float(v):.2f}"


def _fmt_int_if_whole(v: float | int) -> str:
    """`quantityInvoiceUnit` is emitted as `1` not `1.0`. Mirror the sample."""
    if float(v).is_integer():
        return str(int(v))
    return str(v)


# ---------------------------------------------------------------------------
# Doc ref generator
# ---------------------------------------------------------------------------
def generate_doc_ref_no(today: date, seq: int) -> str:
    """Build an `NQD{YY}{MM}{DD}{seq:05d}` identifier.

    The samples use `NQD26033110789` and `NQD26033110790` — parsed as
    `NQD` + `26` (year) + `03` (month) + `31` (day) + `10789` / `10790`
    (daily sequence). This generator reproduces that exact shape; the
    caller is responsible for persisting the sequence counter across runs
    so the same `seq` is never reused on the same day.
    """
    yy = today.year % 100
    return f"NQD{yy:02d}{today.month:02d}{today.day:02d}{seq:05d}"
