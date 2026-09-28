"""Case evidence photographs (migration 038).

    POST /api/v1/cases/<ref>/photos   upload one image   (citizen: own case · officer: in scope)
    GET  /api/v1/cases/<ref>/photos   list with signed URLs (citizen, officer, admin, ds_officer)

WHAT THIS CLOSES. Until now no image reached this server. An administrator approved, and a
Divisional Secretariat paid, on a class label and a percentage: nobody downstream of the field
officer could see what had been photographed, so a decision could not be shown to anyone and an
appeal against it could not be examined. The photographs existed the whole time -- in the
citizen's browser and in the officer's -- with nowhere to go.

WHAT IT DOES NOT CHANGE. MobileNetV2 still runs entirely in the officer's browser on the officer's
own photograph (FR-2.1/2.2). No image is sent anywhere to be classified, and nothing here is a
model input. Storing evidence and running inference on-device are independent claims; only the
first is new.

SCOPE IS THE CASE'S OWN SCOPE, TAKEN FROM THE JWT. A photograph is the most revealing thing this
system holds about a household, so its visibility is not widened by an inch beyond the case it
belongs to: an officer sees the cases they submitted or whose DS division they are assigned
(officer_cases.py's rule verbatim), an administrator their district (admin.py's rule), a DS officer
their division (ds.py's rule), a citizen only cases belonging to their own household. `system_admin`
holds no area claim and therefore sees none -- that falls out of the scope being empty rather than
needing a special case. Out of scope is 404, never 403, so a case's existence is never confirmed
to someone who may not see it.

WHO UPLOADS WHAT. A citizen may add `citizen` photographs to their own case; an officer may add
`officer` photographs to a case in their scope. Neither may write the other's source label, because
the label is what tells the administrator whether they are looking at the claimant's account of the
damage or the verifying officer's. Administrators and DS officers never upload: they decide on
evidence, they do not produce it.

EVERY UPLOAD AND EVERY VIEW IS AUDITED. `case_photo_uploaded` and `case_photos_viewed` go into the
hash-chained audit_log, so who looked at a family's photographs is answerable afterwards. That is
the control that makes storing them defensible at all.
"""
import re

import psycopg2
from flask import Blueprint, current_app, g, jsonify, request

from app.api.v1.middleware.auth import authenticated_claims, authz_metadata, authz_role
from app.infrastructure.audit import write_audit_log
from app.infrastructure.storage import photo_store

case_photos_bp = Blueprint("case_photos", __name__)

HEC_RE = re.compile(r"^HEC-\d{4}-\d+$", re.IGNORECASE)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

# Roles that may look at a case's photographs, and the one column each is scoped by.
_STAFF_SCOPE_COLUMN = {
    "officer": "ds_division_id",
    "admin": "district",
    "ds_officer": "ds_division_id",
}


def _get_connection():
    """Open a DB connection. Isolated so tests can monkeypatch it."""
    return psycopg2.connect(current_app.config["DATABASE_URL"])


def _staff_scope(role, meta):
    """-> the administrative areas this staff account covers, as a list; [] when it covers none.

    Same normalisation as notifications._staff_scope; kept as a list for every role so the scope
    predicate below is one shape (`= ANY(%s)`) rather than three.
    """
    if role == "admin":
        value = meta.get("district_id")
        return [value] if isinstance(value, str) and value.strip() else []
    if role == "ds_officer":
        value = meta.get("ds_division")
        return [value] if isinstance(value, str) and value.strip() else []
    if role == "officer":
        value = meta.get("assigned_divisions")
        if not isinstance(value, list):
            return []
        return [v for v in value if isinstance(v, str) and v.strip()]
    return []


def _resolve_case(cur, reference, claims):
    """-> (case_id, may_upload_source) for a case this caller may see, else (None, None).

    `reference` is a canonical id (HEC-2026-0295) or an offline id (the uuid the citizen's browser
    minted). Both are accepted because the citizen uploads immediately after the case syncs, when
    the offline id is what their draft holds, while staff only ever have the canonical id.
    """
    if HEC_RE.match(reference):
        where, value = "c.canonical_id = %s", reference.upper()
    elif UUID_RE.match(reference):
        where, value = "c.offline_id = %s", reference
    else:
        return None, None

    role = authz_role(claims)
    meta = authz_metadata(claims)
    subject = claims.get("sub")

    if role in _STAFF_SCOPE_COLUMN:
        scope = _staff_scope(role, meta)
        # An officer also reaches a case they submitted themselves, even outside their divisions --
        # officer_cases.py's rule, and the reason an officer-assisted submission stays workable.
        extra = " OR c.officer_id = %s" if role == "officer" else ""
        params = [value, scope] + ([subject] if extra else [])
        cur.execute(
            f"""SELECT c.id FROM cases c
                 WHERE {where}
                   AND (({_STAFF_SCOPE_COLUMN[role]} IS NOT NULL
                         AND {_STAFF_SCOPE_COLUMN[role]} = ANY(%s)){extra})""",
            tuple(params),
        )
        row = cur.fetchone()
        return (row[0], "officer" if role == "officer" else None) if row else (None, None)

    if role in ("system_admin",):
        # No district and no division: /system provisions accounts, it does not review cases.
        return None, None

    # A citizen. Their own household's cases -- and `cases.citizen_id` as well, so a report filed
    # before the household was registered is still reachable by the person who filed it.
    #
    # The household link is `registrant_uid` (migration 025), NOT a `citizen_id` column: households
    # has no such column, and naming one here raised UndefinedColumn against the real database while
    # every unit test passed, because they fake the cursor. Same predicate as
    # notifications.py's citizen feed and households.py's lookup.
    cur.execute(
        f"""SELECT c.id FROM cases c
             LEFT JOIN households h ON h.id = c.household_id
             WHERE {where}
               AND (c.citizen_id = %s OR h.registrant_uid = %s)""",
        (value, subject, subject),
    )
    row = cur.fetchone()
    return (row[0], "citizen") if row else (None, None)


