"""Household registration API (Story 8.2, FR-10.1 / FR-10.2 / FR-10.6).

    POST  /api/v1/households      register a household           (citizen JWT)
    GET   /api/v1/households/me   the caller's own household     (citizen JWT)
    PATCH /api/v1/households/me   correct contact details; add bank details if none (citizen JWT)

The household is the unit of claim. One person per family registers; the NICs of the declared
members are occupied by that registration, so no second household can claim the same family.

PII DISCIPLINE. The request body carries PLAINTEXT NICs, and this module is the only place on the
platform that ever sees them. They are HMAC'd (nic_identity.py) and dropped; no NIC is written to
a column, a log line, or an error message. `nic_hmac` values are likewise never returned — a
response that echoed them back would hand any caller an offline dictionary to attack.

WHY PLAINTEXT OVER THE WIRE AT ALL. The client cannot compute the digest: the pepper would have to
ship to every browser, and the existing client-side AES-GCM key is non-extractable and per-device
so the server can never decrypt an existing ciphertext. Documented amendment to NFR-3.1, with the
three rejected alternatives, in PRD Addendum A8.2. TLS is therefore load-bearing here in a way it
was not before, which is why deployed HTTPS was promoted to Story 8.0.

ENUMERATION TRADE-OFF (accepted, requirement-driven). FR-10.2 requires telling a blocked citizen
that their family is already registered, which unavoidably reveals that a NIC is or is not in the
registry. What this module does NOT do is compound it: the existing household_ref is returned only
when the conflict is on the CALLER'S OWN registrant NIC — the case where they need it to quote at
the DS office. A collision on a declared member's NIC returns a generic refusal that names neither
the member nor the other household, so nobody learns which relative, or whose family, is involved.
Rate limiting is the remaining mitigation and is not implemented here (deferred-work).
"""
from datetime import datetime, timezone

import psycopg2
import psycopg2.errors
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_citizen, require_officer
from app.infrastructure import registry
from app.infrastructure.audit import write_audit_log
from app.infrastructure.geo.divisions import is_valid_pair
from app.infrastructure.security.bank_crypto import BankKeyMissing, encrypt_bank_details
from app.infrastructure.security.nic_identity import NicPepperMissing, nic_hmac

households_bp = Blueprint("households", __name__)

