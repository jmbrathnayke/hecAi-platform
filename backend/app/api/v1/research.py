"""Researcher-scoped, PII-stripped data export (Story 7.3, FR-7.3, NFR-3.3, RER-2/3/6).

`GET /api/v1/research/export` returns one JSON object per `inference_log` row — the raw material
for the dissertation's confusion matrix (RER-2), compensation MAE per period (FR-7.3), and
override rate (NFR-6.3).

THREE DELIBERATE INVERSIONS OF STORY 7.2's /admin/export — none of them accidental:

1. NO LATERAL. admin.py collapses inference_log's append-only fan-out to the single latest row
   per case, because an admin report must show one line per case. Research wants the fan-out:
   an AI prediction and the officer override that corrected it are two distinct research
   records. Consequence, documented for consumers: the case-level columns
   (`compensation_estimate_lkr`, `approved_amount`, `district`, …) REPEAT across a case's rows.
   Deduplicate on `case_canonical_id` before computing any money aggregate.

2. BOTH money columns. admin.py exports only `cases.approved_amount` (the human-approved figure)
   and deliberately never `compensation_estimates.amount_lkr` (the AI's unapproved
   recommendation), because showing the latter as an approval would misstate the district's
   financial position. Research needs exactly the opposite: the model's output is the thing
   being measured. So both ship — `compensation_estimate_lkr` (model) and `approved_amount`
   (human ground truth) — and MAE is the difference between them.

3. NO DISTRICT SCOPE. admin.py gates hard on g.district_id. A researcher needs every district,
   which is precisely why require_research() rejects the `admin` role rather than reusing it.

PII (AC2/NFR-3.3): the SELECT is an explicit column list, never SELECT *. Beyond the obvious
exclusions (submitter_identity_hash, gps_lat/lng,
officer_id, citizen_id) two columns on inference_log itself are excluded for reasons a
column-name review would miss:
  - `input_features` is JSONB literally containing officer_id (see inference.py's write path).
  - `override_reason` is officer-typed free text and can contain anything, including a citizen's
    name.
`canonical_id` IS included: it is the designated cross-reference key, the same PO-ratified
position Story 7.2 reached for its own export (OQ-A, 2026-08-06).
"""
import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import require_research
from app.infrastructure.audit import write_audit_log
# Private-name import across modules, deliberately: _fmt_datetime encodes a non-obvious
# behavioural fix (Story 7.2's live run found isoformat()'s "+00:00" breaks downstream
# spreadsheet/pandas parsing). Re-deriving it here would mean two copies that can drift on the
# one detail that already bit us once.
from app.infrastructure.export.report import _fmt_datetime

research_bp = Blueprint("research", __name__)

# Generous but finite (OQ-D). FR-7.3 wants a complete research dataset, but Story 7.2 measured a
# gunicorn 30s-timeout 502 on an uncapped export while its audit row still claimed success. A
# loudly truncated dataset (headers + audit metadata) beats a silently truncated one.
RESEARCH_MAX_ROWS = 50_000

# Column order MUST match _row_to_dict()'s unpacking.
_RESEARCH_SELECT = """SELECT il.id, c.canonical_id, il.model_type, il.model_version,
                             il.prediction, il.confidence, il.was_overridden,
                             il.override_category, il.ground_truth, c.damage_category,
                             c.district, c.ds_division_id, ce.amount_lkr, c.approved_amount,
                             il.created_at
                        FROM inference_log il
                        JOIN cases c ON c.id = il.case_id
                        LEFT JOIN compensation_estimates ce ON ce.case_id = c.id
                       ORDER BY il.id
                       LIMIT %s"""

# inference_log.case_id is BIGINT REFERENCES cases(id) (migration 006). An INNER join is correct:
# a case with no inference row carries nothing to research, and an inference row whose case was
# deleted is unusable without its features.
_RESEARCH_COUNT = """SELECT COUNT(*)
                       FROM inference_log il
                       JOIN cases c ON c.id = il.case_id"""


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it (same seam as admin.py)."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _client_ip() -> str:
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote_addr or "")


def _close_quietly(closeable):
    try:
        closeable.close()
    except Exception:  # pragma: no cover - defensive
        pass


def _num(value):
    """DECIMAL/NUMERIC -> float, preserving NULL as None.

    NULL must stay None, never 0.0: a fabricated zero would be absorbed into a dissertation MAE
    calculation as a genuine "no payout" prediction. float() (not Decimal) matches admin.py's
    established money convention — a codebase-wide decision recorded in deferred-work.md.
    """
    return None if value is None else float(value)


