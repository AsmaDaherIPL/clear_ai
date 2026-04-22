"""Unit tests for batch_row_policy — CountryofManufacture null handling.

Locks in the "A + flag" decision: when CountryofManufacture is null, empty,
whitespace, or the literal strings "nan"/"none"/"null" (common Excel/pandas
rendering of missing cells), the builder substitutes "XX" AND the CLI
records `FLAG_MISSING_COUNTRY` on the row for operator review.
"""

from __future__ import annotations

import pytest

from clearai.services.batch_row_policy import (
    FLAG_MISSING_COUNTRY, UNKNOWN_COUNTRY,
    resolve_country_of_manufacture,
)


class TestCountryOfManufacture:
    @pytest.mark.parametrize("raw", [None, "", "   ", "\t", "nan", "None", "null", "NULL"])
    def test_null_like_values_get_flagged(self, raw) -> None:
        r = resolve_country_of_manufacture(raw)
        assert r.value == UNKNOWN_COUNTRY == "XX"
        assert r.flag == FLAG_MISSING_COUNTRY

    @pytest.mark.parametrize("raw, expected", [
        ("US", "US"),
        ("us", "US"),          # normalized to upper
        (" gb ", "GB"),        # whitespace stripped
        ("CN", "CN"),
        ("Sa", "SA"),
    ])
    def test_valid_country_passes_through_normalized(self, raw, expected) -> None:
        r = resolve_country_of_manufacture(raw)
        assert r.value == expected
        assert r.flag is None   # clean row → no flag

    def test_numeric_input_gets_stringified(self) -> None:
        # pandas may hand us a numpy int/float for a miscast column.
        # Not semantically meaningful, but we shouldn't crash.
        r = resolve_country_of_manufacture(100)
        assert r.value == "100"
        assert r.flag is None
