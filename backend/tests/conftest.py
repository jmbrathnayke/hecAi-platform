import pytest

from app import create_app


@pytest.fixture(autouse=True)
def _isolate_supabase_env(monkeypatch):
    """Keep an ambient SUPABASE_URL out of every test app (code review 2026-08-13).

    create_app() derives SUPABASE_JWKS_URL from the environment BEFORE it applies the config
    mapping, and no test config names that key — so `from_mapping` merges over the top and the
    env-derived value survives. Every HS256 token the suite mints would then take the JWKS
    branch and make real HTTPS calls to the production Supabase project.

    That is not hypothetical: both operator scripts instruct you to `set SUPABASE_URL=...` in
    your shell, and `backend/.env` already carries the key. A developer who runs
    set_staff_claims.py and then pytest in the same terminal would otherwise watch nine unrelated
    test modules fail for reasons that have nothing to do with the code under test.

    Autouse and defined at the root so it also covers tests/scenarios/. Tests that WANT the JWKS
    path (test_auth_jwks.py) set SUPABASE_JWKS_URL in app config directly, which this does not
    touch.
    """
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWKS_URL", raising=False)


@pytest.fixture
def app():
    app = create_app({"TESTING": True, "DATABASE_URL": None})
    yield app


@pytest.fixture
def client(app):
    return app.test_client()
