"""Server-side encryption for citizen bank details (Story 8.6, FR-10.4).

WHY THIS IS NOT THE MECHANISM USED FOR THE NIC — the two look similar and are opposites.

    NIC        one-way HMAC (nic_identity.py). Nobody ever needs the NIC back; the platform only
               needs to know two registrations are the same person. Irreversible on purpose.
    Bank       reversible encryption. The Divisional Secretariat must READ the account number to
               pay it. A digest would be useless.

And it cannot reuse the CLIENT-side AES-GCM key either (frontend/lib/crypto.ts): that key is
non-extractable and per-device, so a DS officer at a desk in Thalawa could never decrypt what a
citizen's phone in a village encrypted. The key has to live on the server. Fernet, from
`cryptography` — already a dependency (requirements.txt), no new package — because it is
authenticated (AES-128-CBC + HMAC-SHA256) and leaves no room to assemble a mode incorrectly.

THIS RAISES THE PLATFORM'S PII SENSITIVITY CLASS above anything previously stored, including the
NIC. The compensating controls are, in full:
  * encrypted at rest with a key that is not in the database and not in the repository;
  * decrypted at EXACTLY ONE call site (ds.py's payment authorisation), every call audit-logged;
  * every other surface — officer, admin, citizen, public status, research export, PDF report —
    sees `bank_account_last4` and nothing else, enforced by test;
  * ETHICS DEPENDENCY (architecture R-14): the NSBM ethics submission predates this reversal and
    does not yet cover bank data. Until it does, ONLY synthetic or test data may be entered.

Unlike NIC_PEPPER, BANK_DETAILS_KEY *can* be rotated — the ciphertext is reversible, so a rotation
is decrypt-with-old, encrypt-with-new over every row. That is a migration, not a routine action,
and no such script exists yet.
"""
import json

from cryptography.fernet import Fernet, InvalidToken


class BankKeyMissing(RuntimeError):
    """BANK_DETAILS_KEY is not configured. Raised rather than storing anything in the clear.

    Falling back to plaintext would be the worst possible failure here: registration would appear
    to succeed and account numbers would sit unencrypted in a column nobody thinks to check.
    Callers translate this into 500 `server_misconfigured`.
    """


class BankDecryptFailed(RuntimeError):
    """Ciphertext could not be decrypted — wrong key, or a tampered/corrupt value.

    Deliberately distinct from "this household has no bank details on file". A DS officer being
    told "no account recorded" when the truth is "the key changed" would send them to collect
    details the citizen already gave.
    """


# The digits shown everywhere except the one decrypt site. Four is the familiar receipt
# convention and is not enough to reconstruct an account.
LAST4_LEN = 4


def _fernet(key):
    if not key:
        raise BankKeyMissing("BANK_DETAILS_KEY is not configured")
    if isinstance(key, str):
        key = key.encode("utf-8")
    try:
        return Fernet(key)
    except (ValueError, TypeError) as exc:
        # A malformed key is a misconfiguration, not a caller error — same treatment as absent.
        raise BankKeyMissing("BANK_DETAILS_KEY is not a valid Fernet key") from exc


def generate_key():
    """A new urlsafe-base64 Fernet key. For the operator setting BANK_DETAILS_KEY up."""
    return Fernet.generate_key().decode("ascii")


def mask_account(account_number):
    """-> the last 4 characters, or None. The ONLY part of an account any list view may show."""
    if not isinstance(account_number, str):
        return None
    digits = account_number.strip()
    return digits[-LAST4_LEN:] if digits else None


def encrypt_bank_details(details, key):
    """-> (ciphertext_str, last4). `details` is a dict: account_number, bank_name, branch.

    The whole dict is encrypted as one value rather than field-by-field: the bank and branch are
    not independently useful and separate ciphertexts would invite decrypting "just the branch"
    somewhere that has no business decrypting anything.
    """
    if not isinstance(details, dict):
        raise ValueError("bank details must be an object")
    account = details.get("account_number")
    if not isinstance(account, str) or not account.strip():
        raise ValueError("account_number is required")

    payload = {
        "account_number": account.strip(),
        "bank_name": (details.get("bank_name") or "").strip() or None,
        "branch": (details.get("branch") or "").strip() or None,
        "account_holder": (details.get("account_holder") or "").strip() or None,
    }
    token = _fernet(key).encrypt(json.dumps(payload, sort_keys=True).encode("utf-8"))
    return token.decode("ascii"), mask_account(account)


def decrypt_bank_details(ciphertext, key):
    """-> the details dict. Call this ONLY from the payment authorisation path.

    Every call site of this function is a place a citizen's account number becomes readable, so
    the set of call sites is itself a security property — there is exactly one, and a test
    asserts that.
    """
    if not ciphertext:
        raise BankDecryptFailed("no bank details on file")
    try:
        raw = _fernet(key).decrypt(
            ciphertext.encode("utf-8") if isinstance(ciphertext, str) else ciphertext
        )
    except InvalidToken as exc:
        raise BankDecryptFailed("bank details could not be decrypted") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as exc:  # pragma: no cover - only reachable via a corrupt plaintext
        raise BankDecryptFailed("decrypted bank details were not valid JSON") from exc