# A household is a family, not a village. The cap is a guard against a malformed or hostile
# payload rather than a policy statement about family size; a legitimate registration that hits
# it is a support conversation, not a silent truncation.
MAX_MEMBERS = 25
MAX_NAME_LEN = 200
MAX_ADDRESS_LEN = 300


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _clean_text(value, limit=MAX_NAME_LEN):
    """-> a trimmed string capped at `limit`, or None. Never raises on odd input."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()[:limit]
    return trimmed or None


def _parse_members(raw):
    """-> (members, error). Each member is {'nic': str, 'full_name': str|None, 'relationship': ...}.

    Accepts either a bare NIC string or an object, because the registration form has gone through
    two shapes and an officer-assisted client may send the simpler one.
    """
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return None, "members must be a list"
    if len(raw) > MAX_MEMBERS:
        return None, f"a household may declare at most {MAX_MEMBERS} members"

    members = []
    for entry in raw:
        if isinstance(entry, str):
            members.append({"nic": entry, "full_name": None, "relationship": None})
        elif isinstance(entry, dict):
            nic = entry.get("nic")
            if not isinstance(nic, str):
                return None, "each member needs a nic"
            members.append({
                "nic": nic,
                "full_name": _clean_text(entry.get("full_name")),
                "relationship": _clean_text(entry.get("relationship"), 100),
            })
        else:
            return None, "each member must be a NIC string or an object"
    return members, None


@households_bp.route("/households", methods=["POST"])
@require_citizen()
def register_household():
    citizen_id = g.citizen_id  # verified JWT sub — never from the request body

    pepper = current_app.config.get("NIC_PEPPER")
    if not pepper:
        # Deliberately not a 400: the caller did nothing wrong and retrying will not help.
        # Mirrors auth.py's treatment of an unreachable JWKS endpoint.
        current_app.logger.error("household registration attempted with no NIC_PEPPER configured")
        return jsonify({"error": "server_misconfigured"}), 500

    body = request.get_json(silent=True) or {}

    district = _clean_text(body.get("district"))
    ds_division = _clean_text(body.get("ds_division"))
    if not district or not ds_division:
        return jsonify({"error": "missing_fields",
                        "fields": ["district", "ds_division"]}), 400

    # FR-10.6: this pair decides which officers and which DS office ever see the family's cases,
    # so an unknown or mismatched pair is rejected rather than stored and silently unroutable.
    if not is_valid_pair(district, ds_division):
        return jsonify({"error": "invalid_division"}), 400

    # Required from migration 035 on; households registered before it keep NULL.
    address = _clean_text(body.get("address"), MAX_ADDRESS_LEN)
    if not address:
        return jsonify({"error": "missing_fields", "fields": ["address"]}), 400

    members, member_error = _parse_members(body.get("members"))
    if member_error:
        return jsonify({"error": "invalid_members", "detail": member_error}), 400

    # Registrant first, so index 0 of `digests` is always the registrant's.
    people = [{
        "nic": body.get("nic"),
        "full_name": _clean_text(body.get("full_name")),
        "relationship": "self",
        "is_registrant": True,
    }] + [dict(m, is_registrant=False) for m in members]

    try:
        digests = [nic_hmac(p["nic"], pepper) for p in people]
    except NicPepperMissing:
        return jsonify({"error": "server_misconfigured"}), 500
    except (ValueError, TypeError):
        # No NIC in the message — an error string echoing the value would defeat the point of
        # never logging it. The client knows which field it sent.
        return jsonify({"error": "invalid_nic"}), 400

    # A form listing one NIC twice is a user error, reported as such. Letting it through would
    # surface later as an opaque unique-violation on the household's own insert.
    if len(set(digests)) != len(digests):
        return jsonify({"error": "duplicate_nic_in_form"}), 400

    # Optional bank details (FR-10.4). Encrypted BEFORE the transaction opens so a crypto or
    # configuration failure cannot abort a half-written registration — a family that mistyped an
    # account number must not lose their household registration over it.
    bank_ciphertext = None
    bank_last4 = None
    bank = body.get("bank")
    if bank is not None:
        try:
            bank_ciphertext, bank_last4 = encrypt_bank_details(
                bank, current_app.config.get("BANK_DETAILS_KEY")
            )
        except BankKeyMissing:
            # A deployment without the key must not silently store an account number in the clear,
            # and must not silently drop it either — the citizen would believe it was recorded.
            current_app.logger.error("bank details supplied but BANK_DETAILS_KEY is not configured")
            return jsonify({"error": "server_misconfigured"}), 500
        except (ValueError, TypeError):
            # No account number in the message. It is the one field here as sensitive as the NIC.
            return jsonify({"error": "invalid_bank_details"}), 400

    # Optional contact email for status notifications (migration 029). Unlike the bank details it
    # is stored in the clear: the server must be able to hand it to the mail transport, and there
    # is nothing to protect it from that encrypting it would not also hide from the sender.
    #
    # NOT VALIDATED BEYOND SHAPE, and deliberately so. An address that looks wrong may still be
    # deliverable, and rejecting a registration over a contact field would trade a family's claim
    # for a typo. A malformed address costs one skipped notification, which is audit-logged; the
    # public status page (FR-6.1) still works for them either way.
    contact_email = _clean_text(body.get("contact_email"))
    if contact_email is not None and ("@" not in contact_email or " " in contact_email):
        contact_email = None

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # (a) Has this Supabase account already registered a household?
                    cur.execute(
                        "SELECT household_ref FROM households "
                        " WHERE registrant_uid = %s AND status = 'active' LIMIT 1",
                        (citizen_id,),
                    )
                    mine = cur.fetchone()
                    if mine:
                        return jsonify({"error": "already_registered",
                                        "household_ref": mine[0]}), 409

                    # (b) Is any supplied NIC already occupied? Checked before inserting so the
                    #     common case produces a clean 409 rather than a caught constraint error.
                    #     The UNIQUE index is still the authority — see the race handler below.
                    cur.execute(
                        """SELECT m.nic_hmac, h.household_ref
                             FROM household_members m
                             JOIN households h ON h.id = m.household_id
                            WHERE m.nic_hmac = ANY(%s)""",
                        (digests,),
                    )
                    taken = {row[0]: row[1] for row in cur.fetchall()}
                    if taken:
                        return _conflict_response(digests[0], taken)

                    cur.execute("SELECT nextval('hec_household_seq')")
                    seq = cur.fetchone()[0]
                    household_ref = f"HH-{datetime.now(timezone.utc).year}-{seq:04d}"

                    cur.execute(
                        """INSERT INTO households
                             (household_ref, district, ds_division, gn_division, registrant_uid,
                              bank_details_ciphertext, bank_account_last4, contact_email, address)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                        (household_ref, district, ds_division,
                         _clean_text(body.get("gn_division")), citizen_id,
                         bank_ciphertext, bank_last4, contact_email, address),
                    )
                    household_id = cur.fetchone()[0]

                    cur.executemany(
                        """INSERT INTO household_members
                             (household_id, nic_hmac, is_registrant, full_name, relationship)
                           VALUES (%s, %s, %s, %s, %s)""",
                        [(household_id, digest, p["is_registrant"], p["full_name"],
                          p["relationship"])
                         for p, digest in zip(people, digests)],
                    )

                    # No NIC and no digest in the metadata — the audit trail must not become the
                    # PII store the schema deliberately avoids being.
                    write_audit_log(
                        cur, None, "household_registered", citizen_id,
                        {"household_ref": household_ref, "district": district,
                         "ds_division": ds_division, "member_count": len(people),
                         # Whether, not what. The audit trail must not become the PII store the
                         # rest of this design goes to lengths to avoid.
                         "bank_details_provided": bank_ciphertext is not None},
                    )
        finally:
            conn.close()
    except psycopg2.errors.UniqueViolation:
        # Lost a race with a concurrent registration between check (b) and the insert. The UNIQUE
        # index did its job; re-read to produce the same 409 the pre-check would have.
        return _conflict_after_race(digests)
    except psycopg2.Error:
        current_app.logger.exception("household registration failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({
        "household_ref": household_ref,
        "district": district,
        "ds_division": ds_division,
        "member_count": len(people),
        # The tail only, and only so the citizen can confirm they typed the right account. The
        # full number is never returned by this endpoint or any other except the DS payment view.
        "bank_account_last4": bank_last4,
    }), 201


