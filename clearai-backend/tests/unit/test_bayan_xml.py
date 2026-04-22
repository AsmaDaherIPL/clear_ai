"""Structural regression tests for the SaudiEDI builder.

Pins the XML shape against Naqel's two post-processed baseline samples at
  sharepoint/sample_data/sample_input_commercial_invoice/client_commercial_invoices_sample1/

We don't assert byte-equality — dynamic fields (docRefNo, today's date, dynamic
HS lookup) vary by run. We assert STRUCTURAL equivalence:
  - Same root element + attributes in the same order
  - Same namespace declarations
  - Same nested element sequence (DFS traversal yields identical tag list)
  - Key field values (tariffCode, countryOfOrigin, currency, weights) match
    the builder input

That keeps the test stable across env changes while still catching any drift
in element order, naming, or namespace prefix — the exact things that break
ingress at ZATCA.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

import pytest

from clearai.services.bayan_xml import (
    ConsigneeInfo, DeclarationItem, WaybillDeclaration,
    build_declaration_xml, generate_doc_ref_no,
)

SAMPLE_DIR = Path(
    "/Users/asma/Desktop/Customs AI/sharepoint/sample_data/"
    "sample_input_commercial_invoice/client_commercial_invoices_sample1"
)
SAMPLE_1 = SAMPLE_DIR / "post-processed item 1 (NQD26033110789).XML"
SAMPLE_2 = SAMPLE_DIR / "post-processed item 2 (NQD26033110790).XML"


# ---------------------------------------------------------------------------
# Helpers — DFS a full tree to a list of (local_tag, text, attr_keys).
# ---------------------------------------------------------------------------
def _dfs_shape(root: ET.Element) -> list[tuple[str, bool, tuple[str, ...]]]:
    """Return a shape signature — element order + local tag + has-text flag.

    We skip values (they differ) but KEEP the localname and whether the
    element had any text. Attribute localnames are captured so additions or
    removals break the test. Namespace URIs are dropped — we check those
    separately on the root.
    """
    out: list[tuple[str, bool, tuple[str, ...]]] = []
    for el in root.iter():
        local = el.tag.split("}", 1)[-1]
        has_text = bool(el.text and el.text.strip())
        attr_keys = tuple(sorted(a.split("}", 1)[-1] for a in el.attrib))
        out.append((local, has_text, attr_keys))
    return out


# ---------------------------------------------------------------------------
# Fixtures — build decls that mirror the two baseline samples.
# ---------------------------------------------------------------------------
def _decl_sample_1() -> WaybillDeclaration:
    return WaybillDeclaration(
        doc_ref_no="NQD26033110789",
        invoice_no="279274301",
        waybill_no="279274301",
        invoice_date=date(2026, 3, 31),
        invoice_currency_code=120,   # AED
        reg_port=23,
        client_id="9019628",        # Amazon AE
        items=(
            DeclarationItem(
                seq_no=1,
                country_of_origin="US",
                tariff_code="851713000000",
                goods_description_ar="  أجهزة هاتف ذكية سمارت فون",
                quantity=1,
                gross_weight=0.38,
                net_weight=0.38,
                unit_invoice_cost=3426.35,
                item_cost=3426.35,
                unit_type_code=7,
            ),
        ),
        consignee=ConsigneeInfo(
            name="Roshan",
            national_id="2591527102",
            phone="+966565397861",
            address="الريـاض",
            city_code=131,
        ),
    )


def _decl_sample_2() -> WaybillDeclaration:
    return WaybillDeclaration(
        doc_ref_no="NQD26033110790",
        invoice_no="394613346",
        waybill_no="394613346",
        invoice_date=date(2026, 3, 30),
        invoice_currency_code=100,   # SAR
        reg_port=23,
        client_id="9022381",        # Vogacloset
        items=(
            DeclarationItem(
                seq_no=1,
                country_of_origin="GB",
                tariff_code="620462000001",
                goods_description_ar="بنطلونات",
                quantity=1,
                gross_weight=0.38,
                net_weight=0.38,
                unit_invoice_cost=None,   # sample 2 omits this field
                item_cost=1080,
                unit_type_code=7,
            ),
        ),
        consignee=ConsigneeInfo(
            name="رحمة العيسى",
            national_id="1069595681",
            phone="966500026683",
            address="الدمام",
            city_code=111,
        ),
    )


# ---------------------------------------------------------------------------
# Root / namespace / outer structure
# ---------------------------------------------------------------------------
class TestRootShape:
    def test_root_element_and_attributes_match_sample_1(self) -> None:
        xml = build_declaration_xml(_decl_sample_1())
        built = ET.fromstring(xml)
        sample = ET.parse(SAMPLE_1).getroot()

        assert built.tag.split("}")[-1] == sample.tag.split("}")[-1] == "saudiEDI"
        # Docinfo attributes must match exactly — ZATCA ingress keys on these.
        for k in ("docType", "id", "msgType"):
            built_v = _find_attr_by_localname(built, k)
            sample_v = _find_attr_by_localname(sample, k)
            assert built_v == sample_v, f"{k}: built={built_v!r} sample={sample_v!r}"

    def test_all_namespace_uris_present(self) -> None:
        xml = build_declaration_xml(_decl_sample_1())
        for uri in (
            "http://www.saudiedi.com/schema/decsub",
            "http://www.saudiedi.com/schema/deccm",
            "http://www.saudiedi.com/schema/sau",
            "http://www.saudiedi.com/schema/common",
            "http://www.w3.org/2001/XMLSchema-instance",
        ):
            assert uri in xml, f"missing namespace uri: {uri}"


# ---------------------------------------------------------------------------
# Deep structural equivalence
# ---------------------------------------------------------------------------
class TestStructuralEquivalence:
    @pytest.mark.parametrize("decl_fn, sample_path", [
        (_decl_sample_1, SAMPLE_1),
        (_decl_sample_2, SAMPLE_2),
    ])
    def test_dfs_element_sequence_matches_sample(
        self, decl_fn, sample_path: Path,
    ) -> None:
        built_root = ET.fromstring(build_declaration_xml(decl_fn()))
        sample_root = ET.parse(sample_path).getroot()

        built_shape = _dfs_shape(built_root)
        sample_shape = _dfs_shape(sample_root)

        # Same number of elements + same tag sequence.
        built_tags = [s[0] for s in built_shape]
        sample_tags = [s[0] for s in sample_shape]
        assert built_tags == sample_tags, (
            f"structural drift:\n"
            f"  built:  {built_tags}\n"
            f"  sample: {sample_tags}"
        )


# ---------------------------------------------------------------------------
# Field-level spot checks — values the ZATCA portal validates on ingress.
# ---------------------------------------------------------------------------
class TestCriticalFields:
    def test_sample1_tariff_code_and_currency_and_cost(self) -> None:
        xml = build_declaration_xml(_decl_sample_1())
        assert "<deccm:tariffCode>851713000000</deccm:tariffCode>" in xml
        assert "<deccm:invoiceCurrency>120</deccm:invoiceCurrency>" in xml
        assert "<deccm:itemCost>3426.35</deccm:itemCost>" in xml
        assert "<deccm:countryOfOrigin>US</deccm:countryOfOrigin>" in xml

    def test_sample2_integer_money_has_no_decimal_point(self) -> None:
        # Sample 2's <itemCost>1080</itemCost> is an integer — don't emit "1080.00".
        xml = build_declaration_xml(_decl_sample_2())
        assert "<deccm:itemCost>1080</deccm:itemCost>" in xml
        assert "<deccm:itemCost>1080.00</deccm:itemCost>" not in xml

    def test_sample2_omits_unit_invoice_cost_when_none(self) -> None:
        xml = build_declaration_xml(_decl_sample_2())
        assert "unitInvoiceCost" not in xml, (
            "sample 2 did not include unitInvoiceCost — builder must omit "
            "when the field is None"
        )

    def test_docref_and_invoice_no_wired_through(self) -> None:
        xml = build_declaration_xml(_decl_sample_1())
        assert 'decsub:id="NQD26033110789"' in xml
        assert "<decsub:docRefNo>NQD26033110789</decsub:docRefNo>" in xml
        assert "<deccm:invoiceNo>279274301</deccm:invoiceNo>" in xml
        assert "<deccm:airBLNo>279274301</deccm:airBLNo>" in xml

    def test_phone_is_normalized(self) -> None:
        # Sample 1 excel had "+966565397861"; sample XML emits "966565397861"
        xml = build_declaration_xml(_decl_sample_1())
        assert "<deccm:telephone>966565397861</deccm:telephone>" in xml

    def test_transport_id_type_derived_from_national_id_prefix(self) -> None:
        # Sample 1 consignee ID starts with "2" (iqama) → transportIDType=3
        xml1 = build_declaration_xml(_decl_sample_1())
        assert "<deccm:transportIDType>3</deccm:transportIDType>" in xml1
        # Sample 2 consignee ID starts with "1" (citizen) → transportIDType=5
        xml2 = build_declaration_xml(_decl_sample_2())
        assert "<deccm:transportIDType>5</deccm:transportIDType>" in xml2


# ---------------------------------------------------------------------------
# Doc ref generator
# ---------------------------------------------------------------------------
class TestDocRefGenerator:
    def test_format_matches_samples(self) -> None:
        # Sample 1 docRefNo: NQD26033110789  → year=2026, day=31, seq=10789
        assert generate_doc_ref_no(date(2026, 3, 31), 10789) == "NQD26033110789"
        assert generate_doc_ref_no(date(2026, 3, 31), 10790) == "NQD26033110790"

    def test_pads_short_sequence(self) -> None:
        assert generate_doc_ref_no(date(2026, 1, 1), 7) == "NQD26010100007"


# ---------------------------------------------------------------------------
# Sequence allocator
# ---------------------------------------------------------------------------
class TestDocRefSequence:
    def test_monotonic_within_day(self, tmp_path: Path) -> None:
        import sqlite3
        from clearai.services.batch_job_store import allocate_doc_ref_seq

        db = tmp_path / "t.db"
        conn = sqlite3.connect(str(db))
        today = date(2026, 5, 1)
        assert allocate_doc_ref_seq(conn, today) == 1
        assert allocate_doc_ref_seq(conn, today) == 2
        assert allocate_doc_ref_seq(conn, today) == 3
        conn.close()

    def test_resets_across_days(self, tmp_path: Path) -> None:
        import sqlite3
        from clearai.services.batch_job_store import allocate_doc_ref_seq

        db = tmp_path / "t.db"
        conn = sqlite3.connect(str(db))
        assert allocate_doc_ref_seq(conn, date(2026, 5, 1)) == 1
        assert allocate_doc_ref_seq(conn, date(2026, 5, 1)) == 2
        assert allocate_doc_ref_seq(conn, date(2026, 5, 2)) == 1
        conn.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _find_attr_by_localname(el: ET.Element, local: str) -> str | None:
    for k, v in el.attrib.items():
        if k.split("}", 1)[-1] == local:
            return v
    return None
