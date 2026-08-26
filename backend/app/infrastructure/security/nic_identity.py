"""Deterministic, server-side NIC identity derivation (Story 8.1, FR-10.2).

This module is the mechanism behind "one registered claimant per family". It turns a Sri Lankan
NIC into a value that is IDENTICAL every time for one person and reveals nothing about the NIC
itself, so `household_members.nic_hmac` can carry a UNIQUE index (migration 024).

WHY THIS IS NOT THE HASH THE PLATFORM ALREADY HAD. `cases.submitter_identity_hash` is computed
client-side as SHA-256(offline_id + ":" + nic_ciphertext) — salted per submission by offline_id
AND re-randomised by AES-GCM's fresh per-call IV. One NIC therefore yields a different value on
every submission. That is correct for per-incident privacy and it is unchanged. It also makes
duplicate detection mathematically impossible, which is why this second, deliberately LINKABLE
identifier exists and is confined to the registry.

WHY IT MUST RUN ON THE SERVER. Three options were considered (PRD Addendum A8.2):

  reuse submitter_identity_hash   impossible — different value every submission
  compute the HMAC in the browser rejected — the pepper would ship to every client, and anyone
                                  holding it could enumerate the whole registry offline by
                                  hashing candidate NICs (the keyspace is small enough to brute
                                  force: ~9 digits with heavy structure)
  encrypt with the existing key   impossible — frontend/lib/crypto.ts uses a NON-EXTRACTABLE,
                                  per-device key; the server can never decrypt it and a second
                                  device cannot reproduce it

So the registration endpoint receives the NIC in plaintext over TLS, calls into here, and stores
only the digest. The plaintext exists in request memory and nowhere else — never a column, never
a log line. This is a documented amendment to NFR-3.1, not an oversight.

OPERATIONAL WARNING. Rotating NIC_PEPPER changes every derived value and irrecoverably
invalidates the registry — every household would have to re-register. There is no recovery path
by design; a reversible one would defeat the pepper. See architecture.md Risk R-13.
"""
import hmac
import hashlib
import re

# Sri Lanka NIC, both issued formats. Mirrors frontend/lib/validation.ts NIC_REGEX and sms.py
# NIC_RE — three copies of this pattern now exist and they must agree, so any change here needs
# the same change there. (The frontend copy accepts lowercase v/x; this one is applied after
# upper-casing, which is why it lists only [VX].)
#
#   legacy   9 digits + V or X    e.g. 751234567V   (issued until 2016)
#   current  12 digits            e.g. 197512345670 (issued from 2016)
NIC_RE = re.compile(r"^([0-9]{9}[VX]|[0-9]{12})$")


class NicPepperMissing(RuntimeError):
    """NIC_PEPPER is not configured. Raised rather than falling back to a default.

    A default pepper would be worse than none: registrations would succeed, the digests would be
    computable by anyone reading this source, and the failure would be invisible until someone
    audited the database. Callers translate this into 500 `server_misconfigured` — the same
    treatment auth.py gives an unreachable JWKS endpoint.
    """


def normalise_nic(nic):
    """Trim and upper-case. Raises ValueError if the result is not a valid NIC.

    Upper-casing matters because the legacy format's trailing letter is entered as `v` about as
    often as `V`, and two cases of one NIC must never produce two registry entries.
    """
    if not isinstance(nic, str):
        raise ValueError("NIC must be a string")
    cleaned = nic.strip().upper().replace(" ", "")
    if not NIC_RE.match(cleaned):
        raise ValueError("NIC is not a valid Sri Lankan NIC (9 digits + V/X, or 12 digits)")
    return cleaned


def canonical_nic(nic):
    """Reduce either NIC format to the one key that identifies the person.

    THE PROBLEM THIS SOLVES. One person can hold both formats — everyone issued a legacy NIC
    before 2016 was later issued a 12-digit one, and both cards stay in circulation. Hashing the
    NIC as typed would let the same person register twice (once per format), or let a declared
    family member register separately using the other card. That is a trivial bypass of the
    entire control, so the two formats must reduce to the same key before hashing.

    THE MAPPING. The 12-digit form is the legacy 9 digits with a 2-digit birth century prefixed
    and a check digit appended:

        legacy   7 5 1 2 3 4 5 6 7 V
        current  1 9 7 5 1 2 3 4 5 6 7 0
                 ^^^                   ^  century prefix, check digit
                     ^^^^^^^^^^^^^^^^^    the 9 digits that identify the person

    So the shared key is `legacy[:9]` and `current[2:11]` — the birth year's last two digits, the
    day-of-year, and the serial. The century and the check digit are dropped because the legacy
    card does not carry either, and a key derived from only one format is no key at all.

    TWO RESIDUAL RISKS, both recorded rather than hidden:

    1. FALSE MISS (fail-open). If the national format correspondence above is not exactly right,
       the two forms of one person produce different keys and a duplicate goes undetected — the
       control silently weakens to its pre-Epic-8 state for that person. It does NOT wrongly
       block anyone. This assumption is pinned by an explicit test (test_nic_identity.py) so it
       is visible and cheap to correct; **it should be confirmed against a real pair of cards
       before production.**

    2. FALSE BLOCK. Dropping the century means two NIC holders born exactly 100 years apart with
       the same day-of-year and the same serial collide, and the second would be wrongly told
       their family is already registered. This requires two living claimants born ~1925 and
       ~2025 with identical day and serial; the younger has no NIC (minimum issue age is 16).
       Treated as negligible, not as impossible.
    """
    cleaned = normalise_nic(nic)
    return cleaned[:9] if len(cleaned) == 10 else cleaned[2:11]


def nic_hmac(nic, pepper):
    """-> hex HMAC-SHA256 of the canonical NIC. The value stored in household_members.nic_hmac.

    HMAC rather than a plain salted hash: the pepper is a key, not a salt, and HMAC is the
    construction designed for keyed digests. A bare SHA-256(pepper + nic) would be length-
    extendable and is the classic thing to get subtly wrong here.

    `pepper` is passed in rather than read from config so this stays a pure function — the
    caller owns configuration, and the tests do not need a Flask app context.
    """
    if not pepper:
        raise NicPepperMissing("NIC_PEPPER is not configured")
    if isinstance(pepper, str):
        pepper = pepper.encode("utf-8")
    return hmac.new(pepper, canonical_nic(nic).encode("utf-8"), hashlib.sha256).hexdigest()


def nic_hmacs(nics, pepper):
    """-> list of digests, order preserved. Convenience for a registration payload's member list.

    Deliberately NOT de-duplicated: a form that lists the same NIC twice is a user error the
    caller must report as such, and silently collapsing it here would let that error reach the
    database as a confusing unique-violation instead.
    """
    return [nic_hmac(n, pepper) for n in nics]
