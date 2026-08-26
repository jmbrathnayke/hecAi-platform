"""Household registration API (Story 8.2, FR-10.1 / FR-10.2 / FR-10.6).

    POST /api/v1/households      register a household           (citizen JWT)
    GET  /api/v1/households/me   the caller's own household     (citizen JWT)

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

from app.api.v1.middleware.auth import require_citizen
from app.infrastructure.audit import write_audit_log
from app.infrastructure.geo.divisions import is_valid_pair
from app.infrastructure.security.nic_identity import NicPepperMissing, nic_hmac

households_bp = Blueprint("households", __name__)

# A household is a family, not a village. The cap is a guard against a malformed or hostile
# payload rather than a policy statement about family size; a legitimate registration that hits
# it is a support conversation, not a silent truncation.
MAX_MEMBERS = 25
MAX_NAME_LEN = 200


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
                             (household_ref, district, ds_division, gn_division, registrant_uid)
                           VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                        (household_ref, district, ds_division,
                         _clean_text(body.get("gn_division")), citizen_id),
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
                         "ds_division": ds_division, "member_count": len(people)},
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


@households_bp.route("/households/me", methods=["GET"])
@require_citizen()
def my_household():
    """The caller's own household, or 404. Never returns nic_hmac — see the module docstring."""
    citizen_id = g.citizen_id

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT id, household_ref, district, ds_division, gn_division,
                                  status, registered_at
                             FROM households
                            WHERE registrant_uid = %s AND status = 'active'
                            ORDER BY id DESC LIMIT 1""",
                        (citizen_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "not_registered"}), 404

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
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("household lookup failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({
        "household_ref": row[1],
        "district": row[2],
        "ds_division": row[3],
        "gn_division": row[4],
        "status": row[5],
        "registered_at": row[6].isoformat() if row[6] else None,
        "members": members,
    }), 200
