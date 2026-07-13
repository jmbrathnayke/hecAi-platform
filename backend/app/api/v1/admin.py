"""Admin case-list + case-detail API (Stories 5.3/5.4, FR-5.1/FR-5.2/FR-7.1).

GET /api/v1/admin/cases -- admin-authenticated (Supabase JWT via require_admin()).
District-scoped: WHERE district = g.district_id, from the verified JWT only, never a
request param. Mirrors officer.py's list_cases() shape at district instead of
officer/division scope. Payload never includes NIC in any form (no submitter_identity_hash,
no citizen_nic_plain) -- case detail (Story 5.4) is a separate, more privileged view.

GET /api/v1/admin/cases/<offline_id> -- Story 5.4 case detail. Same district-scoping rule.
Never returns citizen_nic_plain (migration 009: write-only, must never be returned by any
read endpoint) or submitter_identity_hash (code review fix: unused by the frontend, not
required by any AC, and an unnecessary exposure surface -- see deferred-work.md).

GET /api/v1/admin/audit/verify-chain -- Story 5.4 AC4. Wraps the existing, unmodified
infrastructure/audit.py::verify_chain() over the WHOLE audit_log table. The hash chain is
global (prev_hash links across every case/district in insertion order, not scoped to one
case) -- see infrastructure/audit.py's own docstring -- so this deliberately is NOT filtered
by case_id or district; a per-case "verification" would compare against the wrong prev_hash
and be cryptographically meaningless. Requires g.district_id like every other admin route
(code review fix: consistency guard, not a data-leak fix -- the response carries no case or
district data regardless) and is itself audited (admin_verified_chain, code review fix).

District-scoping convention (Story 5.3 PO-Ratified Resolution 1): admin user_metadata.
district_id holds the REAL Sinhala district name (matching district_reference.json's
vocabulary from Story 5.2), not an arbitrary numeric code -- so g.district_id can be
compared directly against cases.district with no separate mapping table. A case with
district IS NULL (still most cases today -- district capture is optional and only two of
three intake channels support it) is excluded from every admin's view; there is no
inclusive fallback the way officer's ds_division_id/officer_id OR-condition works, because
admin has no equivalent "cases I personally touched" concept.
"""
import uuid
from datetime import date

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_admin
from app.infrastructure.audit import verify_chain, write_audit_log

admin_bp = Blueprint("admin", __name__)

ALLOWED_SORT = {"submitted_at", "canonical_id", "damage_category", "status"}
MAX_LIMIT = 50


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote_addr or "")


def _int_param(args, name, default):
    try:
        return int(args.get(name, default))
    except (TypeError, ValueError):
        return default


def _parse_date(value):
    """Returns a `date` for a valid ISO date/datetime string, or `_INVALID` sentinel for
    a non-empty-but-unparseable value (distinct from `None`, which means "not supplied
    at all" -- code review fix: malformed from/to previously reached Postgres unvalidated
    and surfaced as an opaque 500 instead of a 400, unlike every other endpoint's
    reject-bad-input-early convention (e.g. sync.py's _validate_item)."""
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return _INVALID


_INVALID = object()


def _build_conditions(district, args):
    """Every condition is `c.<col> = %s`-shaped so the same list works unmodified against
    every query below (all queries alias cases as `c`) -- avoids ever having to rewrite a
    condition string between a paginated-list query and a single-table KPI query."""
    conditions = ["c.district = %s"]
    params = [district]

    status_filter = args.get("status")
    if status_filter:
        conditions.append("c.status = %s")
        params.append(status_filter)
    from_date = _parse_date(args.get("from"))
    if from_date is _INVALID:
        return None, None
    if from_date is not None:
        conditions.append("c.submitted_at >= %s")
        params.append(from_date)
    to_date = _parse_date(args.get("to"))
    if to_date is _INVALID:
        return None, None
    if to_date is not None:
        conditions.append("c.submitted_at <= %s")
        params.append(to_date)
    damage_type = args.get("type")
    if damage_type:
        conditions.append("c.damage_category = %s")
        params.append(damage_type)
    division = args.get("division")
    if division:
        conditions.append("c.ds_division_id = %s")
        params.append(division)

    return conditions, params


