import os

from flask import Flask
from flask_cors import CORS


def create_app(config=None):
    app = Flask(__name__)

    # Environment defaults (overridden by an explicit config mapping, e.g. in tests).
    app.config["DATABASE_URL"] = os.getenv("DATABASE_URL")
    app.config["SUPABASE_JWT_SECRET"] = os.getenv("SUPABASE_JWT_SECRET")

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

    app.register_blueprint(health_bp, url_prefix="/api/v1")
    app.register_blueprint(cases_bp, url_prefix="/api/v1")
    app.register_blueprint(status_bp, url_prefix="/api/v1/cases/status")
    app.register_blueprint(inference_bp, url_prefix="/api/v1")
    app.register_blueprint(officer_bp, url_prefix="/api/v1")
    app.register_blueprint(sms_bp, url_prefix="/api/v1")
    app.register_blueprint(citizen_bp, url_prefix="/api/v1")
    app.register_blueprint(sync_bp, url_prefix="/api/v1/sync")
    app.register_blueprint(admin_bp, url_prefix="/api/v1")

    return app
