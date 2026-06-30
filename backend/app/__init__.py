import os

from flask import Flask
from flask_cors import CORS


def create_app(config=None):
    app = Flask(__name__)

    # Environment defaults (overridden by an explicit config mapping, e.g. in tests).
    app.config["DATABASE_URL"] = os.getenv("DATABASE_URL")
    app.config["SUPABASE_JWT_SECRET"] = os.getenv("SUPABASE_JWT_SECRET")

    if config:
        app.config.from_mapping(config)

    # Allow frontend origin (tighten in production via environment variable)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from app.api.v1.health import health_bp
    from app.api.v1.cases import cases_bp

    app.register_blueprint(health_bp, url_prefix="/api/v1")
    app.register_blueprint(cases_bp, url_prefix="/api/v1")

    return app
