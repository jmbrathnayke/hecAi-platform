from flask import Flask
from flask_cors import CORS


def create_app(config=None):
    app = Flask(__name__)

    if config:
        app.config.from_mapping(config)

    # Allow frontend origin (tighten in production via environment variable)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from app.api.v1.health import health_bp
    app.register_blueprint(health_bp, url_prefix="/api/v1")

    return app
