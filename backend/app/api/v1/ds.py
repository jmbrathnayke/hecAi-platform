"""Divisional Secretariat API (Story 8.5, PRD Section 3, NFR-3.2).

    GET  /api/v1/ds/cases                               cases in this officer's DS division
    POST /api/v1/ds/cases/<ref>/final-decision          the human final compensation decision
    POST /api/v1/ds/cases/<ref>/authorize-payment       release payment (after the decision)

THE FINAL GOVERNANCE STEP. The Random Forest produces an AI-assisted estimate; the DWC administrator
reviews the officer's assessment and forwards an approved case with a recommended amount. Neither of
those is the compensation decision. The Divisional Secretariat officer reviews both and records the
final amount -- a human decision, audit-logged with its reason -- and only then may payment be
authorised. (All ds_officer JWT.)

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
import math

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_ds_officer
from app.infrastructure.audit import write_audit_log
from app.domain.validation import MIN_REASON_LENGTH
from app.infrastructure.security.bank_crypto import BankDecryptFailed, decrypt_bank_details
from app.infrastructure.notifications import notify_status_change_all
from app.infrastructure.push.push_service import notify_staff_push
from app.infrastructure.security.nic_identity import NicPepperMissing, nic_hmac

ds_bp = Blueprint("ds", __name__)

# Must match admin.py's _ACTION_TARGET_STATUS["mark_paid"] and the seeded template rows in
# migrations 019 and 030. A divergence here would leave the DS-authorised path with no template
# in any language, so every notification would log template_missing and none would be sent.
_PAID_STATUS = "Payment Processed"
_APPROVED_STATUS = "Approved"
# Notification event, not a case status (migration 033 seeds its templates). The status stays
# "Approved" until payment is authorised; the citizen is told the confirmed amount in between.
_FINAL_DECISION_EVENT = "Final Decision"

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
                                  c.approved_amount, h.household_ref,
                                  ce.amount_lkr, ce.model_version, c.district,
                                  (c.officer_assessed_at IS NOT NULL
                                   OR COALESCE(c.submitted_by_officer, FALSE)),
                                  c.ds_final_amount, c.ds_final_reason, c.ds_final_at,
                                  pa.ds_authorized_at
                             FROM cases c
                             LEFT JOIN households h ON h.id = c.household_id
                             LEFT JOIN compensation_estimates ce ON ce.case_id = c.id
                             LEFT JOIN payment_authorizations pa ON pa.case_id = c.id
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
                            # Decision support, labelled as such everywhere it is shown. The DWC
                            # administrator's approved_amount above is a recommendation too.
                            "ai_estimate": {
                                "amount_lkr": float(r[9]) if r[9] is not None else None,
                                "model_version": r[10],
                                "is_final_decision": False,
                            },
                            "district": r[11],
                            "officer_assessed": bool(r[12]),
                            "final_decision": {
                                "amount_lkr": float(r[13]) if r[13] is not None else None,
                                "reason": r[14],
                                "decided_at": r[15].isoformat() if r[15] else None,
                            } if r[15] is not None else None,
                            "payment_authorized": r[16] is not None,
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


def _parse_final_amount(value):
    """A non-negative, finite number of rupees. Zero is legitimate (assessed, nothing payable)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return round(float(value), 2)


def _final_decision_payload(ref, amount, reason, decided_at, ai_estimate, approved_amount,
                            revised, unchanged=False):
    return {
        "canonical_id": ref,
        "final_decision": {
            "amount_lkr": amount,
            "reason": reason,
            "decided_at": decided_at.isoformat() if decided_at else None,
            "is_final_decision": True,
            "revised": revised,
            "unchanged": unchanged,
        },
        "ai_estimate_lkr": ai_estimate,
        "dwc_approved_amount_lkr": approved_amount,
    }


