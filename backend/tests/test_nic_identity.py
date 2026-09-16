"""Story 8.1 — NIC identity derivation (FR-10.2).

These tests guard the mechanism behind "one registered claimant per family". The property that
matters is not "the function returns a hash" — it is that ONE PERSON always produces ONE digest
and two people never produce the same one.
"""
import pytest

from app.infrastructure.security.nic_identity import (
    NicPepperMissing,
    canonical_nic,
    nic_hmac,
    nic_hmacs,
    normalise_nic,
)

PEPPER = "test-pepper-not-a-real-secret"

# One person, both cards. THE 12-DIGIT FORM IS THE 9-DIGIT FORM WITH A CENTURY PREFIX AND A CHECK
# DIGIT — that correspondence is the assumption canonical_nic() is built on, and this pair is
# where it is pinned. If the real national mapping differs, this is the test that must change,
# and changing it tells you canonical_nic() has to change too.
LEGACY = "751234567V"
CURRENT = "197512345670"

# A real-shaped current-format number supplied by the PO (2026-08-26), kept as a second, concrete
# anchor so the structure is not only asserted against a number this file invented:
#
#   2 0 0 1   3 3 5   0 2 3 4   3
#   ^^^^^^^                          birth year   2001
#             ^^^^^                  day of year  335
#                     ^^^^^^^        serial
#                               ^    trailing digit (check / the legacy card's V-X slot)
#
# The nine digits a legacy card would carry are therefore 0 1 3 3 5 0 2 3 4.
PO_CURRENT = "200133502343"
PO_LEGACY_EQUIVALENT = "013350234V"


class TestNormalise:
    def test_trims_and_uppercases(self):
        assert normalise_nic("  751234567v  ") == "751234567V"

    def test_strips_internal_spaces(self):
        assert normalise_nic("7512 34567 V") == "751234567V"

    def test_accepts_both_formats(self):
        assert normalise_nic(LEGACY) == LEGACY
        assert normalise_nic(CURRENT) == CURRENT

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "12345678V",       # 8 digits
            "1234567890V",     # 10 digits + letter
            "751234567A",      # wrong trailing letter
            "12345678901",     # 11 digits
            "1234567890123",   # 13 digits
            "75123456-7V",     # punctuation
            "abcdefghiV",
        ],
    )
    def test_rejects_malformed(self, bad):
        with pytest.raises(ValueError):
            normalise_nic(bad)

    @pytest.mark.parametrize("bad", [None, 751234567, b"751234567V", ["751234567V"]])
    def test_rejects_non_strings(self, bad):
        with pytest.raises(ValueError):
            normalise_nic(bad)


class TestCanonical:
    def test_legacy_and_current_forms_of_one_person_agree(self):
        """The bypass this closes: register on one card, register again on the other."""
        assert canonical_nic(LEGACY) == canonical_nic(CURRENT)

    def test_canonical_is_the_nine_identifying_digits(self):
        assert canonical_nic(LEGACY) == "751234567"
        assert canonical_nic(CURRENT) == "751234567"

    def test_case_and_whitespace_do_not_change_the_key(self):
        assert canonical_nic("  751234567v ") == canonical_nic(LEGACY)

    def test_v_and_x_suffixes_are_distinct_people(self):
        """V and X differ in the digits before them in practice; nothing here should merge two
        NICs that differ in their identifying digits."""
        assert canonical_nic("751234567V") != canonical_nic("751234568X")

    def test_different_people_do_not_collide(self):
        keys = {
            canonical_nic("751234567V"),
            canonical_nic("751234568V"),   # different serial
            canonical_nic("851234567V"),   # different birth year
            canonical_nic("196012345670"), # different person, current format
        }
        assert len(keys) == 4

    def test_po_supplied_current_format_number(self):
        """The PO's real-shaped example (2026-08-26). Second anchor for the structure, so the
        assumption is not resting on a single number this file made up."""
        assert canonical_nic(PO_CURRENT) == "013350234"
        assert canonical_nic(PO_LEGACY_EQUIVALENT) == "013350234"
        assert canonical_nic(PO_CURRENT) == canonical_nic(PO_LEGACY_EQUIVALENT)

    def test_po_example_is_a_different_person_from_the_others(self):
        assert canonical_nic(PO_CURRENT) != canonical_nic(CURRENT)

    def test_check_digit_is_not_identifying(self):
        """Two 12-digit NICs differing only in the trailing digit are the same person — that
        digit is derived from the others, not part of the identity. (One of the two is simply
        an invalid card number.) Collapsing them is correct, and this pins it as intended
        behaviour rather than an accident of the slice."""
        assert canonical_nic("197512345670") == canonical_nic("197512345671")

    def test_birth_century_is_not_identifying(self):
        """The documented FALSE BLOCK risk, stated as an executable fact rather than left in a
        comment: the legacy card carries no century, so a key derived from both formats cannot
        either. Two holders born exactly 100 years apart with the same day-of-year and serial
        collide. Negligible in practice (the younger would be under the minimum issue age of 16),
        but real — see nic_identity.canonical_nic()."""
        assert canonical_nic("197512345670") == canonical_nic("207512345670")


