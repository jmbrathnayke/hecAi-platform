"""Divisional Secretariat API (Story 8.5, PRD Section 3, NFR-3.2).

    GET /api/v1/ds/cases   cases in this officer's DS division   (ds_officer JWT)

A SEPARATE SURFACE FROM THE ADMIN DASHBOARD, not a variant of it. The DWC administrator oversees
a district's pipeline; the Divisional Secretariat authorises the payment for its own division, one
level below. Both roles coexist and neither is widened by the other — Epic 7's district analytics
must behave exactly as before (regression-tested).

Scope comes only from `g.ds_division`, set by require_ds_officer() from the signature-verified
`app_metadata` claim. Nothing here reads a division from the request: a division supplied by the
client would let any DS officer read, and later authorise payment on, another division's cases.

PII discipline mirrors officer.py and admin.py — an explicit column list, never SELECT *, and
never `submitter_identity_hash`, `citizen_nic_plain`, `citizen_mobile_plain`, or `nic_hmac`. The
household REFERENCE travels (it is the working identifier a DS officer quotes); the NICs behind it
do not, and cannot: the registry stores only their keyed digests.
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_ds_officer
from app.infrastructure.audit import write_audit_log
from app.infrastructure.security.bank_crypto import BankDecryptFailed, decrypt_bank_details

ds_bp = Blueprint("ds", __name__)

# A working queue, not an export (export is Epic 7) — cap the result set, same as officer.py.
MAX_CASES = 200


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _client_ip():
    """Best-effort client IP for the NFR-3.4 access log. Mirrors officer.py."""
    forwarded = request.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() if forwarded else (request.remote_addr or "")


@ds_bp.route("/ds/cases", methods=["GET"])
@require_ds_officer()
def list_division_cases():
    ds_division = g.ds_division  # verified JWT claim — never from the request
    ds_officer_id = g.ds_officer_id

    status_filter = request.args.get("status") or None

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # LEFT JOIN, not INNER: pre-Epic-8 and seeded cases have household_id NULL
                    # (migration 025) and would silently vanish from the division's queue under
                    # an inner join — the DS office would be told it has no work when it does.
                    cur.execute(
                        """SELECT c.canonical_id, c.offline_id, c.status, c.damage_category,
                                  c.submitted_via, c.submitted_at, c.updated_at,
                                  c.approved_amount, h.household_ref
                             FROM cases c
                             LEFT JOIN households h ON h.id = c.household_id
                            WHERE c.ds_division_id = %s
                              AND (%s IS NULL OR c.status = %s)
                            ORDER BY c.submitted_at DESC
                            LIMIT %s""",
                        (ds_division, status_filter, status_filter, MAX_CASES),
                    )
                    rows = cur.fetchall()

                    cases = [
                        {
                            "canonical_id": r[0],
                            "offline_id": str(r[1]) if r[1] is not None else None,
                            "status": r[2],
                            "damage_category": r[3],
                            "submitted_via": r[4],
                            "submitted_at": r[5].isoformat() if r[5] else None,
                            "updated_at": r[6].isoformat() if r[6] else None,
                            "approved_amount": float(r[7]) if r[7] is not None else None,
                            "household_ref": r[8],
                        }
                        for r in rows
                    ]

                    # NFR-3.4: a read is an access event. case_id is NULL — this is not about one
                    # case. Mirrors officer.py's officer_viewed_cases.
                    write_audit_log(
                        cur,
                        None,
                        "ds_officer_viewed_cases",
                        ds_officer_id,
                        {
                            "ip_address": _client_ip(),
                            "ds_division": ds_division,
                            "result_count": len(cases),
                        },
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("DS case list failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({"cases": cases, "count": len(cases), "ds_division": ds_division}), 200


@ds_bp.route("/ds/cases/<string:canonical_id>/authorize-payment", methods=["POST"])
@require_ds_officer()
def authorize_payment(canonical_id):
    """Release payment for one approved case — and THE ONLY PLACE a full account number is read.

    WHY A POST THAT ALSO RETURNS DATA. Revealing the account number IS the act of authorising the
    payment: an officer looks at it in order to pay it. Making that a POST means every reveal is a
    deliberate, audit-logged action rather than a casual read that a page prefetch, a bot crawling
    GETs, or a browser's history restore could trigger.

    Repeatable on purpose. An officer who closed the window needs the number back, so a second
    call returns the same authorisation and re-reveals — and logs a second access. What it does
    NOT do is create a second payment row.

    Guarded, in order: this officer's division, the case is Approved, the case has a household,
    the household has bank details on file. Each refusal is distinct, because each has a different
    person who has to do something about it.
    """
    ds_division = g.ds_division
    ds_officer_id = g.ds_officer_id

    key = current_app.config.get("BANK_DETAILS_KEY")
    if not key:
        current_app.logger.error("payment authorisation attempted with no BANK_DETAILS_KEY")
        return jsonify({"error": "server_misconfigured"}), 500

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT c.id, c.status, c.approved_amount, c.household_id,
                                  h.household_ref, h.bank_details_ciphertext, h.bank_account_last4
                             FROM cases c
                             LEFT JOIN households h ON h.id = c.household_id
                            WHERE c.canonical_id = %s AND c.ds_division_id = %s""",
                        (canonical_id.upper(), ds_division),
                    )
                    row = cur.fetchone()
                    # 404 whether the case does not exist or belongs to another division — a
                    # distinct 403 would confirm the existence of cases outside this division.
                    if not row:
                        return jsonify({"error": "not_found"}), 404

                    case_id, status, approved_amount, household_id, household_ref, \
                        ciphertext, last4 = row

                    if status != "Approved":
                        # The DWC administrator approves; the DS office pays. Paying something not
                        # yet approved would bypass the human decision NFR-6.1 exists to require.
                        return jsonify({"error": "not_approved", "status": status}), 409
                    if not household_id:
                        # Pre-Epic-8 or seeded. There is no registered family to pay.
                        return jsonify({"error": "no_household"}), 409
                    if not ciphertext:
                        return jsonify({"error": "no_bank_details",
                                        "household_ref": household_ref}), 409

                    try:
                        details = decrypt_bank_details(ciphertext, key)
                    except BankDecryptFailed:
                        # Distinct from "no bank details on file": telling the officer the family
                        # gave none would send them to collect details the family already gave.
                        current_app.logger.exception("bank detail decryption failed")
                        return jsonify({"error": "bank_details_unreadable"}), 500

                    # One payment row per case (migration 018 + 028). A repeat call re-reveals and
                    # re-audits, but must never create a second authorisation.
                    cur.execute(
                        """UPDATE payment_authorizations
                              SET ds_authorized_by = %s, ds_authorized_at = now(),
                                  household_id = COALESCE(household_id, %s),
                                  bank_account_last4 = COALESCE(bank_account_last4, %s)
                            WHERE case_id = %s
                        RETURNING id, amount_lkr, ds_authorized_at""",
                        (ds_officer_id, household_id, last4, case_id),
                    )
                    auth_row = cur.fetchone()
                    if not auth_row:
                        # Approved with no authorisation row: only possible for a case approved
                        # before Story 5.5 wired the insert. Report it rather than inventing one.
                        return jsonify({"error": "no_payment_authorization"}), 409

                    # NFR-3.4. The account number itself is NOT in the metadata — the log records
                    # that a reveal happened, never what was revealed.
                    write_audit_log(
                        cur, case_id, "ds_authorized_payment", ds_officer_id,
                        {
                            "ip_address": _client_ip(),
                            "ds_division": ds_division,
                            "household_ref": household_ref,
                            "amount_lkr": float(auth_row[1]) if auth_row[1] is not None else None,
                            "bank_account_last4": last4,
                        },
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("payment authorisation failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({
        "canonical_id": canonical_id.upper(),
        "household_ref": household_ref,
        "amount_lkr": float(auth_row[1]) if auth_row[1] is not None else None,
        "authorized_at": auth_row[2].isoformat() if auth_row[2] else None,
        # The one response on the platform that carries a full account number.
        "bank_details": details,
    }), 200