@ds_bp.route("/ds/cases/<string:canonical_id>/final-decision", methods=["POST"])
@require_ds_officer()
def record_final_decision(canonical_id):
    """The Divisional Secretariat's final compensation decision for one approved case.

    WHAT IT DECIDES. The amount the family will be paid. The AI-assisted estimate and the DWC
    administrator's recommended amount are both shown to the officer and both recorded beside the
    decision in the audit trail, but neither binds it: the officer may confirm either or enter a
    different figure. A figure that departs from the AI estimate needs a written reason -- the same
    floor as an administrator's override -- so the record says why a human disagreed with the model.

    Revisable until payment is authorised, and not after: once the account number has been released
    the amount on the authorisation is what was paid. A repeat of the identical decision is a no-op,
    so a double-click neither re-audits nor re-notifies the family.

    The status stays "Approved". The five-status vocabulary is shared with the public status page,
    the SMS grammar and the analytics; the decision is its own recorded checkpoint instead.
    """
    ds_division = g.ds_division
    ds_officer_id = g.ds_officer_id

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    amount = _parse_final_amount(body.get("amount_lkr"))
    if amount is None:
        return jsonify({"error": "invalid_amount"}), 400

    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        return jsonify({"error": "invalid_reason"}), 400
    reason = reason.strip() if reason else None

    ref = canonical_id.strip().upper()

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # FOR UPDATE OF c: a double-submitted decision, or two officers in the same
                    # office, must not interleave; the second waits and sees the first's result.
                    cur.execute(
                        """SELECT c.id, c.status, c.approved_amount, c.district,
                                  c.citizen_mobile_plain, c.ds_final_amount, c.ds_final_reason,
                                  c.ds_final_at, ce.amount_lkr, pa.id, pa.ds_authorized_at
                             FROM cases c
                             LEFT JOIN compensation_estimates ce ON ce.case_id = c.id
                             LEFT JOIN payment_authorizations pa ON pa.case_id = c.id
                            WHERE c.canonical_id = %s AND c.ds_division_id = %s
                              FOR UPDATE OF c""",
                        (ref, ds_division),
                    )
                    row = cur.fetchone()
                    # 404 for another division too -- see authorize_payment.
                    if not row:
                        return jsonify({"error": "not_found"}), 404

                    (case_id, status, approved_amount, district, citizen_mobile_plain,
                     previous_amount, previous_reason, previous_at, ai_estimate, payment_id,
                     ds_authorized_at) = row
                    ai_estimate = float(ai_estimate) if ai_estimate is not None else None
                    approved_amount = float(approved_amount) if approved_amount is not None else None
                    previous_amount = float(previous_amount) if previous_amount is not None else None

                    if status != _APPROVED_STATUS:
                        # Only a case the DWC administrator approved and forwarded reaches the
                        # final review. A paid or rejected case is closed.
                        return jsonify({"error": "not_approved", "status": status}), 409
                    if ds_authorized_at is not None:
                        return jsonify({"error": "payment_already_authorized"}), 409
                    if payment_id is None:
                        # Approved before Story 5.5 wired the authorisation insert. Reported rather
                        # than inventing a payment record.
                        return jsonify({"error": "no_payment_authorization"}), 409

                    differs_from_ai = ai_estimate is None or amount != ai_estimate
                    if differs_from_ai and (not reason or len(reason) < MIN_REASON_LENGTH):
                        return jsonify({"error": "reason_required",
                                        "min_length": MIN_REASON_LENGTH}), 400

                    if previous_amount is not None and previous_amount == amount \
                            and (previous_reason or None) == reason:
                        return jsonify(_final_decision_payload(
                            ref, amount, reason, previous_at, ai_estimate, approved_amount,
                            revised=False, unchanged=True)), 200

                    # The amount on the authorisation is what the DS office will pay.
                    cur.execute(
                        """UPDATE payment_authorizations SET amount_lkr = %s
                            WHERE id = %s AND ds_authorized_at IS NULL""",
                        (amount, payment_id),
                    )
                    cur.execute(
                        """UPDATE cases
                              SET ds_final_amount = %s, ds_final_reason = %s, ds_final_by = %s,
                                  ds_final_at = now(), updated_at = now()
                            WHERE id = %s
                        RETURNING ds_final_at""",
                        (amount, reason, ds_officer_id, case_id),
                    )
                    decided_at = cur.fetchone()[0]

                    revised = previous_amount is not None
                    write_audit_log(
                        cur, case_id, "ds_final_decision", ds_officer_id,
                        {
                            "ip_address": _client_ip(),
                            "ds_division": ds_division,
                            "final_amount_lkr": amount,
                            "ai_estimate_lkr": ai_estimate,
                            "dwc_approved_amount_lkr": approved_amount,
                            "differs_from_ai_estimate": differs_from_ai,
                            "reason": reason,
                            "revised": revised,
                            "previous_amount_lkr": previous_amount,
                            "decided_by": "human_ds_officer",
                        },
                    )
                    # The family learns the confirmed amount -- and again if it is corrected before
                    # payment, since the earlier message named a figure that is no longer true. A
                    # revision that changes only the written reason is not news to the family.
                    if previous_amount != amount:
                        notify_status_change_all(
                            cur, case_id, ref, citizen_mobile_plain, _FINAL_DECISION_EVENT,
                            ds_officer_id, amount_lkr=amount,
                        )
                    notify_staff_push(cur, case_id, "final_decision_recorded", "admin", district,
                                      ref, ds_officer_id)
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("DS final decision failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify(_final_decision_payload(ref, amount, reason, decided_at, ai_estimate,
                                           approved_amount, revised=revised)), 200


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
                                  h.household_ref, h.bank_details_ciphertext,
                                  h.bank_account_last4, c.citizen_mobile_plain,
                                  pa.ds_authorized_at, c.ds_final_amount, c.district
                             FROM cases c
                             LEFT JOIN households h ON h.id = c.household_id
                             LEFT JOIN payment_authorizations pa ON pa.case_id = c.id
                            WHERE c.canonical_id = %s AND c.ds_division_id = %s""",
                        (canonical_id.upper(), ds_division),
                    )
                    row = cur.fetchone()
                    # 404 whether the case does not exist or belongs to another division — a
                    # distinct 403 would confirm the existence of cases outside this division.
                    if not row:
                        return jsonify({"error": "not_found"}), 404

                    case_id, status, approved_amount, household_id, household_ref, \
                        ciphertext, last4, citizen_mobile_plain, previously_authorized, \
                        ds_final_amount, district = row

                    # Read BEFORE the UPDATE below overwrites ds_authorized_at. This endpoint is
                    # repeatable on purpose — an officer who closed the window needs the account
                    # number back — so without this every re-reveal would re-announce a payment
                    # the citizen was already told about.
                    first_authorization = previously_authorized is None

                    if status not in (_APPROVED_STATUS, _PAID_STATUS):
                        # The DWC administrator approves; the DS office pays. Paying something not
                        # yet approved would bypass the human decision NFR-6.1 exists to require.
                        #
                        # _PAID_STATUS is admitted too, and must be: this endpoint's own docstring
                        # promises a repeat call re-reveals for an officer who closed the window,
                        # and the first call now moves the case OFF "Approved". Accepting only
                        # "Approved" would make the endpoint work exactly once and then lock the
                        # officer out of the account number they are in the middle of paying.
                        return jsonify({"error": "not_approved", "status": status}), 409
                    if status == _APPROVED_STATUS and ds_final_amount is None \
                            and previously_authorized is None:
                        # The final compensation decision is a separate, recorded human act and it
                        # comes first: paying the administrator's recommendation, or the model's
                        # estimate, by default would make either one the decision in practice.
                        return jsonify({"error": "final_decision_required"}), 409
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

                    # THE CITIZEN IS TOLD BY THE OFFICE THAT ACTUALLY PAYS.
                    #
                    # Before this, "Payment Processed" could only be set by the DWC administrator's
                    # mark_paid action — but the administrator does not disburse and has no way to
                    # know when the DS office did. The citizen's "you have been paid" message
                    # therefore depended on a phone call between two organisations that the
                    # software knew nothing about, and never arrived at all if that call was not
                    # made. Releasing the account number IS the disbursement decision, so it is the
                    # event that should announce itself.
                    #
                    # WHAT "Payment Processed" MEANS, stated because it is easy to overclaim: the
                    # DS office has authorised and released the payment. It does NOT mean funds
                    # have landed — the platform does not move money (PRD Section 4b non-goal) and
                    # cannot observe the Divisional Secretariat's financial system. This is the
                    # last event the platform can honestly witness.
                    #
                    # mark_paid stays on the admin side as a manual fallback for cases authorised
                    # outside the system, and is unchanged.
                    # Announce ONLY when this call is the one making the transition. A case already
                    # at _PAID_STATUS was either authorised here before, or marked paid by the
                    # administrator — who has already notified. Re-announcing would tell a citizen
                    # twice that they had been paid once.
                    if first_authorization and status == _APPROVED_STATUS:
                        cur.execute(
                            # updated_at is bumped deliberately: list_cases' avg_processing_days
                            # KPI is computed from it, and a status change that left it stale
                            # would quietly distort Epic 7's analytics.
                            "UPDATE cases SET status = %s, updated_at = now() WHERE id = %s",
                            (_PAID_STATUS, case_id),
                        )
                        write_audit_log(
                            cur, case_id, "case_paid", ds_officer_id,
                            {"ds_division": ds_division, "authorized_by": "ds_officer"},
                        )
                        notify_status_change_all(
                            cur, case_id, canonical_id.upper(), citizen_mobile_plain,
                            _PAID_STATUS, ds_officer_id,
                            amount_lkr=float(auth_row[1]) if auth_row[1] is not None else None,
                        )
                        # Staff who handled the case are told it is closed: the district
                        # administrator and the field officers of the division.
                        notify_staff_push(cur, case_id, "payment_processed", "admin", district,
                                          canonical_id.upper(), ds_officer_id)
                        notify_staff_push(cur, case_id, "payment_processed", "officer",
                                          ds_division, canonical_id.upper(), ds_officer_id)
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


@ds_bp.route("/households/<string:household_ref>/transfer", methods=["POST"])
@require_ds_officer()
def transfer_registration(household_ref):
    """Move registrant status to another declared member (Story 8.7, FR-10.5).

    THE PROBLEM THIS SOLVES. A household is registered against one person, and that registration
    is what lets the family claim at all (FR-10.3). If the registrant dies or is incapacitated,
    every NIC in that family is already occupied by their own registration — so nobody can
    re-register, and the family is permanently locked out of compensation by a control that exists
    to protect them. This endpoint is the release valve, and it is deliberately a Divisional
    Secretariat action rather than a self-service one: the DS office is where a death is evidenced
    in the real process.

    THE HOUSEHOLD STAYS 'active'. Migration 023's comment suggested a transfer should move the
    status to 'transferred'; that would be exactly wrong. registry.py admits only 'active'
    households to the submit gate, so marking it 'transferred' would lock the family out — the
    outcome FR-10.5 exists to prevent. The transfer is recorded by the is_registrant flip and by
    the audit trail, not by a status that disables the row. 'transferred' remains unused.

    The old registrant's row is KEPT, with is_registrant cleared. Deleting it would free their NIC
    for a fresh registration elsewhere and erase the family's declared composition — both wrong.
    """
    ds_division = g.ds_division
    ds_officer_id = g.ds_officer_id

    pepper = current_app.config.get("NIC_PEPPER")
    if not pepper:
        current_app.logger.error("registration transfer attempted with no NIC_PEPPER configured")
        return jsonify({"error": "server_misconfigured"}), 500

    body = request.get_json(silent=True) or {}

    reason = body.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < MIN_REASON_LENGTH:
        # Same floor as an AI override and an admin case action. A transfer moves who may claim
        # a family's compensation; it must not be possible to do it without saying why.
        return jsonify({"error": "reason_required",
                        "min_length": MIN_REASON_LENGTH}), 400
    reason = reason.strip()

    try:
        new_digest = nic_hmac(body.get("new_registrant_nic"), pepper)
    except NicPepperMissing:
        return jsonify({"error": "server_misconfigured"}), 500
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_nic"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, status FROM households "
                        " WHERE household_ref = %s AND ds_division = %s",
                        (household_ref.strip().upper(), ds_division),
                    )
                    row = cur.fetchone()
                    # 404 for "not in your division" as well as "does not exist" — a distinct 403
                    # would confirm the existence of households outside this officer's division.
                    if not row:
                        return jsonify({"error": "not_found"}), 404

                    household_id, status = row
                    if status != "active":
                        return jsonify({"error": "household_not_active",
                                        "status": status}), 409

                    # The new registrant must ALREADY be a declared member of THIS household.
                    # Allowing an arbitrary NIC would turn this into a back door for registering
                    # someone into a family they were never declared part of.
                    cur.execute(
                        "SELECT id, is_registrant FROM household_members "
                        " WHERE household_id = %s AND nic_hmac = %s",
                        (household_id, new_digest),
                    )
                    member = cur.fetchone()
                    if not member:
                        return jsonify({"error": "not_a_member"}), 404
                    new_member_id, already_registrant = member
                    if already_registrant:
                        # Not an error worth failing over, but not a silent success either: the
                        # officer believes they changed something.
                        return jsonify({"error": "already_registrant"}), 409

                    cur.execute(
                        "UPDATE household_members SET is_registrant = FALSE "
                        " WHERE household_id = %s AND is_registrant",
                        (household_id,),
                    )
                    cur.execute(
                        "UPDATE household_members SET is_registrant = TRUE WHERE id = %s",
                        (new_member_id,),
                    )
                    # registrant_uid is CLEARED, not moved: it holds a Supabase account id, and the
                    # DS office has no way to know the new registrant's app account. The family is
                    # not locked out by this — officer-assisted and SMS reporting both resolve by
                    # NIC and continue to work (asserted by test). What stops working is citizen
                    # SELF-SERVICE until the new registrant links an account, which is not built.
                    cur.execute(
                        "UPDATE households SET registrant_uid = NULL, updated_at = now() "
                        " WHERE id = %s",
                        (household_id,),
                    )

                    # FR-10.5 requires this in the append-only hash-chained trail. No NIC and no
                    # digest in the metadata — the reason and the actor are the record.
                    write_audit_log(
                        cur, None, "household_registrant_transferred", ds_officer_id,
                        {
                            "ip_address": _client_ip(),
                            "ds_division": ds_division,
                            "household_ref": household_ref.strip().upper(),
                            "reason": reason,
                        },
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("registration transfer failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({
        "household_ref": household_ref.strip().upper(),
        "status": "active",
        "transferred_by": ds_officer_id,
    }), 200
