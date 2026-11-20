"""AWS Elastic Beanstalk entry point.

The EB Python platform's default WSGIPath is ``application:application``, so this module must be
named ``application.py`` and expose a Flask instance called ``application``.

``create_app()`` returns that Flask instance with every blueprint, CORS rule and config value
already applied. Writing a bare ``Flask(__name__)`` here instead would give a second, empty app
with no API routes behind it.

``wsgi.py`` (``wsgi:app``) stays as it is for the Render/Azure start commands. Both files build
the same app.
"""
import os

from dotenv import load_dotenv

# Load .env before importing the factory: create_app() reads os.environ when it is called. On EB
# there is usually no .env file, so this does nothing and the environment properties are used.
load_dotenv()

from app import create_app  # noqa: E402

application = create_app()


@application.route("/health", methods=["GET"])
def health():
    """Liveness probe for the Elastic Beanstalk load balancer.

    Touches no database or external service, so a Neon or Supabase outage does not make EB mark
    healthy instances as failed and restart them. /api/v1/health remains for the existing clients.
    """
    return {"status": "ok"}, 200


if __name__ == "__main__":
    application.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")