def _conflict_response(registrant_digest, taken):
    """409 for an occupied NIC. See the enumeration note in the module docstring for why the
    existing household_ref travels only when the clash is on the caller's own registrant NIC."""
    if registrant_digest in taken:
        return jsonify({"error": "nic_already_registered",
                        "scope": "registrant",
                        "household_ref": taken[registrant_digest]}), 409
    # A declared member is registered elsewhere. Neither the member nor the other household is
    # named: the caller may have no legitimate relationship to either.
    return jsonify({"error": "nic_already_registered", "scope": "member"}), 409


def _conflict_after_race(digests):
    """Re-open a connection to describe a conflict the failed transaction cannot report.

    A separate connection because the original transaction is aborted — any query on it would
    raise InFailedSqlTransaction. If this second look also fails, fall back to the generic
    member-scoped refusal, which is the safe direction: it discloses nothing.
    """
    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT m.nic_hmac, h.household_ref
                             FROM household_members m
                             JOIN households h ON h.id = m.household_id
                            WHERE m.nic_hmac = ANY(%s)""",
                        (digests,),
                    )
                    taken = {row[0]: row[1] for row in cur.fetchall()}
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("conflict re-read failed after unique violation")
        return jsonify({"error": "nic_already_registered", "scope": "member"}), 409
    return _conflict_response(digests[0], taken)


@households_bp.route("/households/lookup", methods=["POST"])
@require_officer()
def lookup_household():
    """NIC in, household reference out — the officer-assisted path's missing half (Story 8.5).

    Story 8.4 gated `POST /cases/submit` on a `household_ref`, but the officer app had no way to
    obtain one: it AES-GCM encrypts the citizen's NIC with a non-extractable device key, so the
    reference cannot be derived client-side and cannot be recovered from the stored ciphertext.
    This endpoint closes that gap; without it officer-assisted submission cannot complete.

    POST, not GET, so the NIC travels in a request body rather than a URL — query strings end up
    in access logs, browser history and Referer headers, and this is the one identifier the whole
    Epic 8 design goes to lengths never to persist in the clear.

    Officer-only. It answers "is this NIC registered, and where", which is exactly the probe the
    registration endpoint withholds from citizens; officers already hold far more of a claimant's
    data by virtue of standing in front of them with their card. Returns NO member list — the
    officer needs the reference to file a case, not the family's composition.
    """
    pepper = current_app.config.get("NIC_PEPPER")
    if not pepper:
        current_app.logger.error("household lookup attempted with no NIC_PEPPER configured")
        return jsonify({"error": "server_misconfigured"}), 500

    body = request.get_json(silent=True) or {}

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    household = registry.resolve_by_nic(cur, body.get("nic"), pepper)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("household lookup failed")
        return jsonify({"error": "server_error"}), 500

    if not household:
        # Covers "no such registration" and "malformed NIC" alike: resolve_by_nic returns None
        # for both, and distinguishing them here would confirm that a well-formed NIC exists.
        return jsonify({"error": "not_registered"}), 404

    return jsonify({
        "household_ref": household["household_ref"],
        "district": household["district"],
        "ds_division": household["ds_division"],
    }), 200


def _read_own_household(cur, citizen_id):
    """The caller's active household as the /me response body, or None. Never nic_hmac or the bank
    ciphertext — see the module docstring. Address, contact email and account tail are their own."""
    cur.execute(
        """SELECT id, household_ref, district, ds_division, gn_division,
                  status, registered_at, address, contact_email,
                  bank_account_last4
             FROM households
            WHERE registrant_uid = %s AND status = 'active'
            ORDER BY id DESC LIMIT 1""",
        (citizen_id,),
    )
    row = cur.fetchone()
    if not row:
        return None

    cur.execute(
        """SELECT full_name, relationship, is_registrant
             FROM household_members
            WHERE household_id = %s
            ORDER BY is_registrant DESC, id""",
        (row[0],),
    )
    members = [
        {"full_name": m[0], "relationship": m[1], "is_registrant": m[2]}
        for m in cur.fetchall()
    ]
    return {
        "household_ref": row[1],
        "district": row[2],
        "ds_division": row[3],
        "gn_division": row[4],
        "status": row[5],
        "registered_at": row[6].isoformat() if row[6] else None,
        "address": row[7],
        "contact_email": row[8],
        "bank_account_last4": row[9],
        "members": members,
    }


@households_bp.route("/households/me", methods=["GET"])
@require_citizen()
def my_household():
    """The caller's own household, or 404."""
    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    household = _read_own_household(cur, g.citizen_id)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("household lookup failed")
        return jsonify({"error": "server_error"}), 500

    if household is None:
        return jsonify({"error": "not_registered"}), 404
    return jsonify(household), 200


