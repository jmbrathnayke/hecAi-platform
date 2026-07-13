"""Admin case-list API (Story 5.3, FR-5.1/FR-7.1).

GET /api/v1/admin/cases -- admin-authenticated (Supabase JWT via require_admin()).
District-scoped: WHERE district = g.district_id, from the verified JWT only, never a
request param. Mirrors officer.py's list_cases() shape at district instead of
officer/division scope. Payload never includes NIC in any form (no submitter_identity_hash,
no citizen_nic_plain) -- case detail (Story 5.4) is a separate, more privileged view.

District-scoping convention (Story 5.3 PO-Ratified Resolution 1): admin user_metadata.
district_id holds the REAL Sinhala district name (matching district_reference.json's
vocabulary from Story 5.2), not an arbitrary numeric code -- so g.district_id can be
compared directly against cases.district with no separate mapping table. A case with
district IS NULL (still most cases today -- district capture is optional and only two of
three intake channels support it) is excluded from every admin's view; there is no
inclusive fallback the way officer's ds_division_id/officer_id OR-condition works, because
admin has no equivalent "cases I personally touched" concept.
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_admin
from app.infrastructure.audit import write_audit_log

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
    from_date = args.get("from")
    if from_date:
        conditions.append("c.submitted_at >= %s")
        params.append(from_date)
    to_date = args.get("to")
    if to_date:
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
    args = request.args

    page = max(1, _int_param(args, "page", 1))
    limit = min(MAX_LIMIT, max(1, _int_param(args, "limit", 20)))
    offset = (page - 1) * limit

    sort_col = args.get("sort", "submitted_at")
    if sort_col not in ALLOWED_SORT:
        sort_col = "submitted_at"
    sort_dir = "ASC" if args.get("dir", "desc").lower() == "asc" else "DESC"

    conditions, params = _build_conditions(district, args)
    where = " AND ".join(conditions)

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT COUNT(*) FROM cases c WHERE {where}", params)
                    total = cur.fetchone()[0]

                    # Explicit column list (never SELECT *) -- no submitter_identity_hash,
                    # no citizen_nic_plain, ever (CRITICAL #3).
                    cur.execute(
                        f"""SELECT c.canonical_id, c.offline_id, c.damage_category, c.status,
                                   c.submitted_at, c.updated_at, il.confidence
                              FROM cases c
                              LEFT JOIN inference_log il ON il.case_id = c.id
                             WHERE {where}
                             ORDER BY c.{sort_col} {sort_dir}
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

                    cur.execute(
                        "SELECT AVG(EXTRACT(EPOCH FROM (updated_at - submitted_at)) / 86400) "
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
