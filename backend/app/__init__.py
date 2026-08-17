import os
from urllib.parse import urlparse

from flask import Flask
from flask_cors import CORS


def _https_url(value, label):
    """Accept a URL only over TLS. Returns None for anything else.

    This string is the trust root of the whole JWKS verification path, and nothing else checks
    it (code review 2026-08-13). An `http://` value — a plausible copy-paste, or a local-dev
    leftover promoted to production — means signing keys are fetched in plaintext: anyone on the
    path substitutes their own JWKS and every token they forge verifies for as long as the key
    cache lives. Fail closed to None (the guards then 500 with `server_misconfigured`) rather
    than silently trusting a downgradeable endpoint.
    """
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme == "https" and parsed.netloc:
        return value
    # Localhost over http is the one case a developer legitimately needs (supabase start).
    if parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"):
        return value
    raise ValueError(
        f"{label} must be an https:// URL (got {parsed.scheme or 'no scheme'}://). "
        "Refusing to fetch signing keys over an untrusted transport."
    )


def create_app(config=None):
    app = Flask(__name__)

    # Environment defaults (overridden by an explicit config mapping, e.g. in tests).
    app.config["DATABASE_URL"] = os.getenv("DATABASE_URL")
    app.config["SUPABASE_JWT_SECRET"] = os.getenv("SUPABASE_JWT_SECRET")

    # Request body cap. Nothing set one before, anywhere: sync.py's MAX_BATCH_SIZE = 50 caps the
    # number of ITEMS in a batch but not their size, and cases.py's single submit had no cap at
    # all, so one oversized body could exhaust the dyno's memory before any view code ran.
    #
    # 2 MB is deliberately generous for what actually ships today: every payload is small JSON,
    # because there is no photo-upload pipeline server-side (see deferred-work.md) -- a 50-item
    # sync batch measures in kilobytes. Raise this WITH the photo pipeline, not before, and
    # revisit it then rather than inheriting a number chosen for text.
    app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_CONTENT_LENGTH_BYTES", 2 * 1024 * 1024))

    # Supabase now signs JWTs with a rotating ES256 key published at the project's JWKS endpoint;
    # SUPABASE_JWT_SECRET is the legacy HS256 mode it replaces. When a JWKS URL is present the
    # auth guards verify against it and ignore the shared secret entirely (see
    # app/api/v1/middleware/auth.py — the two modes must never be accepted in the same call).
    # Derived from SUPABASE_URL so a normal deployment only sets the one variable; tests set
    # neither and fall back to the HS256 path.
    #
    # Both are scheme-checked: see _https_url(). SUPABASE_JWKS_URL is an override that outranks
    # the derived value, so it is documented in .env.example alongside SUPABASE_URL rather than
    # existing only in this source file.
    supabase_url = _https_url(os.getenv("SUPABASE_URL"), "SUPABASE_URL")
    app.config["SUPABASE_JWKS_URL"] = _https_url(
        os.getenv("SUPABASE_JWKS_URL"), "SUPABASE_JWKS_URL"
    ) or (
        f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json" if supabase_url else None
    )
    # Expected `iss` for tokens from this project. Only derivable from SUPABASE_URL — when the
    # JWKS URL is set by hand there is nothing to derive it from, and the guards skip the issuer
    # check rather than reject every token (see middleware/auth.py).
    app.config["SUPABASE_ISSUER"] = (
        f"{supabase_url.rstrip('/')}/auth/v1" if supabase_url else None
    )

    # Twilio SMS fallback (Story 3.6). Absent in tests (mocked) and until the DWC Twilio number
    # is provisioned; the webhook fails signature validation closed when TWILIO_AUTH_TOKEN is unset.
    app.config["TWILIO_ACCOUNT_SID"] = os.getenv("TWILIO_ACCOUNT_SID")
    app.config["TWILIO_AUTH_TOKEN"] = os.getenv("TWILIO_AUTH_TOKEN")
    app.config["TWILIO_FROM_NUMBER"] = os.getenv("TWILIO_FROM_NUMBER")
    app.config["TWILIO_PUBLIC_WEBHOOK_URL"] = os.getenv("TWILIO_PUBLIC_WEBHOOK_URL")

    if config:
        app.config.from_mapping(config)

    # Allow frontend origin (tighten in production via environment variable).
    #
    # expose_headers added for Story 7.2's export (code review finding): flask-cors defaults
    # expose_headers to None, and Content-Disposition is NOT a CORS-safelisted response header.
    # The frontend is a different origin from this API (NEXT_PUBLIC_API_URL, cross-origin even
    # in dev: Next on :3000, Flask on :5000), so without this the browser hides the header
    # entirely -- res.headers.get("Content-Disposition") returns null and every export saved as
    # the fallback filename, losing the date stamp the backend builds. Same for the X-HEC-*
    # headers, which the export UI reads to warn about truncated results.
    CORS(
        app,
        resources={r"/api/*": {"origins": "*"}},
        expose_headers=["Content-Disposition", "X-HEC-Row-Count", "X-HEC-Truncated"],
    )

    from app.api.v1.health import health_bp
    from app.api.v1.cases import cases_bp
    from app.api.v1.status import status_bp
    from app.api.v1.inference import inference_bp
    from app.api.v1.officer import officer_bp
    from app.api.v1.sms import sms_bp
    from app.api.v1.citizen import citizen_bp
    from app.api.v1.sync import sync_bp
    from app.api.v1.admin import admin_bp
    from app.api.v1.research import research_bp

    app.register_blueprint(health_bp, url_prefix="/api/v1")
    app.register_blueprint(cases_bp, url_prefix="/api/v1")
    app.register_blueprint(status_bp, url_prefix="/api/v1/cases/status")
    app.register_blueprint(inference_bp, url_prefix="/api/v1")
    app.register_blueprint(officer_bp, url_prefix="/api/v1")
    app.register_blueprint(sms_bp, url_prefix="/api/v1")
    app.register_blueprint(citizen_bp, url_prefix="/api/v1")
    app.register_blueprint(sync_bp, url_prefix="/api/v1/sync")
    app.register_blueprint(admin_bp, url_prefix="/api/v1")
    app.register_blueprint(research_bp, url_prefix="/api/v1")

    return app