# Registration facts the family cannot change for itself. The area decides which officers and DS
# office handle its claims (FR-10.6); the members are the NICs behind the duplicate-claim control
# (FR-10.2). Both change only through the DS office.
_LOCKED_FIELDS = ("district", "ds_division", "members", "nic", "full_name", "household_ref")


@households_bp.route("/households/me", methods=["PATCH"])
@require_citizen()
def update_my_household():
    """A registered family corrects its own contact details, and adds bank details it skipped.

    BANK DETAILS ARE ADD-ONLY. An account number already on file is where the DS office pays the
    compensation; replacing it self-service would let anyone holding the family's session redirect
    a payment. A family that skipped the optional step at registration can add one here — until
    now it had no way to, and the DS office cannot pay a household without one.
    """
    citizen_id = g.citizen_id
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    locked = sorted(k for k in _LOCKED_FIELDS if k in body)
    if locked:
        return jsonify({"error": "not_editable", "fields": locked}), 400

    updates = {}
    if "address" in body:
        address = _clean_text(body.get("address"), MAX_ADDRESS_LEN)
        if not address:
            # Required since migration 035: it can be corrected, not removed.
            return jsonify({"error": "missing_fields", "fields": ["address"]}), 400
        updates["address"] = address
    if "contact_email" in body:
        contact_email = _clean_text(body.get("contact_email"))
        # Registration drops a malformed address silently rather than lose the registration over it;
        # an edit can simply be refused and retyped.
        if contact_email is not None and ("@" not in contact_email or " " in contact_email):
            return jsonify({"error": "invalid_email"}), 400
        updates["contact_email"] = contact_email  # None clears it: the field is optional
    if "gn_division" in body:
        updates["gn_division"] = _clean_text(body.get("gn_division"))

    bank = body.get("bank")
    if bank is not None:
        try:
            ciphertext, last4 = encrypt_bank_details(bank, current_app.config.get("BANK_DETAILS_KEY"))
        except BankKeyMissing:
            current_app.logger.error("bank details supplied but BANK_DETAILS_KEY is not configured")
            return jsonify({"error": "server_misconfigured"}), 500
        except (ValueError, TypeError):
            return jsonify({"error": "invalid_bank_details"}), 400
        updates["bank_details_ciphertext"] = ciphertext
        updates["bank_account_last4"] = last4

    if not updates:
        return jsonify({"error": "no_changes"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT id, household_ref, address, contact_email, gn_division,
                                  bank_details_ciphertext, bank_account_last4
                             FROM households
                            WHERE registrant_uid = %s AND status = 'active'
                            ORDER BY id DESC LIMIT 1
                              FOR UPDATE""",
                        (citizen_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "not_registered"}), 404
                    household_id, household_ref = row[0], row[1]
                    current = dict(zip(
                        ("address", "contact_email", "gn_division",
                         "bank_details_ciphertext", "bank_account_last4"),
                        row[2:],
                    ))
                    if bank is not None and current["bank_details_ciphertext"] is not None:
                        return jsonify({"error": "bank_details_locked"}), 409

                    changed = sorted({
                        "bank" if k.startswith("bank_") else k
                        for k, v in updates.items() if current[k] != v
                    })
                    if changed:
                        merged = {**current, **updates}
                        cur.execute(
                            """UPDATE households
                                  SET address = %s, contact_email = %s, gn_division = %s,
                                      bank_details_ciphertext = %s, bank_account_last4 = %s,
                                      updated_at = now()
                                WHERE id = %s""",
                            (merged["address"], merged["contact_email"], merged["gn_division"],
                             merged["bank_details_ciphertext"], merged["bank_account_last4"],
                             household_id),
                        )
                        # Which fields, never their values: the audit trail must not become the PII
                        # store the rest of this design avoids.
                        write_audit_log(cur, None, "household_details_updated", citizen_id,
                                        {"household_ref": household_ref, "fields": changed})
                    household = _read_own_household(cur, citizen_id)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("household update failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify(household), 200