@admin_bp.route("/admin/cases", methods=["GET"])
@require_admin()
def list_cases():
    district = g.district_id  # verified JWT claim -- never from the request
    if not district:
        # Code review fix: an admin JWT missing/empty district_id previously fell through
        # to a query that always returns zero rows, indistinguishable from "my district
        # genuinely has no cases yet." Surface the real problem instead.
        return jsonify({"error": "no_district_assigned"}), 403

    args = request.args

    page = max(1, _int_param(args, "page", 1))
    limit = min(MAX_LIMIT, max(1, _int_param(args, "limit", 20)))
    offset = (page - 1) * limit

    sort_col = args.get("sort", "submitted_at")
    if sort_col not in ALLOWED_SORT:
        sort_col = "submitted_at"
    sort_dir = "ASC" if args.get("dir", "desc").lower() == "asc" else "DESC"

    conditions, params = _build_conditions(district, args)
    if conditions is None:
        return jsonify({"error": "invalid_date"}), 400
    where = " AND ".join(conditions)

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT COUNT(*) FROM cases c WHERE {where}", params)
                    total = cur.fetchone()[0]

                    # Clamp offset to total (code review fix) -- an absurdly large `page`
                    # otherwise still runs a full scan-and-discard OFFSET for no benefit.
                    offset = min(offset, total)

                    # Explicit column list (never SELECT *) -- no submitter_identity_hash,
                    # no citizen_nic_plain, ever (CRITICAL #3). inference_log's confidence is
                    # pulled via a LATERAL subquery (code review fix), not a plain LEFT JOIN --
                    # inference_log has no uniqueness constraint on case_id and is append-only
                    # (an officer override is a second inserted row, not an update), so a plain
                    # join could duplicate a case in `items` once a case has >1 inference_log
                    # row -- exactly the fan-out class of bug the KPI queries were already
                    # written to avoid (CRITICAL #4). A tiebreaker (`c.id`) is added to ORDER BY
                    # so LIMIT/OFFSET pagination is deterministic across pages even when the
                    # sort column has duplicate values (code review fix).
                    cur.execute(
                        f"""SELECT c.canonical_id, c.offline_id, c.damage_category, c.status,
                                   c.submitted_at, c.updated_at, il.confidence
                              FROM cases c
                              LEFT JOIN LATERAL (
                                SELECT confidence FROM inference_log
                                 WHERE case_id = c.id
                                 ORDER BY created_at DESC
                                 LIMIT 1
                              ) il ON true
                             WHERE {where}
                             ORDER BY c.{sort_col} {sort_dir}, c.id {sort_dir}
                             LIMIT %s OFFSET %s""",
                        params + [limit, offset],
                    )
                    rows = cur.fetchall()

                    # KPIs: separate, purpose-built queries (CRITICAL #4) -- a single query
                    # joining compensation_estimates/status-breakdown into the same aggregate
                    # row risks fan-out duplication or an incorrect cross join.
                    cur.execute(
                        "SELECT COUNT(*) FILTER (WHERE submitted_at >= date_trunc('month', now())) "
                        "FROM cases WHERE district = %s",
                        [district],
                    )
                    this_month = cur.fetchone()[0]

                    cur.execute(
                        "SELECT status, COUNT(*) FROM cases WHERE district = %s GROUP BY status",
                        [district],
                    )
                    by_status = dict(cur.fetchall())

                    # approved_amount (Story 2.5), NOT compensation_estimates.amount_lkr --
                    # the latter is the AI's unapproved recommendation, not a decision
                    # (CRITICAL #5).
                    cur.execute(
                        "SELECT COALESCE(SUM(approved_amount), 0) FROM cases "
                        "WHERE district = %s AND status = 'Approved'",
                        [district],
                    )
                    total_approved = cur.fetchone()[0]

                    # COALESCE(updated_at, now()) (code review fix, matches Task 1's literal
                    # spec): updated_at is nullable by schema -- without this, a case that
                    # left 'Submitted' without updated_at ever being set would silently drop
                    # out of the AVG() instead of counting as "still processing."
                    cur.execute(
                        "SELECT AVG(EXTRACT(EPOCH FROM (COALESCE(updated_at, now()) - submitted_at)) / 86400) "
                        "FROM cases WHERE district = %s AND status != 'Submitted'",
                        [district],
                    )
                    avg_days_row = cur.fetchone()
                    avg_days = (
                        float(avg_days_row[0])
                        if avg_days_row and avg_days_row[0] is not None
                        else None
                    )

                    # AC5/NFR-3.4: record the admin-action (a read) in the audit log. case_id
                    # is NULL -- this event is not about a single case (mirrors officer.py's
                    # officer_viewed_cases pattern exactly).
                    write_audit_log(
                        cur,
                        None,
                        "admin_viewed_cases",
                        g.admin_id,
                        {"ip_address": _client_ip(), "result_count": len(rows)},
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("admin case list failed")
        return jsonify({"error": "server_error"}), 500

    items = [
        {
            "canonical_id": r[0],
            "offline_id": str(r[1]) if r[1] is not None else None,
            "damage_category": r[2],
            "status": r[3],
            "submitted_at": r[4].isoformat() if r[4] else None,
            "updated_at": r[5].isoformat() if r[5] else None,
            "ai_confidence": float(r[6]) if r[6] is not None else None,
        }
        for r in rows
    ]

    return (
        jsonify(
            {
                "total": total,
                "page": page,
                "limit": limit,
                "items": items,
                "kpis": {
                    "this_month": this_month,
                    "by_status": by_status,
                    "total_approved_lkr": float(total_approved),
                    "avg_processing_days": round(avg_days, 1) if avg_days is not None else None,
                },
            }
        ),
        200,
    )


# Defensive cap on the per-case audit trail (Story 5.4 CRITICAL #4 lineage) -- today's real
# volume is 1 row/case (no review actions exist until Story 5.5), but the query must not be
# unbounded regardless.
MAX_AUDIT_TRAIL_ROWS = 200


@admin_bp.route("/admin/cases/<offline_id>", methods=["GET"])
@require_admin()
def get_case_detail(offline_id):
    district = g.district_id  # verified JWT claim -- never from the request
    if not district:
        return jsonify({"error": "no_district_assigned"}), 403

    try:
        uuid.UUID(offline_id)
    except ValueError:
        return jsonify({"error": "invalid_offline_id"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # No row found -> 404 whether the case doesn't exist or belongs to a
                    # different district (CRITICAL #5 lineage) -- never distinguish, so a
                    # wrong-district admin can't probe for another district's case IDs.
                    # No submitter_identity_hash (code review fix): unused by the frontend,
                    # not required by any AC, and an unnecessary exposure surface for a value
                    # whose construction differs by intake channel (see deferred-work.md).
                    cur.execute(
                        """SELECT canonical_id, offline_id, damage_category, status,
                                  gps_lat, gps_lng, submitted_at, updated_at, submitted_via,
                                  approved_amount, id
                             FROM cases WHERE offline_id = %s AND district = %s""",
                        (offline_id, district),
                    )
                    row = cur.fetchone()
                    if row is None:
                        return jsonify({"error": "not_found"}), 404

                    case_id = row[10]

                    # ai_result: latest inference_log row only (CRITICAL: one row carries
                    # both the original prediction AND any override fields -- see
                    # inference.py -- never a join or a second row).
                    cur.execute(
                        """SELECT model_type, model_version, prediction, confidence,
                                  was_overridden, override_reason, override_category,
                                  input_features, created_at
                             FROM inference_log WHERE case_id = %s
                            ORDER BY created_at DESC LIMIT 1""",
                        (case_id,),
                    )
                    ai_row = cur.fetchone()

                    # compensation: 0 or 1 row (UNIQUE case_id, migration 013).
                    cur.execute(
                        """SELECT amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                                  model_version, dataset_version, created_at
                             FROM compensation_estimates WHERE case_id = %s""",
                        (case_id,),
                    )
                    comp_row = cur.fetchone()

                    # Code review fix: the naive `ORDER BY id ASC LIMIT %s` kept the OLDEST
                    # rows forever once a case exceeds the cap, permanently hiding newer
                    # events -- close to a functional inversion of "show what happened to
                    # this case." Select the most recent MAX_AUDIT_TRAIL_ROWS by id DESC,
                    # then re-sort ascending in Python for chronological display.
                    cur.execute(
                        """SELECT id, event, actor_id, metadata, created_at, hash, prev_hash
                             FROM audit_log WHERE case_id = %s
                            ORDER BY id DESC LIMIT %s""",
                        (case_id, MAX_AUDIT_TRAIL_ROWS),
                    )
                    audit_rows = list(reversed(cur.fetchall()))

                    # View-audit AFTER reading the trail above, so this view event doesn't
                    # appear in the trail it just rendered (cosmetic; it will show up next
                    # time -- same "not fighting it" note as list_cases's own view-audit).
                    write_audit_log(
                        cur, case_id, "admin_viewed_case_detail", g.admin_id,
                        {"ip_address": _client_ip()},
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("admin case detail failed")
        return jsonify({"error": "server_error"}), 500

    case = {
        "canonical_id": row[0],
        "offline_id": str(row[1]) if row[1] is not None else None,
        "damage_category": row[2],
        "status": row[3],
        "gps_lat": float(row[4]) if row[4] is not None else None,
        "gps_lng": float(row[5]) if row[5] is not None else None,
        "submitted_at": row[6].isoformat() if row[6] else None,
        "updated_at": row[7].isoformat() if row[7] else None,
        "submitted_via": row[8],
        "approved_amount": float(row[9]) if row[9] is not None else None,
    }

    ai_result = None
    if ai_row is not None:
        input_features = ai_row[7] or {}
        ai_result = {
            "model_type": ai_row[0],
            "model_version": ai_row[1],
            "prediction": ai_row[2],
            "confidence": float(ai_row[3]) if ai_row[3] is not None else None,
            "was_overridden": ai_row[4],
            "override_reason": ai_row[5],
            "override_category": ai_row[6],
            "ai_severity": input_features.get("ai_severity"),
            "created_at": ai_row[8].isoformat() if ai_row[8] else None,
        }

    compensation = None
    if comp_row is not None:
        compensation = {
            "amount_lkr": float(comp_row[0]),
            "raw_estimate_lkr": float(comp_row[1]),
            "capped": comp_row[2],
            "feature_values": comp_row[3],
            "model_version": comp_row[4],
            "dataset_version": comp_row[5],
            "created_at": comp_row[6].isoformat() if comp_row[6] else None,
        }

    audit_trail = [
        {
            "id": r[0],
            "event": r[1],
            "actor_id": r[2],
            "metadata": r[3],
            "created_at": r[4].isoformat() if r[4] else None,
            "hash": r[5],
            "prev_hash": r[6],
        }
        for r in audit_rows
    ]

    return (
        jsonify(
            {
                "case": case,
                "ai_result": ai_result,
                "compensation": compensation,
                "audit_trail": audit_trail,
            }
        ),
        200,
    )


@admin_bp.route("/admin/audit/verify-chain", methods=["GET"])
@require_admin()
def get_verify_chain():
    # Code review fix: mirror get_case_detail's guard for consistency -- an admin account in
    # the same "not yet provisioned" state shouldn't be able to use ANY admin route, even one
    # whose response carries no case/district data.
    if not g.district_id:
        return jsonify({"error": "no_district_assigned"}), 403

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    valid, broken_id = verify_chain(cur)
                    # Code review fix: this security-sensitive action was previously never
                    # audited -- no record of who ran an integrity check or when.
                    write_audit_log(
                        cur, None, "admin_verified_chain", g.admin_id,
                        {"ip_address": _client_ip(), "valid": valid, "broken_id": broken_id},
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("audit chain verification failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify({"valid": valid, "broken_id": broken_id}), 200
