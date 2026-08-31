"""Story 8.6 — server-side bank-detail encryption (FR-10.4).

The property that matters is not "it encrypts". It is that the account number is recoverable ONLY
with the server key, that nothing else on the platform can read it, and that a missing key fails
closed rather than storing it in the clear.
"""
import json

import pytest
from cryptography.fernet import Fernet

from app.infrastructure.security.bank_crypto import (
    BankDecryptFailed,
    BankKeyMissing,
    decrypt_bank_details,
    encrypt_bank_details,
    generate_key,
    mask_account,
)

KEY = Fernet.generate_key().decode("ascii")
OTHER_KEY = Fernet.generate_key().decode("ascii")

DETAILS = {
    "account_number": "8001234567890",
    "bank_name": "Bank of Ceylon",
    "branch": "Thalawa",
    "account_holder": "Test Registrant",
}


class TestRoundTrip:
    def test_encrypts_and_decrypts_back_to_the_same_details(self):
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        assert decrypt_bank_details(ciphertext, KEY) == DETAILS

    def test_accepts_a_bytes_key_as_well_as_a_string(self):
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY.encode("utf-8"))
        assert decrypt_bank_details(ciphertext, KEY)["account_number"] == "8001234567890"

    def test_optional_fields_may_be_absent(self):
        ciphertext, _ = encrypt_bank_details({"account_number": "123456"}, KEY)
        out = decrypt_bank_details(ciphertext, KEY)
        assert out["account_number"] == "123456"
        assert out["bank_name"] is None

    def test_whitespace_is_trimmed(self):
        ciphertext, last4 = encrypt_bank_details({"account_number": "  8001234567890  "}, KEY)
        assert decrypt_bank_details(ciphertext, KEY)["account_number"] == "8001234567890"
        assert last4 == "7890"


class TestTheCiphertextRevealsNothing:
    def test_the_account_number_does_not_appear_in_the_ciphertext(self):
        """A database dump must not contain readable account numbers."""
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        assert "8001234567890" not in ciphertext
        assert "Bank of Ceylon" not in ciphertext

    def test_the_same_details_encrypt_differently_each_time(self):
        """Fernet includes a random IV. Identical ciphertexts would reveal that two families bank
        at the same account."""
        a, _ = encrypt_bank_details(DETAILS, KEY)
        b, _ = encrypt_bank_details(DETAILS, KEY)
        assert a != b
        assert decrypt_bank_details(a, KEY) == decrypt_bank_details(b, KEY)

    def test_a_different_key_cannot_decrypt(self):
        """The whole point: stealing the database is not enough."""
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        with pytest.raises(BankDecryptFailed):
            decrypt_bank_details(ciphertext, OTHER_KEY)

    def test_tampered_ciphertext_is_rejected_not_silently_wrong(self):
        """Fernet is authenticated; a flipped byte must raise rather than decode to garbage."""
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        tampered = ciphertext[:-4] + ("AAAA" if not ciphertext.endswith("AAAA") else "BBBB")
        with pytest.raises(BankDecryptFailed):
            decrypt_bank_details(tampered, KEY)


class TestMasking:
    @pytest.mark.parametrize(
        "account,expected",
        [("8001234567890", "7890"), ("1234", "1234"), ("123", "123"), ("", None), (None, None)],
    )
    def test_mask_returns_only_the_tail(self, account, expected):
        assert mask_account(account) == expected

    def test_last4_is_returned_alongside_the_ciphertext(self):
        _, last4 = encrypt_bank_details(DETAILS, KEY)
        assert last4 == "7890"

    def test_the_mask_is_not_enough_to_reconstruct_the_account(self):
        _, last4 = encrypt_bank_details(DETAILS, KEY)
        assert DETAILS["account_number"] != last4
        assert len(last4) < len(DETAILS["account_number"])


class TestFailsClosed:
    @pytest.mark.parametrize("missing", [None, "", b""])
    def test_encrypting_without_a_key_raises_rather_than_storing_plaintext(self, missing):
        """The worst failure available here would be a plaintext fallback: registration appears to
        succeed and account numbers sit unencrypted in a column nobody thinks to check."""
        with pytest.raises(BankKeyMissing):
            encrypt_bank_details(DETAILS, missing)

    def test_a_malformed_key_is_a_misconfiguration_not_a_crash(self):
        with pytest.raises(BankKeyMissing):
            encrypt_bank_details(DETAILS, "not-a-fernet-key")

    def test_decrypting_without_a_key_raises(self):
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        with pytest.raises(BankKeyMissing):
            decrypt_bank_details(ciphertext, None)

    def test_empty_ciphertext_is_reported_as_a_decrypt_failure(self):
        """Distinct from "no details on file", which the caller checks before reaching here."""
        with pytest.raises(BankDecryptFailed):
            decrypt_bank_details(None, KEY)

    @pytest.mark.parametrize("bad", [{}, {"account_number": ""}, {"account_number": 123}, "x", None])
    def test_an_account_number_is_required(self, bad):
        with pytest.raises((ValueError, TypeError)):
            encrypt_bank_details(bad, KEY)

    def test_the_error_never_echoes_the_account_number(self):
        try:
            encrypt_bank_details({"account_number": "8001234567890"}, "not-a-fernet-key")
        except BankKeyMissing as exc:
            assert "8001234567890" not in str(exc)


class TestKeyGeneration:
    def test_generate_key_produces_a_usable_key(self):
        key = generate_key()
        ciphertext, _ = encrypt_bank_details(DETAILS, key)
        assert decrypt_bank_details(ciphertext, key) == DETAILS

    def test_generated_keys_differ(self):
        assert generate_key() != generate_key()


class TestPayloadShape:
    def test_the_stored_payload_is_one_value_not_field_by_field(self):
        """Encrypting the fields separately would invite decrypting "just the branch" somewhere
        with no business decrypting anything."""
        ciphertext, _ = encrypt_bank_details(DETAILS, KEY)
        raw = Fernet(KEY.encode()).decrypt(ciphertext.encode())
        assert set(json.loads(raw)) == {
            "account_number", "bank_name", "branch", "account_holder",
        }