class TestHmac:
    def test_is_deterministic(self):
        assert nic_hmac(LEGACY, PEPPER) == nic_hmac(LEGACY, PEPPER)

    def test_same_person_both_card_formats_one_digest(self):
        """The FR-10.2 property, stated at the level the UNIQUE index actually sees."""
        assert nic_hmac(LEGACY, PEPPER) == nic_hmac(CURRENT, PEPPER)

    def test_different_people_different_digests(self):
        assert nic_hmac("751234567V", PEPPER) != nic_hmac("751234568V", PEPPER)

    def test_digest_does_not_contain_the_nic(self):
        """A digest that leaked its input would make the registry enumerable from a DB dump."""
        digest = nic_hmac(LEGACY, PEPPER)
        assert "751234567" not in digest
        assert digest != canonical_nic(LEGACY)

    def test_shape_is_sha256_hex(self):
        digest = nic_hmac(LEGACY, PEPPER)
        assert len(digest) == 64
        assert all(c in "0123456789abcdef" for c in digest)

    def test_pepper_changes_the_digest(self):
        """Why rotation is unrecoverable — R-13 stated as an executable fact."""
        assert nic_hmac(LEGACY, PEPPER) != nic_hmac(LEGACY, "a-different-pepper")

    def test_str_and_bytes_peppers_agree(self):
        assert nic_hmac(LEGACY, PEPPER) == nic_hmac(LEGACY, PEPPER.encode("utf-8"))

    @pytest.mark.parametrize("missing", [None, "", b""])
    def test_missing_pepper_fails_closed(self, missing):
        """No default pepper. A fallback would produce digests anyone could recompute from the
        repo, and the failure would be invisible until someone audited the database."""
        with pytest.raises(NicPepperMissing):
            nic_hmac(LEGACY, missing)

    def test_invalid_nic_raises_before_hashing(self):
        with pytest.raises(ValueError):
            nic_hmac("not-a-nic", PEPPER)


class TestBatch:
    def test_preserves_order(self):
        nics = ["751234567V", "851234567V", "951234567X"]
        assert nic_hmacs(nics, PEPPER) == [nic_hmac(n, PEPPER) for n in nics]

    def test_does_not_deduplicate(self):
        """A form listing one NIC twice is a user error the caller must report. Collapsing it
        here would surface it later as an opaque unique-violation instead."""
        out = nic_hmacs([LEGACY, LEGACY], PEPPER)
        assert len(out) == 2
        assert out[0] == out[1]

    def test_one_bad_entry_fails_the_batch(self):
        with pytest.raises(ValueError):
            nic_hmacs([LEGACY, "junk"], PEPPER)


class TestAppConfig:
    def test_pepper_is_none_by_default_in_tests(self, app):
        """create_app() must not invent a pepper. Registration is expected to 500 rather than
        write digests derived from a guessable default."""
        assert app.config["NIC_PEPPER"] is None

    def test_pepper_reads_from_environment(self, monkeypatch):
        from app import create_app

        monkeypatch.setenv("NIC_PEPPER", "from-env")
        assert create_app({"TESTING": True}).config["NIC_PEPPER"] == "from-env"