@case_photos_bp.route("/cases/<ref>/photos", methods=["GET"])
def list_case_photos(ref):
    """The case's photographs, newest last, each with a short-lived signed URL."""
    claims, error = authenticated_claims()
    if error:
        return error

    try:
        conn = _get_connection()
    except psycopg2.Error:
        current_app.logger.exception("case photo list: no database connection")
        return jsonify({"error": "unavailable"}), 503
    try:
        with conn:
            with conn.cursor() as cur:
                case_id, _ = _resolve_case(cur, ref, claims)
                if case_id is None:
                    return jsonify({"error": "not_found"}), 404

                cur.execute(
                    """SELECT id, source, storage_path, content_type, byte_size, created_at
                         FROM case_photos WHERE case_id = %s ORDER BY id""",
                    (case_id,),
                )
                rows = cur.fetchall()
                if not rows:
                    return jsonify({"photos": [], "storage_configured": photo_store.is_configured()})

                urls = photo_store.sign_many([r[2] for r in rows])
                photos = [
                    {
                        "id": r[0],
                        "source": r[1],
                        "content_type": r[3],
                        "byte_size": r[4],
                        "created_at": r[5].isoformat() if r[5] else None,
                        # Absent when storage could not sign it. The client shows the tile as
                        # unavailable rather than dropping it, so a missing object is visible
                        # instead of looking like a case that had no photographs.
                        "url": urls.get(r[2]),
                    }
                    for r in rows
                ]
                # Who looked at a household's photographs is part of the record. `storage_path`
                # is never written to the audit row: it is a capability, not a description.
                write_audit_log(cur, case_id, "case_photos_viewed", claims.get("sub"),
                                {"role": authz_role(claims) or "citizen", "count": len(photos)})
                return jsonify({"photos": photos, "storage_configured": True})
    except psycopg2.Error:
        current_app.logger.exception("case photo list failed")
        return jsonify({"error": "unavailable"}), 503
    finally:
        conn.close()


@case_photos_bp.route("/cases/<ref>/photos", methods=["POST"])
def upload_case_photo(ref):
    """Store one image against the case. multipart/form-data, field name `photo`."""
    claims, error = authenticated_claims()
    if error:
        return error

    if not photo_store.is_configured():
        # Said plainly rather than as a 500: the deployment has no object store, which is an
        # operator fact the client should stop retrying against.
        return jsonify({"error": "storage_not_configured"}), 503

    upload = request.files.get("photo")
    if upload is None:
        return jsonify({"error": "photo_required"}), 400

    content_type = (upload.mimetype or "").lower()
    if content_type not in photo_store.ALLOWED_CONTENT_TYPES:
        return jsonify({"error": "unsupported_content_type"}), 415

    data = upload.read()
    if not data:
        return jsonify({"error": "photo_required"}), 400
    if len(data) > photo_store.MAX_BYTES:
        return jsonify({"error": "photo_too_large"}), 413

    try:
        conn = _get_connection()
    except psycopg2.Error:
        current_app.logger.exception("case photo upload: no database connection")
        return jsonify({"error": "unavailable"}), 503
    try:
        with conn:
            with conn.cursor() as cur:
                case_id, source = _resolve_case(cur, ref, claims)
                if case_id is None:
                    return jsonify({"error": "not_found"}), 404
                if source is None:
                    # An administrator or DS officer reached a case they may READ. They decide on
                    # evidence; they do not add to it.
                    return jsonify({"error": "forbidden"}), 403

                digest = photo_store.sha256_hex(data)

                # An offline retry of an upload that already succeeded must be a no-op, not a
                # second tile. Checked before touching storage so the retry costs nothing.
                cur.execute(
                    "SELECT id FROM case_photos WHERE case_id = %s AND sha256 = %s",
                    (case_id, digest),
                )
                existing = cur.fetchone()
                if existing:
                    return jsonify({"photo_id": existing[0], "duplicate": True}), 200

                cur.execute(
                    "SELECT count(*) FROM case_photos WHERE case_id = %s AND source = %s",
                    (case_id, source),
                )
                if cur.fetchone()[0] >= photo_store.MAX_PHOTOS_PER_SOURCE:
                    return jsonify({"error": "too_many_photos"}), 409

                path = photo_store.build_path(case_id, source, content_type)
                # Storage first. A row pointing at an object that was never written would show the
                # administrator a permanently broken tile and count towards the per-case limit.
                if not photo_store.upload(path, data, content_type):
                    return jsonify({"error": "storage_unavailable"}), 502

                cur.execute(
                    """INSERT INTO case_photos
                           (case_id, source, storage_path, content_type, byte_size, sha256,
                            uploaded_by)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (case_id, sha256) DO NOTHING
                       RETURNING id""",
                    (case_id, source, path, content_type, len(data), digest, claims.get("sub")),
                )
                inserted = cur.fetchone()
                if inserted is None:
                    # Two uploads of the same bytes raced. The other one won; this one's object is
                    # orphaned in the bucket, which is preferable to a duplicate row or an error
                    # the client would retry forever.
                    return jsonify({"duplicate": True}), 200

                write_audit_log(cur, case_id, "case_photo_uploaded", claims.get("sub"),
                                {"source": source, "byte_size": len(data),
                                 "content_type": content_type})
                return jsonify({"photo_id": inserted[0], "source": source}), 201
    except psycopg2.Error:
        current_app.logger.exception("case photo upload failed")
        return jsonify({"error": "unavailable"}), 503
    finally:
        conn.close()
