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

District-scoping convention (Story 5.3 PO-Ratified Resolution 1): admin app_metadata.
district_id (moved from client-writable user_metadata 2026-08-11 -- see middleware/auth.py)
holds the REAL Sinhala district name (matching district_reference.json's
vocabulary from Story 5.2), not an arbitrary numeric code -- so g.district_id can be
compared directly against cases.district with no separate mapping table. A case with
district IS NULL (still most cases today -- district capture is optional and only two of
three intake channels support it) is excluded from every admin's view; there is no
inclusive fallback the way officer's ds_division_id/officer_id OR-condition works, because
admin has no equivalent "cases I personally touched" concept.
"""
import json
import math
import uuid
from datetime import date, timedelta

import psycopg2
from flask import Blueprint, Response, current_app, g, jsonify, request, stream_with_context

from app.api.v1.middleware.auth import require_admin
from app.domain.validation import MIN_REASON_LENGTH
from app.domain.workflow import workflow_stage
from app.infrastructure.audit import verify_chain, write_audit_log
from app.infrastructure.export.report import build_pdf, stream_csv
from app.infrastructure.ml.compensation import DISTRICT_REF_PATH
from app.infrastructure.notifications import notify_status_change_all
from app.infrastructure.push.push_service import notify_staff_push

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
        # Exclusive end-of-day upper bound, NOT `<= to_date`. `c.submitted_at` is TIMESTAMPTZ and
        # `to_date` is a bare `date`, which Postgres casts to midnight (00:00:00) -- so `<=` drops
        # every case submitted later on the end date itself. `?to=<today>` is the most common range
        # an admin selects, and it silently returned nothing from today.
        #
        # Story 7.1's code review fixed exactly this bug, but only inside get_analytics(), which
        # computes its own `to_date_exclusive` (see below). The shared builder never got the fix,
        # so list_cases AND /admin/export both still carried it -- the export being a research
        # data path, not just a UI one. Fixed here so every consumer of _build_conditions inherits
        # the correct boundary by construction.
        conditions.append("c.submitted_at < %s")
        params.append(to_date + timedelta(days=1))
    damage_type = args.get("type")
    if damage_type:
        conditions.append("c.damage_category = %s")
        params.append(damage_type)
    division = args.get("division")
    if division:
        conditions.append("c.ds_division_id = %s")
        params.append(division)
    # Workflow organisation (final governance workflow): the exact case a notification points at,
    # the responsible officer, and whether an officer has verified the case yet. Each keeps the
    # `c.<expr> = %s` shape documented above, so the list, the KPIs and the export stay aligned.
    reference = args.get("ref")
    if reference:
        conditions.append("c.canonical_id = %s")
        params.append(reference.strip().upper())
    officer = args.get("officer")
    if officer:
        conditions.append("COALESCE(c.assigned_officer_id, c.officer_id) = %s")
        params.append(officer)
    assessment = args.get("assessment")
    if assessment in ("assessed", "pending"):
        conditions.append(
            "(c.officer_assessed_at IS NOT NULL OR COALESCE(c.submitted_by_officer, FALSE)) = %s")
        params.append(assessment == "assessed")

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
                                   c.submitted_at, c.updated_at, il.confidence,
                                   c.submitted_by_officer, c.ds_division_id,
                                   COALESCE(c.assigned_officer_id, c.officer_id),
                                   c.officer_assessed_at, c.ds_final_amount
                              FROM cases c
                              LEFT JOIN LATERAL (
                                SELECT confidence FROM inference_log
                                 WHERE case_id = c.id
                                 -- `id DESC` is a required tiebreaker, not decoration: now() is
                                 -- transaction-stable, so an AI classification and the officer
                                 -- override that corrects it -- written in the SAME transaction --
                                 -- share a created_at, and "latest" is otherwise arbitrary. Story
                                 -- 7.2 added this to its own LATERAL for exactly this reason; the
                                 -- pre-existing queries never got it and could report a stale
                                 -- confidence/override flag. inference_log is append-only, so a
                                 -- higher id is always the later write.
                                 ORDER BY created_at DESC, id DESC
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
                    # (CRITICAL #5). Includes 'Payment Processed' as well as 'Approved' --
                    # code review fix: Story 5.5's mark_paid action moves a case out of
                    # 'Approved', and this KPI must not drop a case's approved amount from the
                    # "Total Approved" figure just because it was subsequently paid.
                    cur.execute(
                        "SELECT COALESCE(SUM(approved_amount), 0) FROM cases "
                        "WHERE district = %s AND status IN ('Approved', 'Payment Processed')",
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
            # WHO SAW THE DAMAGE. True only on the officer-assisted path (migration 007), where a
            # DWC officer was physically present, photographed the damage and reviewed the
            # classification. False means the citizen submitted from their own device and nobody
            # has verified that the damage is real, recent, theirs, or elephant-caused.
            #
            # submitted_via cannot answer this: migration 009 sets it to 'app' for BOTH paths.
            # Without this field the approver sees two identical rows and authorises the same
            # amount for both — see R-18.
            "submitted_by_officer": bool(r[7]),
            # Organisation by area and accountability: the DS division, the officer responsible
            # for the case, and how far it has travelled through the human checkpoints.
            "ds_division": r[8],
            "responsible_officer_id": r[9],
            "officer_assessed": bool(r[10]) or bool(r[7]),
            "ds_final_decided": r[11] is not None,
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
# volume is 1 row/case until Story 5.5's actions started writing more, but the query must not
# be unbounded regardless.
MAX_AUDIT_TRAIL_ROWS = 200


# Sentinel distinguishing "no compensation row exists" (a real, valid None) from "caller
# didn't supply one, go query it" -- see _load_case_detail's known_comp_row param.
_NOT_FETCHED = object()


def _load_case_detail(cur, offline_id, district, known_row=None, known_comp_row=_NOT_FETCHED):
    """Looks up a case by offline_id+district and returns (case_id, payload), where payload
    is the full {case, ai_result, compensation, audit_trail} shape -- or (None, None) if no
    matching row. Shared by get_case_detail (Story 5.4) and post_case_action (Story 5.5) so
    both return byte-identical response shapes without duplicating the SELECT/shaping logic
    (see Story 5.5 Dev Notes Sec Response Shape Reuse). Does NOT write any audit_log row
    itself -- callers decide what to audit and when (get_case_detail logs the view AFTER
    calling this, so its own view event doesn't appear in the trail it just rendered;
    post_case_action logs its action BEFORE calling this, so the action DOES appear in the
    returned trail).

    known_row/known_comp_row (code review fix): post_case_action already has the cases row
    (freshly re-derived after its own write) and, on the approve path, the compensation_
    estimates row, in hand by the time it calls this -- passing them here skips re-querying
    tables this same request already read a moment ago, instead of re-fetching by
    offline_id/district a second time."""
    if known_row is not None:
        row = known_row
    else:
        # No row found -> None, None whether the case doesn't exist or belongs to a different
        # district (CRITICAL #5 lineage) -- never distinguish, so a wrong-district admin can't
        # probe for another district's case IDs. No submitter_identity_hash (code review fix,
        # Story 5.4): unused by the frontend, not required by any AC, and an unnecessary
        # exposure surface for a value whose construction differs by intake channel (see
        # deferred-work.md).
        cur.execute(
            """SELECT canonical_id, offline_id, damage_category, status,
                      gps_lat, gps_lng, submitted_at, updated_at, submitted_via,
                      approved_amount, id, submitted_by_officer
                 FROM cases WHERE offline_id = %s AND district = %s""",
            (offline_id, district),
        )
        row = cur.fetchone()
        if row is None:
            return None, None

    case_id = row[10]

    # ai_result: latest inference_log row only (CRITICAL: one row carries both the original
    # prediction AND any override fields -- see inference.py -- never a join or a second row).
    cur.execute(
        """SELECT model_type, model_version, prediction, confidence,
                  was_overridden, override_reason, override_category,
                  input_features, created_at
             FROM inference_log WHERE case_id = %s
            -- `id DESC` tiebreaker -- see list_cases's LATERAL. Not named in the original
            -- deferred-work entry (which cited only list_cases and get_analytics) but carries
            -- the identical defect: this is the row an admin reads on the case-detail panel to
            -- decide an appeal, so showing the superseded prediction instead of the officer's
            -- override is the most consequential place for it to be wrong.
            ORDER BY created_at DESC, id DESC LIMIT 1""",
        (case_id,),
    )
    ai_row = cur.fetchone()

    # compensation: 0 or 1 row (UNIQUE case_id, migration 013).
    if known_comp_row is not _NOT_FETCHED:
        comp_row = known_comp_row
    else:
        cur.execute(
            """SELECT amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                      model_version, dataset_version, created_at
                 FROM compensation_estimates WHERE case_id = %s""",
            (case_id,),
        )
        comp_row = cur.fetchone()

    # `ORDER BY id DESC LIMIT %s` (newest N, in descending order), reversed to ascending in
    # Python below -- NOT `ASC LIMIT %s` (code review fix, Story 5.4: that kept the oldest N
    # forever once a case exceeds the cap, permanently hiding newer events).
    cur.execute(
        """SELECT id, event, actor_id, metadata, created_at, hash, prev_hash
             FROM audit_log WHERE case_id = %s
            ORDER BY id DESC LIMIT %s""",
        (case_id, MAX_AUDIT_TRAIL_ROWS),
    )
    audit_rows = list(reversed(cur.fetchall()))

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
        # See the list query's note: submitted_via is 'app' for both the citizen and the
        # officer-assisted path, so it cannot tell the approver whether anyone saw the damage.
        "submitted_by_officer": bool(row[11]),
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

    # Workflow checkpoints (migration 033). A separate, narrow read rather than more columns on the
    # SELECT above, whose positional shape the action path (and its test double) share.
    cur.execute(
        """SELECT district, ds_division_id, assigned_officer_id, officer_id,
                  officer_review_started_at, officer_assessed_at, officer_assessed_by,
                  ds_final_amount, ds_final_reason, ds_final_at
             FROM cases WHERE id = %s""",
        (case_id,),
    )
    wf = cur.fetchone() or (None,) * 10

    def _ts(value):
        return value.isoformat() if value else None

    workflow = {
        "stage": workflow_stage(case["status"], wf[4], wf[5], wf[9], case["submitted_by_officer"]),
        "district": wf[0],
        "ds_division": wf[1],
        "responsible_officer_id": wf[2] or wf[3],
        "officer_review_started_at": _ts(wf[4]),
        "officer_assessed_at": _ts(wf[5]),
        "officer_assessed_by": wf[6],
        "officer_assessed": wf[5] is not None or case["submitted_by_officer"],
        # The Divisional Secretariat's final human decision. The AI-assisted estimate above is
        # decision support only and is never the payable amount.
        "ds_final_amount": float(wf[7]) if wf[7] is not None else None,
        "ds_final_reason": wf[8],
        "ds_final_at": _ts(wf[9]),
    }
    if compensation is not None:
        compensation["is_final_decision"] = False

    return case_id, {
        "case": case,
        "ai_result": ai_result,
        "compensation": compensation,
        "audit_trail": audit_trail,
        "workflow": workflow,
    }


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
                    case_id, payload = _load_case_detail(cur, offline_id, district)
                    if case_id is None:
                        return jsonify({"error": "not_found"}), 404

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

    return jsonify(payload), 200


# Story 5.5: which current statuses each action is valid from, and (for every action except
# "approve", which also sets approved_amount + writes payment_authorizations) the status it
# moves the case to. Derived from FR-5.3 + FR-6.2's closed status-label enum + the UX
# mockup's button set -- escalate/request_info both resolve to "Under Review" (there is no
# "Escalated" status; see the story's CRITICAL #5) -- the signal lives in the audit event's
# metadata, not the status column, the same way inference_log.was_overridden carries meaning
# the status column doesn't.
VALID_ACTIONS = {"approve", "reject", "request_info", "escalate", "mark_paid"}

_ACTION_ALLOWED_FROM = {
    "approve": {"Submitted", "Under Review"},
    "reject": {"Submitted", "Under Review"},
    "request_info": {"Submitted", "Under Review"},
    "escalate": {"Submitted", "Under Review"},
    "mark_paid": {"Approved"},
}
# Target status + audit event name for the 4 actions that are a plain status transition.
# "approve" is deliberately not in these tables -- it also resolves an amount (from the body
# or the RF estimate) and writes payment_authorizations, a genuinely different shape, not just
# a different target status (code review fix: this pair used to be split across a module-level
# dict and a dict-literal rebuilt on every request -- hoisted the event names here too so
# both halves of a plain transition's config live in one place next to each other).
_ACTION_TARGET_STATUS = {
    "reject": "Rejected",
    "request_info": "Under Review",
    "escalate": "Under Review",
    "mark_paid": "Payment Processed",
}
_ACTION_EVENT = {
    "reject": "case_rejected",
    "request_info": "case_info_requested",
    "escalate": "case_escalated",
    "mark_paid": "case_paid",
}


@admin_bp.route("/admin/cases/<offline_id>/action", methods=["POST"])
@require_admin()
def post_case_action(offline_id):
    district = g.district_id
    if not district:
        return jsonify({"error": "no_district_assigned"}), 403

    try:
        uuid.UUID(offline_id)
    except ValueError:
        return jsonify({"error": "invalid_offline_id"}), 400

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    action = body.get("action")
    if action not in VALID_ACTIONS:
        return jsonify({"error": "invalid_action"}), 400

    reason = body.get("reason")
    if reason is not None and not isinstance(reason, str):
        return jsonify({"error": "invalid_reason"}), 400
    reason = reason.strip() if reason else None

    amount_lkr = body.get("amount_lkr")
    if amount_lkr is not None:
        if isinstance(amount_lkr, bool) or not isinstance(amount_lkr, (int, float)):
            return jsonify({"error": "invalid_amount"}), 400
        # >= 0, not > 0 (code review fix): a genuine RF estimate of exactly 0 LKR (no assessed
        # damage) is a real, tested value (see test_compensation.py) -- rejecting it here made
        # a legitimate zero-compensation case impossible to ever approve.
        if amount_lkr < 0:
            return jsonify({"error": "invalid_amount"}), 400

    # reject's reason is unconditionally required -- unlike approve's conditional requirement
    # (only when the amount differs from the RF estimate), checked further down once the
    # estimate is known.
    if action == "reject" and (not reason or len(reason) < MIN_REASON_LENGTH):
        return jsonify({"error": "reason_required"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # Same query shape as _load_case_detail's cases SELECT (deliberately, not
                    # a narrower id+status-only query) -- one query shape for the FakeCursor
                    # test double to match; id and status are always columns 10 and 3 of that
                    # row regardless. FOR UPDATE (code review fix): without a row lock here,
                    # two concurrent requests against the same case (a double-click, a retried
                    # request racing the original, two admin sessions) could both read the same
                    # pre-action status, both pass the transition check below, and both commit
                    # -- e.g. two payment_authorizations rows for one approval. This lock is
                    # held for the rest of the transaction (released at the `with conn:` commit
                    # below), so a second concurrent request blocks here until the first
                    # commits, then re-reads the now-updated status and correctly gets
                    # invalid_transition/case_closed instead of racing the write.
                    # citizen_mobile_plain (Story 5.6, 12th column): read once here alongside
                    # canonical_id (row[0]) so the notify_status_change() calls below never
                    # need a second query -- see Dev Notes Sec Design: Where Notifications Hook
                    # In. Not part of _load_case_detail's response shape (the frontend has no
                    # use for it).
                    cur.execute(
                        """SELECT canonical_id, offline_id, damage_category, status,
                                  gps_lat, gps_lng, submitted_at, updated_at, submitted_via,
                                  approved_amount, id, citizen_mobile_plain,
                                  submitted_by_officer, ds_division_id
                             FROM cases WHERE offline_id = %s AND district = %s
                             FOR UPDATE""",
                        (offline_id, district),
                    )
                    row = cur.fetchone()
                    if row is None:
                        return jsonify({"error": "not_found"}), 404
                    case_id, current_status = row[10], row[3]
                    citizen_mobile_plain = row[11]

                    if current_status not in _ACTION_ALLOWED_FROM[action]:
                        # Terminal states get their own error code (AC5) -- distinct from an
                        # action that's simply not valid from a non-terminal status (e.g.
                        # mark_paid on a still-Submitted case).
                        if current_status in ("Rejected", "Payment Processed"):
                            return jsonify({"error": "case_closed"}), 400
                        return jsonify({"error": "invalid_transition"}), 400

                    # known_comp_row (code review fix): populated on the approve path below so
                    # the post-write _load_case_detail call can reuse the compensation row
                    # already fetched here instead of re-querying it a second time.
                    known_comp_row = _NOT_FETCHED

                    if action == "approve" and not row[12]:
                        # Human verification before administrative approval. A citizen's own report
                        # has been seen by nobody from DWC until a field officer verifies it and
                        # records the on-device assessment (officer_cases.py). Approving it before
                        # that would forward an unverified claim to the Divisional Secretariat.
                        # Officer-assisted cases (row[12]) were verified at submission. Reject,
                        # request_info and escalate stay available at any point.
                        cur.execute("SELECT officer_assessed_at FROM cases WHERE id = %s",
                                    (case_id,))
                        assessed = cur.fetchone()
                        if not assessed or assessed[0] is None:
                            return jsonify({"error": "officer_assessment_required"}), 409

                    if action == "approve":
                        # Same query shape as _load_case_detail's compensation SELECT
                        # (deliberately, not just the single amount_lkr column) -- keeps this
                        # to one query shape for the FakeCursor test double to match, and
                        # amount_lkr is always column 0 of that row regardless.
                        cur.execute(
                            """SELECT amount_lkr, raw_estimate_lkr, capped, feature_values_json,
                                      model_version, dataset_version, created_at
                                 FROM compensation_estimates WHERE case_id = %s""",
                            (case_id,),
                        )
                        est_row = cur.fetchone()
                        estimate_amount = float(est_row[0]) if est_row is not None else None

                        resolved_amount = amount_lkr if amount_lkr is not None else estimate_amount
                        if resolved_amount is None:
                            return jsonify({"error": "amount_required"}), 400

                        amount_differs = estimate_amount is None or resolved_amount != estimate_amount
                        if amount_differs and (not reason or len(reason) < MIN_REASON_LENGTH):
                            return jsonify({"error": "reason_required"}), 400

                        # RETURNING updated_at (code review fix): captures the exact
                        # server-computed timestamp the write just produced, so the response
                        # payload below can be built from it directly instead of re-selecting
                        # the whole cases row a second time.
                        cur.execute(
                            """UPDATE cases SET status = 'Approved', approved_amount = %s,
                                                 updated_at = now() WHERE id = %s
                               RETURNING updated_at""",
                            (resolved_amount, case_id),
                        )
                        new_updated_at = cur.fetchone()[0]
                        # FR-5.6: payment authorization record, created on approval only. No
                        # citizen-identity column (see the story's CRITICAL #3) -- case_id ->
                        # canonical_id is the practical reference this schema can produce.
                        # FR-5.6 as amended by Story 8.6: the record now carries the household
                        # reference and the MASKED account tail, copied here so the authorisation
                        # is self-contained — a family that later changes its account must not
                        # retroactively rewrite what an existing authorisation says was paid.
                        # Never the full number: that stays encrypted on households and is read
                        # at exactly one call site (ds.py's payment authorisation).
                        cur.execute(
                            """INSERT INTO payment_authorizations
                                 (case_id, amount_lkr, authorized_by,
                                  household_id, bank_account_last4)
                               SELECT %s, %s, %s, c.household_id, h.bank_account_last4
                                 FROM cases c
                                 LEFT JOIN households h ON h.id = c.household_id
                                WHERE c.id = %s""",
                            (case_id, resolved_amount, g.admin_id, case_id),
                        )
                        write_audit_log(
                            cur, case_id, "case_approved", g.admin_id,
                            {"amount_lkr": resolved_amount, "reason": reason},
                        )
                        notify_status_change_all(
                            cur, case_id, row[0], citizen_mobile_plain, "Approved", g.admin_id,
                            amount_lkr=resolved_amount,
                        )
                        # FR-6.4: approval is the exact moment the Divisional Secretariat acquires
                        # work -- the DWC administrator approves, the DS office pays. Appended as
                        # the 14th column rather than inserted, so every positional index above
                        # (and the tests asserting on them) is unchanged.
                        notify_staff_push(
                            cur, case_id, "payment_pending", "ds_officer",
                            row[13], row[0], g.admin_id,
                        )
                        new_status = "Approved"
                        new_approved_amount = resolved_amount
                        known_comp_row = est_row
                    else:
                        target_status = _ACTION_TARGET_STATUS[action]
                        # Code review-lineage fix (Story 5.3/5.4 precedent): bump updated_at on
                        # every status-changing action -- the existing avg_processing_days KPI
                        # (list_cases) depends on it (CRITICAL #2).
                        cur.execute(
                            """UPDATE cases SET status = %s, updated_at = now() WHERE id = %s
                               RETURNING updated_at""",
                            (target_status, case_id),
                        )
                        new_updated_at = cur.fetchone()[0]
                        # Include any client-supplied reason regardless of action (code review
                        # fix): mark_paid previously force-dropped a supplied reason to {},
                        # silently discarding it with no error -- now it's recorded like every
                        # other action's optional reason.
                        metadata = {"reason": reason} if reason else {}
                        write_audit_log(cur, case_id, _ACTION_EVENT[action], g.admin_id, metadata)
                        notify_status_change_all(
                            cur, case_id, row[0], citizen_mobile_plain, target_status, g.admin_id,
                        )
                        new_status = target_status
                        new_approved_amount = row[9]

                    # Response built from the row already in hand + the values just written,
                    # not a second `cases` SELECT (code review fix: the original re-fetched the
                    # entire row a second time solely to hand it to _load_case_detail, even
                    # though every field other than status/approved_amount/updated_at is
                    # unchanged and those three are already known here).
                    updated_row = (
                        row[0], row[1], row[2], new_status,
                        row[4], row[5], row[6], new_updated_at,
                        row[8], new_approved_amount, row[10],
                        # Carried through rather than defaulted. _load_case_detail reads index 11
                        # as submitted_by_officer; omitting it would make every case look
                        # unverified the moment an action was taken on it — the response would
                        # contradict the list the admin was just looking at.
                        row[12],
                    )
                    # Same response shape as GET .../cases/<offline_id> (Dev Notes Sec Response
                    # Shape Reuse) -- includes the action just written, since this call happens
                    # after the write, unlike get_case_detail's own view-audit ordering.
                    _, payload = _load_case_detail(
                        cur, offline_id, district,
                        known_row=updated_row, known_comp_row=known_comp_row,
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("admin case action failed")
        return jsonify({"error": "server_error"}), 500

    return jsonify(payload), 200


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


# Story 5.6 (FR-4.4): compensation_caps.damage_type is effectively single-valued -- see
# infrastructure/ml/compensation.py's _DAMAGE_TYPE_MAP, which collapses crop/property/combined
# onto one "property" bucket the RF model ever reads. These routes only ever read/write
# damage_type='property'; it is never client-supplied, so a client can't write an inert row
# under a value nothing queries.
_CAP_DAMAGE_TYPE = "property"

_valid_districts = None


def _load_valid_districts():
    """Lazily loads + caches the real district vocabulary (mirrors
    infrastructure/ml/compensation.py::_load_lookup()'s own lazy-load-once pattern) so a
    PUT can be validated against real district names instead of accepting any string.

    A read failure is NOT cached (code review, Story 5.6): the original version stored `set()`
    into `_valid_districts` on error, which is indistinguishable from "loaded, genuinely empty"
    to the `is None` guard above -- one transient disk/deploy hiccup would have locked out every
    district as invalid_district for the life of the worker process."""
    global _valid_districts
    if _valid_districts is None:
        try:
            with open(DISTRICT_REF_PATH, encoding="utf-8") as f:
                _valid_districts = set(json.load(f).values())
        except (FileNotFoundError, OSError, ValueError):
            return set()
    return _valid_districts


@admin_bp.route("/admin/settings/compensation-caps", methods=["GET"])
@require_admin()
def get_compensation_caps():
    # Consistency guard (same precedent as get_verify_chain) -- not a data-leak fix, since caps
    # are cross-district policy data any admin may view/edit (CRITICAL #2: there is no separate
    # "System Admin" role in this codebase's as-built RBAC).
    if not g.district_id:
        return jsonify({"error": "no_district_assigned"}), 403

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT district, damage_type, cap_amount_lkr, updated_by, updated_at
                             FROM compensation_caps WHERE damage_type = %s
                             ORDER BY district""",
                        (_CAP_DAMAGE_TYPE,),
                    )
                    rows = cur.fetchall()
                    # Audit-on-view (code review, Story 5.6): every other admin read endpoint in
                    # this file (list_cases/admin_viewed_cases, get_case_detail, get_verify_chain)
                    # logs its own view event -- case_id NULL, same admin_viewed_cases precedent.
                    write_audit_log(
                        cur, None, "admin_viewed_compensation_caps", g.admin_id,
                        {"result_count": len(rows)},
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("compensation caps list failed")
        return jsonify({"error": "server_error"}), 500

    caps = [
        {
            "district": r[0],
            "damage_type": r[1],
            "cap_amount_lkr": float(r[2]),
            "updated_by": r[3],
            "updated_at": r[4].isoformat() if r[4] else None,
        }
        for r in rows
    ]
    return jsonify({"caps": caps}), 200


@admin_bp.route("/admin/settings/compensation-caps", methods=["PUT"])
@require_admin()
def put_compensation_caps():
    if not g.district_id:
        return jsonify({"error": "no_district_assigned"}), 403

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_body"}), 400

    district = body.get("district")
    if not isinstance(district, str) or district not in _load_valid_districts():
        return jsonify({"error": "invalid_district"}), 400

    cap_amount_lkr = body.get("cap_amount_lkr")
    if isinstance(cap_amount_lkr, bool) or not isinstance(cap_amount_lkr, (int, float)):
        return jsonify({"error": "invalid_amount"}), 400
    # math.isfinite rejects NaN/Infinity (code review, Story 5.6): Python's json module accepts
    # those non-standard tokens as valid floats by default, and both would otherwise pass the
    # `< 0` check below (NaN is never < 0; Infinity is never < 0) and get stored as a cap that
    # silently never triggers (every comparison against NaN/Infinity in compensation.py is False).
    if not math.isfinite(cap_amount_lkr):
        return jsonify({"error": "invalid_amount"}), 400
    # >= 0, not > 0 (same reasoning as Story 5.5's approve-amount fix): a cap of exactly 0 is a
    # legitimate "no compensation for this district" policy, only negative is nonsensical.
    if cap_amount_lkr < 0:
        return jsonify({"error": "invalid_amount"}), 400

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO compensation_caps (district, damage_type, cap_amount_lkr, updated_by)
                           VALUES (%s, %s, %s, %s)
                           ON CONFLICT (district, damage_type)
                           DO UPDATE SET cap_amount_lkr = EXCLUDED.cap_amount_lkr,
                                         updated_by = EXCLUDED.updated_by, updated_at = now()
                           RETURNING district, damage_type, cap_amount_lkr, updated_by, updated_at""",
                        (district, _CAP_DAMAGE_TYPE, cap_amount_lkr, g.admin_id),
                    )
                    row = cur.fetchone()
                    # case_id NULL -- mirrors admin_viewed_cases's existing precedent for a
                    # district/system-level, not per-case, event.
                    write_audit_log(
                        cur, None, "compensation_cap_updated", g.admin_id,
                        {"district": district, "cap_amount_lkr": cap_amount_lkr},
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("compensation cap update failed")
        return jsonify({"error": "server_error"}), 500

    return (
        jsonify(
            {
                "district": row[0],
                "damage_type": row[1],
                "cap_amount_lkr": float(row[2]),
                "updated_by": row[3],
                "updated_at": row[4].isoformat() if row[4] else None,
            }
        ),
        200,
    )


# --- Story 7.1: Admin Analytics Dashboard (FR-7.1) ---------------------------------------
#
# GET /api/v1/admin/analytics -- district-scoped like every other route in this file
# (g.district_id, never a request param). Four independently-queried sections, matching
# list_cases's separate-KPI-queries discipline (no single mega-join across cases/
# inference_log/compensation_estimates):
#
#   1. volume_trend        -- FIXED trailing 12 calendar months, independent of the from/to
#                              filter below (a rolling annual view, same "fixed calendar
#                              window" class as list_cases's this_month KPI).
#   2. status_distribution -- within the from/to filter (defaults to the last 30 days).
#   3. compensation_by_month -- within the from/to filter. Uses c.updated_at as an
#                              approval-month proxy: cases has no dedicated approval
#                              timestamp column (only approved_amount itself, migration 004).
#   4. ai_metrics           -- confidence histogram + avg AI processing time from the
#                              LATEST inference_log row per case within the from/to filter
#                              (append-only table -- an override is a second inserted row,
#                              not an update, so a plain join would double-count a
#                              re-classified case). The override-RATE TREND (this month vs
#                              last) is, like volume_trend, a fixed calendar comparison
#                              independent of the from/to filter.
#
# "This month" / "last month" / "trailing 12 months" are all anchored to the resolved
# `to_date` (defaults to today, but can be set explicitly via `?to=`), NOT to SQL `now()` or
# Python `date.today()` inside the query logic -- keeps the whole endpoint a pure function of
# its inputs (deterministic for tests) and gives a coherent reading when an admin filters to
# a past period: "this/last month" then means relative to the end of that period, not to the
# literal moment the request happens to run.
#
# "Average processing time" is implemented as AI inference latency (input_features->>
# 'ai_processing_time_ms'), not submission-to-human-decision elapsed time -- the latter has
# no clean backing timestamp in this schema (see story Dev Notes CRITICAL #6/OQ-A).

CONFIDENCE_BUCKETS = 10  # 10%-wide buckets: [0,10), [10,20), ..., [90,100]


def _month_start(d):
    return date(d.year, d.month, 1)


def _next_month_start(d):
    return date(d.year + 1, 1, 1) if d.month == 12 else date(d.year, d.month + 1, 1)


def _prev_month_start(month_start):
    return date(month_start.year - 1, 12, 1) if month_start.month == 1 else date(
        month_start.year, month_start.month - 1, 1
    )


def _trailing_12_months_start(end_date):
    """First day of the month 11 months before end_date's month (so the window spans
    exactly 12 calendar months ending with end_date's month) -- month arithmetic, not a
    fixed 365-day subtraction, since months don't all have the same length."""
    year, month = end_date.year, end_date.month - 11
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


def _confidence_histogram(confidences):
    """confidences: iterable of float, expected in [0, 1]. Returns a 10-element list of
    counts, index i covering [i*10, (i+1)*10)%, with a confidence of exactly 1.0 (100%)
    folded into the last bucket rather than overflowing a would-be 11th bucket.

    Code review fix: a value outside [0, 1] is now DISCARDED, not clamped/wrapped -- a
    negative confidence previously produced a negative Python list index, which silently
    corrupts bucket 9 via negative-index wraparound instead of erroring or being dropped.
    `0.0 <= c <= 1.0` is also False for a NaN confidence (every comparison with NaN is
    False), so NaN is discarded here too instead of reaching `int(nan * 10)`, which raises
    ValueError uncaught by this endpoint's `except psycopg2.Error` block."""
    buckets = [0] * CONFIDENCE_BUCKETS
    for c in confidences:
        if not (0.0 <= c <= 1.0):
            continue
        idx = min(CONFIDENCE_BUCKETS - 1, int(c * CONFIDENCE_BUCKETS))
        buckets[idx] += 1
    return buckets


def _override_rate_pct(overridden_flags):
    """None (not 0) when there is no data to compute a rate from -- distinguishes "0% of a
    real sample overrode" from "no cases classified yet", the same None-for-no-data
    convention list_cases's avg_processing_days already follows."""
    flags = list(overridden_flags)
    if not flags:
        return None
    return round(100.0 * sum(1 for f in flags if f) / len(flags), 1)


def _override_trend(this_month_flags, last_month_flags):
    this_pct = _override_rate_pct(this_month_flags)
    last_pct = _override_rate_pct(last_month_flags)
    if this_pct is None or last_pct is None:
        direction = "no_data"
    elif this_pct - last_pct > 0.05:
        direction = "up"
    elif last_pct - this_pct > 0.05:
        direction = "down"
    else:
        direction = "flat"
    return {"this_month_pct": this_pct, "last_month_pct": last_pct, "direction": direction}


@admin_bp.route("/admin/analytics", methods=["GET"])
@require_admin()
def get_analytics():
    district = g.district_id  # verified JWT claim -- never from the request
    if not district:
        return jsonify({"error": "no_district_assigned"}), 403

    args = request.args
    from_date = _parse_date(args.get("from"))
    if from_date is _INVALID:
        return jsonify({"error": "invalid_date"}), 400
    to_date = _parse_date(args.get("to"))
    if to_date is _INVALID:
        return jsonify({"error": "invalid_date"}), 400
    # Default range: last 30 days (AC3), applied server-side so an admin's very first load
    # (no query params yet) is already scoped, not an unfiltered all-time query.
    if to_date is None:
        to_date = date.today()
    if from_date is None:
        from_date = to_date - timedelta(days=30)
    # Code review fix: an inverted range (from > to) previously fell through to a query that
    # always returns zero rows -- silently indistinguishable from "no data in a valid range."
    if from_date > to_date:
        return jsonify({"error": "invalid_date"}), 400

    this_month_start = _month_start(to_date)
    next_month_start = _next_month_start(this_month_start)
    last_month_start = _prev_month_start(this_month_start)
    # Code review fix: a `timestamp <= %s` comparison against a bare `date` casts the date to
    # midnight (00:00:00) in Postgres, silently excluding every case timestamped later that
    # same day -- the most common query an admin will run (today is almost always inside the
    # default/selected range). Every date-range upper bound below uses this exclusive
    # end-of-day boundary instead of a plain `<= to_date`.
    to_date_exclusive = to_date + timedelta(days=1)

    try:
        conn = _get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    # 1. Volume trend -- fixed trailing 12 months, anchored to to_date. Upper
                    # bound added (code review fix): without it, cases submitted after
                    # to_date (up to the real present) leaked into a trend that's supposed to
                    # be anchored to to_date, not open-ended.
                    cur.execute(
                        """SELECT date_trunc('month', submitted_at) AS month, COUNT(*)
                             FROM cases
                            WHERE district = %s AND submitted_at >= %s AND submitted_at < %s
                            GROUP BY month
                            ORDER BY month""",
                        [district, _trailing_12_months_start(to_date), to_date_exclusive],
                    )
                    volume_rows = cur.fetchall()

                    # 2. Status distribution -- within the from/to filter.
                    cur.execute(
                        """SELECT status, COUNT(*) FROM cases
                            WHERE district = %s AND submitted_at >= %s AND submitted_at < %s
                            GROUP BY status""",
                        [district, from_date, to_date_exclusive],
                    )
                    status_rows = cur.fetchall()

                    # 3. Compensation total by month -- within the from/to filter.
                    # CRITICAL: approved_amount only (never compensation_estimates.amount_lkr,
                    # the AI's unapproved recommendation -- same rule as list_cases's KPI).
                    cur.execute(
                        """SELECT date_trunc('month', updated_at) AS month,
                                  COALESCE(SUM(approved_amount), 0)
                             FROM cases
                            WHERE district = %s AND status IN ('Approved', 'Payment Processed')
                              AND updated_at >= %s AND updated_at < %s
                            GROUP BY month
                            ORDER BY month""",
                        [district, from_date, to_date_exclusive],
                    )
                    compensation_rows = cur.fetchall()

                    # 4a. AI confidence + processing time -- latest inference_log row per
                    # case, within the from/to filter (LATERAL, mirrors list_cases's
                    # confidence subquery -- CRITICAL #5 in the story: append-only table).
                    cur.execute(
                        """SELECT il.confidence, il.input_features
                             FROM cases c
                             JOIN LATERAL (
                               SELECT confidence, input_features FROM inference_log
                                WHERE case_id = c.id
                                -- `id DESC` tiebreaker -- see list_cases's LATERAL above. This
                                -- one feeds the AI-confidence and override-rate figures, so a
                                -- nondeterministic "latest" here moves a number the dissertation
                                -- reports (NFR-6.3), not just a cell in the UI.
                                ORDER BY created_at DESC, id DESC LIMIT 1
                             ) il ON true
                            WHERE c.district = %s
                              AND c.submitted_at >= %s AND c.submitted_at < %s""",
                        [district, from_date, to_date_exclusive],
                    )
                    ai_rows = cur.fetchall()

                    # 4b. Override-rate trend -- calendar this-month-vs-last-month, both
                    # anchored to to_date (not real wall-clock now()) and independent of the
                    # from/to filter's own (possibly narrower) range.
                    cur.execute(
                        """SELECT il.was_overridden
                             FROM cases c
                             JOIN LATERAL (
                               SELECT was_overridden FROM inference_log
                                -- `id DESC` tiebreaker -- see list_cases's LATERAL above.
                                WHERE case_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
                             ) il ON true
                            WHERE c.district = %s
                              AND c.submitted_at >= %s AND c.submitted_at < %s""",
                        [district, this_month_start, next_month_start],
                    )
                    this_month_rows = cur.fetchall()

                    cur.execute(
                        """SELECT il.was_overridden
                             FROM cases c
                             JOIN LATERAL (
                               SELECT was_overridden FROM inference_log
                                -- `id DESC` tiebreaker -- see list_cases's LATERAL above.
                                WHERE case_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
                             ) il ON true
                            WHERE c.district = %s
                              AND c.submitted_at >= %s AND c.submitted_at < %s""",
                        [district, last_month_start, this_month_start],
                    )
                    last_month_rows = cur.fetchall()

                    write_audit_log(
                        cur, None, "admin_viewed_analytics", g.admin_id,
                        # Code review fix: record the range actually viewed, matching the
                        # detail level list_cases's own audit write already includes
                        # (result_count) -- "someone looked at analytics" alone is a weaker
                        # forensic record than "someone looked at analytics for 2026-06-01..
                        # 2026-07-15."
                        {
                            "ip_address": _client_ip(),
                            "from": from_date.isoformat(),
                            "to": to_date.isoformat(),
                        },
                    )
        finally:
            conn.close()
    except psycopg2.Error:
        current_app.logger.exception("admin analytics failed")
        return jsonify({"error": "server_error"}), 500

    volume_trend = [
        {"month": month.isoformat(), "count": count} for month, count in volume_rows
    ]
    status_distribution = dict(status_rows)
    compensation_by_month = [
        {"month": month.isoformat(), "total_lkr": float(total)}
        for month, total in compensation_rows
    ]

    confidences = [float(c) for c, _features in ai_rows if c is not None]
    latencies_ms = []
    for _confidence, features in ai_rows:
        # Code review fix: `features or {}` kept a non-dict truthy JSONB value (e.g. a
        # legacy row storing a list or string) as-is, and `.get(...)` on it raises
        # AttributeError -- uncaught here, a 500 with a raw stack trace instead of this
        # endpoint's own {"error": "server_error"} convention.
        features = features if isinstance(features, dict) else {}
        raw = features.get("ai_processing_time_ms")
        if raw is not None:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            # Code review fix: Python's float() happily parses "NaN"/"Infinity"/"-Infinity"
            # strings into a non-finite float. A non-finite value surviving into the average
            # below would serialize as an invalid JSON token (jsonify/json.dumps emit the
            # literal NaN/Infinity, which isn't valid JSON and breaks strict JSON.parse
            # clients) -- discard it here instead, the same way a malformed row is discarded.
            if math.isfinite(value):
                latencies_ms.append(value)

    ai_metrics = {
        "confidence_histogram": _confidence_histogram(confidences),
        "sample_count": len(ai_rows),
        # AC2 asks for the override rate "with a trend (this month vs last month)" -- that
        # trend already carries both months' rates (override_rate_trend below); there is no
        # separate filter-range-scoped rate required by the AC, so none is computed here.
        "override_rate_trend": _override_trend(
            (r[0] for r in this_month_rows), (r[0] for r in last_month_rows)
        ),
        "avg_processing_time_ms": (
            round(sum(latencies_ms) / len(latencies_ms), 1) if latencies_ms else None
        ),
    }

    return (
        jsonify(
            {
                "range": {"from": from_date.isoformat(), "to": to_date.isoformat()},
                "volume_trend": volume_trend,
                "status_distribution": status_distribution,
                "compensation_by_month": compensation_by_month,
                "ai_metrics": ai_metrics,
            }
        ),
        200,
    )


# ---------------------------------------------------------------------------------------
# Story 7.2 -- CSV/PDF case export (FR-7.2)
# ---------------------------------------------------------------------------------------

# Bounds the work a single export can cause (AC3). The CSV path streams and would survive a
# larger set, but the PDF path must buffer (a PDF's xref table can only be written once the
# document is complete), and Render's free plan is a 512 MB box -- one cap for both keeps the
# two formats returning the same rows rather than silently diverging at some threshold.
EXPORT_MAX_ROWS = 10000

# The PDF path gets its own, much lower cap. Measured on this repo's venv, build_pdf grows
# superlinearly -- 100 rows 0.1s, 1,000 rows 0.5s, 10,000 rows 13.1s -- and that excludes
# fetchall(). render.yaml runs `gunicorn wsgi:app` with the default 30s worker timeout on
# Render's *free* (shared, slower) CPU, so a full-district PDF would have the arbiter SIGKILL
# the worker and hand the admin a 502 -- while the audit row, committed earlier in its own
# transaction, permanently recorded a successful 10,000-row export that never reached anyone.
# The CSV path is the complete-data channel; the PDF is the human-readable summary, and it now
# says on its face when it is showing a subset.
PDF_MAX_ROWS = 2000

EXPORT_FORMATS = ("csv", "pdf")


def _close_quietly(closeable):
    """Closes a cursor/connection, tolerating double-close and already-dead handles.

    Idempotent by design: both the stream generator's `finally` and the response's
    call_on_close hook invoke this, and exactly one of them runs first depending on whether
    the generator was ever advanced.
    """
    try:
        closeable.close()
    except Exception:  # pragma: no cover - defensive
        pass

# Same shape as list_cases's SELECT (explicit column list, never SELECT *), minus pagination
# and plus the three columns the export adds. Order MUST match report.CSV_COLUMNS -- format_row()
# unpacks positionally.
#
# CRITICAL: confidence and was_overridden come from a LEFT JOIN LATERAL, not a plain join.
# inference_log is append-only (migration 006) -- an officer override inserts a SECOND row for
# the same case -- so a plain join duplicates that case in the export. Same fan-out rule already
# enforced in list_cases and get_analytics.
#
# CRITICAL: the money column is cases.approved_amount, NOT compensation_estimates.amount_lkr.
# The latter is the AI's UNAPPROVED recommendation; exporting it as an approval would misstate
# the district's financial position. Same rule as list_cases's KPI and get_analytics.
#
# NO PII (AC4/NFR-3.3): no submitter_identity_hash, no citizen_nic_plain, no
# citizen_mobile_plain, no gps_lat/gps_lng.
_EXPORT_SELECT = """SELECT c.canonical_id, c.submitted_at, c.damage_category,
                           il.confidence, il.was_overridden, c.status,
                           c.approved_amount, c.district, c.ds_division_id
                      FROM cases c
                      LEFT JOIN LATERAL (
                        SELECT confidence, was_overridden FROM inference_log
                         WHERE case_id = c.id
                         ORDER BY created_at DESC, id DESC
                         LIMIT 1
                      ) il ON true
                     WHERE {where}
                     ORDER BY c.submitted_at DESC, c.id DESC
                     LIMIT %s"""

# `, id DESC` is a required tiebreaker, not decoration (review finding): now() is
# transaction-stable in Postgres, so two inference_log rows written in the same transaction
# (an AI classification and its officer override) share an identical created_at. Ordering on
# created_at alone would then pick between them nondeterministically -- the export could report
# was_overridden as false for a case that WAS overridden, and flip between runs. The same
# tiebreaker is missing from list_cases and get_analytics; logged as deferred (pre-existing).


@admin_bp.route("/admin/export", methods=["GET"])
@require_admin()
def export_cases():
    """GET /api/v1/admin/export?format=csv|pdf&<same filters as /admin/cases>

    Exports the CURRENT filter selection in full -- no pagination (AC1). The filter clause comes
    from _build_conditions(), the very same builder list_cases uses, so "the export contains
    exactly what the case list shows across all its pages" is true by construction rather than
    by two hand-kept-in-sync query strings.
    """
    district = g.district_id  # verified JWT claim -- never from the request (AC4)
    if not district:
        return jsonify({"error": "no_district_assigned"}), 403

    args = request.args

    fmt = (args.get("format") or "csv").lower()
    if fmt not in EXPORT_FORMATS:
        # Rejected before any DB work, matching this module's reject-bad-input-early convention.
        return jsonify({"error": "invalid_format"}), 400

    conditions, params = _build_conditions(district, args)
    if conditions is None:
        return jsonify({"error": "invalid_date"}), 400

    date_str = date.today().isoformat()
    from_date = _parse_date(args.get("from"))
    to_date = _parse_date(args.get("to"))
    # Inverted range rejected explicitly (review finding), matching get_analytics' own
    # code-review fix: `from` after `to` otherwise returns a valid, empty export plus a
    # committed audit row claiming a successful export -- indistinguishable from "this
    # district genuinely has no cases", the exact ambiguity no_district_assigned exists
    # to prevent.
    if from_date and to_date and from_date > to_date:
        return jsonify({"error": "invalid_date"}), 400

    row_limit = PDF_MAX_ROWS if fmt == "pdf" else EXPORT_MAX_ROWS
    where = " AND ".join(conditions)
    query = _EXPORT_SELECT.format(where=where)
    query_params = params + [row_limit]

    try:
        conn = _get_connection()
    except psycopg2.Error:
        current_app.logger.exception("admin export failed to connect")
        return jsonify({"error": "server_error"}), 500

    # Count + audit first, in their own committed transaction, BEFORE any streaming starts.
    #
    # CRITICAL: the audit write must NOT live inside the stream generator. A stream_with_context
    # generator body runs after the view function returns; if the client disconnects mid-download
    # the generator can be closed early, so an audit write placed there might never commit --
    # leaving a bulk data egress with no record at all. Counting up front costs one extra query
    # and makes the audit row honest about how many rows were authorised for export.
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM cases c WHERE {where}", params)
                matched = cur.fetchone()[0]
                row_count = min(matched, row_limit)

                write_audit_log(
                    cur,
                    None,
                    "admin_exported_cases",
                    g.admin_id,
                    {
                        "ip_address": _client_ip(),
                        "format": fmt,
                        # Named to be honest about what this number is (review finding): the
                        # COUNT commits in this transaction and the export SELECT opens a new
                        # one, so under READ COMMITTED a concurrent insert between them means
                        # the delivered row count can exceed this. It is the count authorised
                        # at audit time, not a guarantee of what was streamed. The ordering is
                        # mandated by CRITICAL #6 and is not negotiable, so the fix is accurate
                        # naming rather than a false guarantee.
                        "row_count_at_audit": row_count,
                        "matched_count": matched,
                        "truncated": matched > row_limit,
                        "row_limit": row_limit,
                        "from": from_date.isoformat() if from_date else None,
                        "to": to_date.isoformat() if to_date else None,
                        # The non-range filters are recorded too (review finding): without
                        # them an export narrowed to ?status=Approved&division=X audited
                        # identically to an unfiltered one of the same size, which is weak
                        # forensics for a bulk data egress.
                        "filters": {
                            key: args.get(key)
                            for key in ("status", "type", "division")
                            if args.get(key)
                        },
                    },
                )
    except Exception:
        # Broadened from psycopg2.Error (review finding): a TypeError/AttributeError raised
        # inside this block (e.g. from write_audit_log's json.dumps) previously propagated
        # with the connection never closed. With no pool and a single sync worker, leaked
        # connections accumulate against the Postgres connection cap. list_cases uses the
        # try/finally shape for exactly this reason.
        conn.close()
        current_app.logger.exception("admin export audit/count failed")
        return jsonify({"error": "server_error"}), 500

    if fmt == "pdf":
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(query, query_params)
                    rows = cur.fetchall()
        except psycopg2.Error:
            current_app.logger.exception("admin export pdf query failed")
            return jsonify({"error": "server_error"}), 500
        finally:
            conn.close()

        try:
            pdf_bytes = build_pdf(
                rows,
                district,
                from_date,
                to_date,
                truncated_from=matched if matched > row_limit else None,
            )
        except Exception:
            # Rendering is the one step in this route that could previously escape as an
            # unhandled traceback rather than this module's JSON 500 convention.
            current_app.logger.exception("admin export pdf render failed")
            return jsonify({"error": "server_error"}), 500

        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=hec-cases-{date_str}.pdf",
                "X-HEC-Row-Count": str(len(rows)),
                "X-HEC-Truncated": "true" if matched > row_limit else "false",
            },
        )

    # CSV: server-side (named) cursor + fetchmany so the result set is never fully resident
    # (AC3). The connection stays open for the generator's lifetime and is closed in its
    # finally -- which Werkzeug runs even when the client disconnects mid-download.
    #
    # The connection comes from _get_connection() rather than a fresh psycopg2.connect() so
    # this route remains reachable by the suite's standard monkeypatch seam.
    # The query is executed HERE, before the Response is constructed (review finding), not
    # inside the generator. A generator body runs after the view returns, i.e. after 200 and
    # the headers are already committed -- so a failing cur.execute() used to surface as a
    # silently truncated (often empty) file that the browser saved as a successful download,
    # while the audit row asserted a full export. The expensive part is fetchmany, not execute,
    # so nothing is buffered by moving this up; only the knowable failure becomes a clean 500.
    try:
        cur = conn.cursor(name="hec_export_cursor")
        cur.itersize = 500
        cur.execute(query, query_params)
    except Exception:
        conn.close()
        current_app.logger.exception("admin export csv query failed")
        return jsonify({"error": "server_error"}), 500

    def generate():
        try:
            yield from stream_csv(cur)
            conn.commit()
        except Exception:
            # Nothing can be signalled in-band at this point (status and headers are long
            # gone), but this must not vanish silently -- it is the one failure mode that
            # produces a short file the admin cannot distinguish from a complete one.
            current_app.logger.exception("admin export stream failed mid-download")
            raise
        finally:
            _close_quietly(cur)
            _close_quietly(conn)

    response = Response(
        stream_with_context(generate()),
        # The payload carries Sinhala district names; Werkzeug appends charset=utf-8 for
        # text/* mimetypes. (The previously hand-set Content-Type header here was inert --
        # Werkzeug resolves `mimetype` last and overwrites it -- so it has been removed
        # rather than left as a comment that describes something not happening.)
        mimetype="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=hec-cases-{date_str}.csv",
            # No Content-Length -- unknowable for a streamed body by construction.
            "X-HEC-Row-Count": str(row_count),
            "X-HEC-Truncated": "true" if matched > row_limit else "false",
        },
    )
    # Safety net for the case the generator NEVER starts (review finding, verified): Python
    # does not run a generator's finally when it is closed before being advanced, and Werkzeug
    # does exactly that for a HEAD request -- Flask auto-registers HEAD for a GET route -- and
    # on an immediate client disconnect. The connection was therefore leaked outright, one per
    # request, until the Postgres connection cap was reached. call_on_close fires whether or
    # not the iterable was ever consumed; _close_quietly is idempotent so the generator's own
    # finally remains correct for the normal path.
    response.call_on_close(lambda: _close_quietly(cur))
    response.call_on_close(lambda: _close_quietly(conn))
    return response
