"""Who submitted a case: the registered household behind it (2026-10-07).

    GET /api/v1/cases/<ref>/claimant   the case's household and its members   (officer, admin, ds_officer)

WHAT THIS CLOSES. Every staff screen showed a case's damage, its photographs and the family's own
words, and nothing about the family. The officer who had to visit could not see an address or a
number to call; the DWC administrator approving the claim could not see whose claim it was; the
Divisional Secretariat paying it had a household reference and no names to read aloud. PRD FR-5.2
asks for the claimant's identity and contact on the case detail, and the UX spec's DS verification
panel (registrant name and declared members) was designed and never built. This endpoint is both.

A DELIBERATE CHANGE OF POLICY. Migrations 029, 035 and 039 say contact_email, address and
contact_mobile must never appear in officer or administrator views. That rule is relaxed HERE AND
ONLY HERE, by decision of 2026-10-07, under the same bounds that admitted citizen_description:
  - one case at a time, never a list. officer.py, admin.py and ds.py's case lists, the CSV/PDF
    export and the research export are unchanged and stay free of identity and contact;
  - the case's own scope, taken from the JWT -- case_photos._resolve_case, verbatim. Out of scope
    is 404, never 403;
  - every read writes `case_claimant_viewed` to the hash-chained audit_log, so who looked a
    family up is answerable afterwards.

WHAT IT NEVER RETURNS. No NIC in any form: the platform holds only nic_hmac, and a digest handed to
a client is an offline dictionary to attack. No bank ciphertext and no registrant_uid. The bank
account's last four digits go to the DS officer alone, who already sees them on their case list and
is the only role that pays; the full number stays behind ds.py's authorize-payment.
"""
import psycopg2
from flask import Blueprint, current_app, jsonify

from app.api.v1.case_photos import _resolve_case
from app.api.v1.households import HOUSEHOLD_COLUMNS, household_view
from app.api.v1.middleware.auth import authenticated_claims, authz_role
from app.infrastructure.audit import write_audit_log

case_claimant_bp = Blueprint("case_claimant", __name__)

STAFF_ROLES = ("officer", "admin", "ds_officer")


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@case_claimant_bp.route("/cases/<ref>/claimant", methods=["GET"])
def get_case_claimant(ref):
    """The registered household that filed this case, or {"household": null} when none is linked."""
    claims, error = authenticated_claims()
    if error:
        return error
    role = authz_role(claims)
    # A citizen already has their own household on /households/me, and system_admin reviews no
    # cases. Neither is told whether the case exists.
    if role not in STAFF_ROLES:
        return jsonify({"error": "not_found"}), 404

    try:
        conn = _get_connection()
    except psycopg2.Error:
        current_app.logger.exception("case claimant: no database connection")
        return jsonify({"error": "unavailable"}), 503
    try:
        with conn:
            with conn.cursor() as cur:
                case_id, _ = _resolve_case(cur, ref, claims)
                if case_id is None:
                    return jsonify({"error": "not_found"}), 404

                # A case with no household predates Epic 8 or is seeded research data
                # (migration 025). It is reported as such, not as an error.
                cur.execute(
                    f"""SELECT {HOUSEHOLD_COLUMNS} FROM households
                         WHERE id = (SELECT household_id FROM cases WHERE id = %s)""",
                    (case_id,),
                )
                row = cur.fetchone()
                household = household_view(cur, row) if row else None
                if household is not None and role != "ds_officer":
                    household.pop("bank_account_last4", None)

                write_audit_log(cur, case_id, "case_claimant_viewed", claims.get("sub"),
                                {"role": role, "household_linked": household is not None})
                return jsonify({"household": household})
    except psycopg2.Error:
        current_app.logger.exception("case claimant read failed")
        return jsonify({"error": "unavailable"}), 503
    finally:
        conn.close()
