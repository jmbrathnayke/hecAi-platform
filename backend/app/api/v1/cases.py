"""Case submission API (Story 2.4).

POST /api/v1/cases/submit — authenticated (Supabase JWT). Stores a citizen's case,
assigns the canonical HEC-YYYY-NNNN id, and writes an append-only audit_log row.
Idempotent on offline_id: a repeated submission returns the same canonical_id (200)
rather than creating a duplicate (CRITICAL #6) — race-safe via INSERT ... ON CONFLICT.
"""
from datetime import datetime, timezone

import psycopg2
from flask import Blueprint, current_app, jsonify, request

from app.api.v1.middleware.auth import authenticated_claims, authz_role
from app.infrastructure import registry
from app.infrastructure.audit import write_audit_log
from app.infrastructure.ml import compensation

cases_bp = Blueprint("cases", __name__)


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


@cases_bp.route("/cases/submit", methods=["POST"])
def submit_case():
    # Verification is delegated to the shared middleware (code review 2026-08-13).
    #
    # This route used to carry its OWN private copy of the auth front half — a local
    # `_verify_jwt()` hard-coded to `algorithms=["HS256"]` against SUPABASE_JWT_SECRET, plus its
    # own missing-secret 500. When the guards moved to ES256-via-JWKS, this copy was left behind:
    # a real Supabase token reaching the only case-submission endpoint in the platform raised
    # InvalidAlgorithmError and 401'd every citizen and officer-assisted submission. Worse, once
    # the now-legacy shared secret is dropped from the deployment (render.yaml calls it a
    # fallback that is ignored while SUPABASE_URL is set) the same route 500s before it even
    # reads the token. The whole suite stayed green throughout because its fixtures mint HS256
    # tokens against a secret-only config. One decode path, one error contract, no drift.
    claims, error = authenticated_claims()
    if error:
        return error

    body = request.get_json(silent=True) or {}
    offline_id = body.get("offline_id")
    if not offline_id:
        return jsonify({"error": "offline_id_required"}), 400
    damage_category = body.get("damage_category")
    if not damage_category:
        return jsonify({"error": "damage_category_required"}), 400
    if not isinstance(damage_category, str):
        return jsonify({"error": "invalid_damage_category"}), 400

    # Officer-assisted submission (Story 3.5, FR-1.2). Branch on a strict-bool flag so the
    # anonymous/citizen path (flag absent or false) is completely unchanged. When set, the
    # request must come from an officer-role token AND carry an officer_id that matches the
    # verified JWT `sub` — officer_id is NEVER trusted from the body (mirrors require_officer()).
    submitted_by_officer = body.get("submitted_by_officer") is True
    officer_id = None
    if submitted_by_officer:
        # app_metadata, not user_metadata — see middleware/auth.py. Reading the role from the
        # client-writable field here would let any citizen self-flag as an officer and file
        # officer-attributed cases.
        if authz_role(claims) != "officer":
            return jsonify({"error": "forbidden"}), 403
        sub = claims.get("sub")
        body_officer_id = body.get("officer_id")
        # Require BOTH a non-empty sub and a matching body officer_id — a validly-signed token
        # missing `sub` must never pass by both sides being falsy/None (e.g. body omits
        # officer_id too), which would otherwise insert a NULL officer_id for an officer-flagged row.
        if not sub or not body_officer_id or body_officer_id != sub:
            return jsonify({"error": "forbidden"}), 403
        officer_id = sub

    # Citizen ownership (Story 4.0, NFR-3.2). On the non-officer path, link the case to the
    # authenticated citizen's Supabase UID (from the verified JWT `sub`, NEVER the body). This
    # endpoint already requires a valid JWT, so there is no anonymous online submit; a staff token
    # here (officer/admin not using the officer-assisted flag) is not a citizen and leaves it NULL.
    citizen_id = None
    if not submitted_by_officer:
        role = authz_role(claims)
        sub = claims.get("sub")
        if sub and role not in ("officer", "admin", "system_admin"):
            citizen_id = sub

    # Defensive type-coercion on attacker-controllable JSON.
    gps = body.get("gps")
    if not isinstance(gps, dict):
        gps = {}
    ts = body.get("timestamp_local")
    year = ts[:4] if isinstance(ts, str) else ""
    if not year.isdigit():
        year = str(datetime.now(timezone.utc).year)

    # District / DS division are NO LONGER read from the body (Story 8.4, FR-10.6). They are
    # copied from the registered household inside the transaction below, so a case can never be
    # stored with a division the client chose, mistyped, or omitted. The old picker fields are
    # ignored rather than rejected: an offline client built before Epic 8 still sends them, and
    # failing those submissions outright would lose reports that are otherwise perfectly valid.
    district = None
    ds_division = None
    ai_severity = body.get("ai_severity")
    ai_severity = ai_severity if isinstance(ai_severity, str) and ai_severity else None

    # Case locale for notifications (Story 5.6, FR-6.3, OQ-B)
    locale = body.get("locale")
    locale = locale if isinstance(locale, str) and locale in ("si", "ta", "en") else "si"

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                # Fast path: an already-submitted offline_id returns its canonical id
                # without burning a sequence value (sequential retries).
                cur.execute(
                    "SELECT canonical_id FROM cases WHERE offline_id = %s", (offline_id,)
                )
                existing = cur.fetchone()
                if existing:
                    return jsonify({"canonical_id": existing[0], "offline_id": offline_id}), 200

                # --- FR-10.3 registration gate (Story 8.4) --------------------------------
                # Resolved INSIDE the transaction, so a household cannot be revoked between the
                # check and the insert. Placed AFTER the idempotency fast path on purpose: a
                # retry of an already-accepted case must keep returning its canonical id even if
                # the household has since been transferred or revoked.
                if submitted_by_officer:
                    # The officer is holding the citizen's card and has looked the family up;
                    # the reference travels in the body. Their own id still comes from the JWT.
                    household = registry.resolve_by_ref(cur, body.get("household_ref"))
                else:
                    # Never from the body — a client that could name its own household could file
                    # cases against someone else's registration.
                    household = registry.resolve_by_registrant(cur, citizen_id)

                if not household:
                    # 403, not 400: the request is well-formed and the caller is authenticated;
                    # what is missing is a registration, and no amount of editing this payload
                    # fixes that. The client sends them to /register.
                    return jsonify({"error": "not_registered"}), 403

                household_id = household["id"]
                district = household["district"]
                ds_division = household["ds_division"]

                cur.execute("SELECT nextval('hec_canonical_seq')")
                seq = cur.fetchone()[0]
                canonical_id = f"HEC-{year}-{seq:04d}"

                # Race-safe insert: a concurrent submit of the same offline_id yields no
                # row (ON CONFLICT DO NOTHING); fall back to returning the winner's id.
                cur.execute(
                    """INSERT INTO cases
                         (offline_id, canonical_id, damage_category,
                          gps_lat, gps_lng, submitter_identity_hash,
                          officer_id, submitted_by_officer, citizen_id,
                          district, ds_division_id, locale, household_id)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (offline_id) DO NOTHING
                       RETURNING id""",
                    (
                        offline_id,
                        canonical_id,
                        damage_category,
                        gps.get("lat"),
                        gps.get("lng"),
                        body.get("submitter_identity_hash"),
                        officer_id,
                        submitted_by_officer,
                        citizen_id,
                        district,
                        ds_division,
                        locale,
                        # Appended rather than inserted mid-list so every existing positional
                        # index in this statement — and in the tests that assert on them — is
                        # unchanged.
                        household_id,
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    # Lost the race — return the existing canonical id (idempotent).
                    cur.execute(
                        "SELECT canonical_id FROM cases WHERE offline_id = %s", (offline_id,)
                    )
                    won = cur.fetchone()
                    return jsonify({"canonical_id": won[0], "offline_id": offline_id}), 200

                case_id = row[0]
                write_audit_log(cur, case_id, "submitted", claims.get("sub"))
                compensation.estimate_and_store(
                    cur, case_id, damage_category, ds_division, datetime.now(timezone.utc),
                    district=district, ai_severity=ai_severity,
                )
        return jsonify({"canonical_id": canonical_id, "offline_id": offline_id}), 201
    finally:
        conn.close()
