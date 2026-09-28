"""Supabase Storage access for case evidence photographs (migration 038).

WHY SUPABASE STORAGE AND NOT A POSTGRES COLUMN. The bytes are megabytes and the rows are read in
galleries; putting them in `cases`' own database would put them in every backup and every
connection the workflow queries share. Supabase is already this deployment's identity provider and
its service-role credential is already configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, used
by users.py for the Auth Admin API), so this adds a bucket rather than a dependency. The
`BLOB_READ_WRITE_TOKEN` that render.yaml once declared is not revived: it named a second provider
for the same job.

THE BUCKET IS PRIVATE, AND THAT IS THE WHOLE SECURITY MODEL. A public bucket would make every
family's damaged home readable by anyone who learned a URL -- there is no case reference in the
path to guess, but a leaked URL would never expire and could not be revoked. Instead nothing is
served directly: a reader who passes the case's own JWT scope check is handed a signed URL that
expires in minutes (SIGNED_URL_TTL_SECONDS). The service-role key never leaves this process.

EVERY FUNCTION HERE IS BEST-EFFORT AND NEVER RAISES INTO A REQUEST. Storage being unreachable must
degrade the gallery, not fail the case workflow that the photograph is attached to -- an officer
must still be able to submit an assessment when the object store is down. Failures return None (or
False) and are logged; the caller decides what that means.
"""
import hashlib
import logging
import uuid

import requests
from flask import current_app

logger = logging.getLogger(__name__)

BUCKET = "case-photos"

# Short enough that a URL pasted into a chat is useless by the time anyone follows it; long enough
# for a gallery of ten photographs to finish loading on a rural connection.
SIGNED_URL_TTL_SECONDS = 600

_TIMEOUT = 20

# Accepted upload types, and the extension each is stored with. Deliberately a whitelist: the
# bucket is served back to browsers via signed URLs, and an SVG (which can carry script) or an
# HTML file mislabelled as an image would run in the viewer's origin.
ALLOWED_CONTENT_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

# 8 MB. A modern phone photograph is 2-5 MB; the frontend downscales before upload, so anything
# past this is a client that did not, or a file that is not a photograph.
MAX_BYTES = 8 * 1024 * 1024

# Per case, per source. Ten is the citizen capture limit the report form already enforces
# (frontend report/photos MAX_PHOTOS); the officer's own limit is the same for symmetry.
MAX_PHOTOS_PER_SOURCE = 10


def is_configured():
    """True when uploads can be attempted at all. Checked before the DB write so a case never
    gains a `case_photos` row pointing at an object that was never stored."""
    return bool(_config()[0])


def _config():
    url = (current_app.config.get("SUPABASE_URL") or "").rstrip("/")
    key = current_app.config.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None, None
    return url, key


def _headers(key, extra=None):
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if extra:
        headers.update(extra)
    return headers


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_path(case_id, source, content_type) -> str:
    """`<case id>/<source>/<random>.<ext>`.

    The random component, not the hash, because two cases may legitimately hold the same
    photograph and each must own its object -- deduplication is a per-case database constraint
    (idx_case_photos_case_sha), not a storage-path collision.
    """
    ext = ALLOWED_CONTENT_TYPES.get(content_type, "bin")
    return f"{case_id}/{source}/{uuid.uuid4().hex}.{ext}"


def ensure_bucket() -> bool:
    """Create the private bucket if it is absent. Idempotent; a 409 means it already exists.

    Done here rather than in a deploy step so a fresh environment works without a console visit,
    and `public: false` is asserted in code where it can be read next to the reasoning above,
    rather than being a checkbox someone might later tick.
    """
    url, key = _config()
    if not url:
        return False
    try:
        res = requests.post(
            f"{url}/storage/v1/bucket",
            headers=_headers(key, {"Content-Type": "application/json"}),
            json={"id": BUCKET, "name": BUCKET, "public": False,
                  "file_size_limit": MAX_BYTES,
                  "allowed_mime_types": sorted(ALLOWED_CONTENT_TYPES)},
            timeout=_TIMEOUT,
        )
    except requests.RequestException:
        logger.exception("Could not reach Supabase Storage to ensure the bucket")
        return False
    if res.status_code in (200, 201):
        logger.info("Created private storage bucket %s", BUCKET)
        return True
    if res.status_code == 409:
        return True
    logger.warning("Unexpected response creating bucket %s: %s", BUCKET, res.status_code)
    return False


def upload(path: str, data: bytes, content_type: str) -> bool:
    """Store the bytes. False on any failure, having logged it."""
    url, key = _config()
    if not url:
        return False
    try:
        res = requests.post(
            f"{url}/storage/v1/object/{BUCKET}/{path}",
            headers=_headers(key, {"Content-Type": content_type,
                                   # Evidence: an object is written once and never replaced.
                                   "x-upsert": "false"}),
            data=data,
            timeout=_TIMEOUT,
        )
    except requests.RequestException:
        logger.exception("Photo upload failed to reach storage")
        return False
    if res.status_code in (200, 201):
        return True
    # A 404 on the bucket means a fresh environment: create it once and retry, so the first
    # upload after a deploy succeeds instead of failing until someone notices.
    if res.status_code == 404 and ensure_bucket():
        try:
            retry = requests.post(
                f"{url}/storage/v1/object/{BUCKET}/{path}",
                headers=_headers(key, {"Content-Type": content_type, "x-upsert": "false"}),
                data=data,
                timeout=_TIMEOUT,
            )
        except requests.RequestException:
            logger.exception("Photo upload retry failed to reach storage")
            return False
        return retry.status_code in (200, 201)
    logger.warning("Photo upload rejected by storage: %s %s", res.status_code, res.text[:200])
    return False


def signed_url(path: str, ttl: int = SIGNED_URL_TTL_SECONDS):
    """A short-lived absolute URL for one object, or None.

    Signing is per object rather than per bucket so a viewer authorised for one case never holds a
    credential that would open another's.
    """
    url, key = _config()
    if not url:
        return None
    try:
        res = requests.post(
            f"{url}/storage/v1/object/sign/{BUCKET}/{path}",
            headers=_headers(key, {"Content-Type": "application/json"}),
            json={"expiresIn": ttl},
            timeout=_TIMEOUT,
        )
    except requests.RequestException:
        logger.exception("Could not sign a photo URL")
        return None
    if res.status_code != 200:
        logger.warning("Storage refused to sign %s: %s", path, res.status_code)
        return None
    try:
        signed = res.json().get("signedURL") or res.json().get("signedUrl")
    except ValueError:
        return None
    if not signed:
        return None
    # Supabase returns a path relative to /storage/v1; make it absolute so the browser can use it
    # without the frontend having to know the storage host.
    return f"{url}/storage/v1{signed}" if signed.startswith("/") else signed


def sign_many(paths):
    """-> {path: url} for the paths that could be signed. A gallery with one unsignable object
    still renders the rest, which is better than an empty screen over a single bad row."""
    return {p: u for p in paths if (u := signed_url(p)) is not None}