def _row_to_dict(row):
    (
        inference_log_id,
        canonical_id,
        model_type,
        model_version,
        prediction,
        confidence,
        was_overridden,
        override_category,
        ground_truth,
        damage_category,
        district,
        ds_division_id,
        estimate_lkr,
        approved_amount,
        created_at,
    ) = row
    return {
        "inference_log_id": inference_log_id,
        "case_canonical_id": canonical_id,
        # Included so a consumer can separate the classifier's rows from the regressor's:
        # inference_log holds BOTH 'mobilenetv2' and 'random_forest' entries, and folding the
        # latter into a confusion matrix would silently corrupt RER-2.
        "model_type": model_type,
        "model_version": model_version,
        "prediction": prediction,
        "confidence": _num(confidence),
        "was_overridden": was_overridden,
        "override_category": override_category,
        # Declared by migration 006 ("set later by admin review") but written by NOTHING in the
        # application today — verified. Exported anyway because it is the only column that could
        # ever carry a true label, and RER-2's live confusion matrix depends on it being
        # populated. Expect NULL for every row until a label-correction path exists.
        "ground_truth": ground_truth,
        "damage_category": damage_category,
        # Sinhala place NAMES, not opaque ids, despite ds_division_id's column name (migrations
        # 010/015; naming issue logged in deferred-work.md with a standing do-not-fix). DS
        # division is the coarsest geography the research needs; GPS is excluded entirely.
        "district": district,
        "ds_division_id": ds_division_id,
        "compensation_estimate_lkr": _num(estimate_lkr),
        "approved_amount": _num(approved_amount),
        # Offset-free UTC. Story 7.2's live run found isoformat()'s "+00:00" suffix is imported
        # as TEXT by spreadsheets and needs explicit parsing in pandas; _fmt_datetime already
        # solves this for the admin export, so it is reused rather than re-derived.
        "created_at": _fmt_datetime(created_at),
    }


@research_bp.route("/research/export", methods=["GET"])
@require_research()
def research_export():
    """GET /api/v1/research/export -> JSON array of per-inference research records."""
    try:
        conn = _get_connection()
    except psycopg2.Error:
        current_app.logger.exception("research export failed to connect")
        return jsonify({"error": "server_error"}), 500

    # Count + audit first, in their own committed transaction, BEFORE the body is produced.
    # This is a bulk data egress; Story 7.2's review established that an audit write which runs
    # after (or inside) body generation can be skipped entirely on client disconnect, leaving no
    # record at all. Buying one extra query to make the audit row honest is the same trade made
    # there.
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(_RESEARCH_COUNT)
                matched = cur.fetchone()[0]
                row_count = min(matched, RESEARCH_MAX_ROWS)

                write_audit_log(
                    cur,
                    None,
                    "research_exported_data",
                    g.researcher_id,
                    {
                        "ip_address": _client_ip(),
                        # Named to be honest about what it is (7.2 review finding): the COUNT
                        # commits here and the SELECT opens a new transaction, so under READ
                        # COMMITTED a concurrent insert between them means the delivered count
                        # can differ. It is the count authorised at audit time, not a guarantee.
                        "row_count_at_audit": row_count,
                        "matched_count": matched,
                        "truncated": matched > RESEARCH_MAX_ROWS,
                        "row_limit": RESEARCH_MAX_ROWS,
                    },
                )
    except Exception:
        # Broadened from psycopg2.Error deliberately (7.2 review finding): a TypeError raised
        # inside write_audit_log's json.dumps previously propagated with the connection never
        # closed, and with no pool and a single sync worker those leaks accumulate against the
        # Postgres connection cap.
        _close_quietly(conn)
        current_app.logger.exception("research export audit/count failed")
        return jsonify({"error": "server_error"}), 500

    # Buffered, not streamed — and that is a deliberate difference from /admin/export's CSV path.
    # A JSON array cannot be assembled incrementally without hand-rolling the framing, and the
    # row cap bounds the payload. Executing here (rather than inside a generator that runs after
    # the view returns) is what makes a mid-query DB failure a clean 500 instead of a silently
    # truncated 200 body — 7.2's review found exactly that bug in its own streaming path.
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(_RESEARCH_SELECT, (RESEARCH_MAX_ROWS,))
                rows = cur.fetchall()
    except Exception:
        # Broadened to match the audit/count block above, for the same reason recorded there: a
        # non-psycopg2 failure (a driver-level TypeError, a serialization error surfacing from
        # the cursor) otherwise escapes as an unhandled 500 with no log line and without the
        # {"error": "server_error"} contract every other route in this API honours. The `finally`
        # already prevents the connection leak; this is about the response contract.
        current_app.logger.exception("research export query failed")
        return jsonify({"error": "server_error"}), 500
    finally:
        _close_quietly(conn)

    payload = [_row_to_dict(r) for r in rows]
    response = jsonify(payload)
    response.headers["X-HEC-Row-Count"] = str(len(payload))
    # Derived from what was actually delivered, NOT from `matched`. The COUNT commits in the
    # first transaction and the SELECT opens a second one, so under READ COMMITTED an insert
    # between them makes `matched > RESEARCH_MAX_ROWS` disagree with the body: the header would
    # read "false" over a payload that is genuinely capped. The audit row deliberately keeps the
    # count-time figure (it records what was authorised); the header must describe the response.
    response.headers["X-HEC-Truncated"] = "true" if len(payload) >= RESEARCH_MAX_ROWS else "false"
    # Bulk export of research records. Nothing here is public, and the route will sit behind
    # HTTPS with a proxy in front once deployed -- no intermediary should retain a copy.
    response.headers["Cache-Control"] = "no-store"
    return response
