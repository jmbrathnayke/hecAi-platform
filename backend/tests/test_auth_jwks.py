"""ES256-via-JWKS verification for Supabase tokens (fixed 2026-08-11).

Supabase signs JWTs with a rotating EC key published at the project's JWKS endpoint. The guards
previously hard-coded `algorithms=["HS256"]` against the legacy shared secret, so PyJWT raised
InvalidAlgorithmError on every real token and every authenticated API call returned 401 — a
fully-authenticated officer saw an empty dashboard.

These tests use a locally-generated P-256 key and a stubbed JWKS fetch, so they exercise the real
PyJWKClient code path (kid lookup, caching, rotation) with no network.
"""
import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from flask import Flask, g, jsonify

from app.api.v1.middleware import auth as auth_module
from app.api.v1.middleware.auth import require_admin, require_officer

JWKS_URL = "https://example.supabase.co/auth/v1/.well-known/jwks.json"
ISSUER = "https://example.supabase.co/auth/v1"
KID = "test-key-1"
LEGACY_SECRET = "test-jwt-secret-0123456789-abcdef-ghij"


def _b64u(n: int) -> str:
    raw = n.to_bytes(32, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.fixture
def ec_key():
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
def jwks(ec_key):
    numbers = ec_key.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "EC",
                "crv": "P-256",
                "alg": "ES256",
                "use": "sig",
                "kid": KID,
                "x": _b64u(numbers.x),
                "y": _b64u(numbers.y),
            }
        ]
    }


@pytest.fixture(autouse=True)
def _isolate_jwk_client_cache():
    """Both module-level caches would otherwise leak between tests."""
    auth_module._jwk_clients.clear()
    auth_module._kid_misses.clear()
    yield
    auth_module._jwk_clients.clear()
    auth_module._kid_misses.clear()


@pytest.fixture
def stub_jwks(monkeypatch, jwks):
    calls = {"count": 0}

    def fake_fetch_data(self):
        calls["count"] += 1
        # The real fetch_data() populates the JWK-set cache in a `finally` block; a stub that
        # skips that step disables the lifespan-based cache entirely. That mattered: before
        # 2026-08-13 this stub made test_jwks_is_cached_across_requests pass via PyJWKClient's
        # per-key lru_cache instead — so the test proved the very cache we had to remove (it had
        # no TTL, so a revoked key stayed trusted forever) and proved nothing about `lifespan`.
        if self.jwk_set_cache is not None:
            self.jwk_set_cache.put(jwks)
        return jwks

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fake_fetch_data)
    return calls


def _es256(ec_key, claims, kid=KID):
    """Mint a token that looks like a real Supabase one.

    `aud`/`iss`/`exp` are defaults rather than fixtures-per-test because the guards now REQUIRE
    them on the JWKS path (code review 2026-08-13) — a token without them is not a token
    Supabase would ever issue. Individual tests override any of the three to prove the checks.
    """
    payload = {
        "aud": "authenticated",
        "iss": ISSUER,
        "exp": datetime.now(tz=timezone.utc) + timedelta(hours=1),
        **claims,
    }
    return jwt.encode(payload, ec_key, algorithm="ES256", headers={"kid": kid})


def _make_app(jwks_url=JWKS_URL, secret=None, guard=require_officer):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.config["SUPABASE_JWKS_URL"] = jwks_url
    app.config["SUPABASE_ISSUER"] = ISSUER if jwks_url else None
    app.config["SUPABASE_JWT_SECRET"] = secret

    @app.route("/protected")
    @guard()
    def protected():
        return jsonify({"sub": g.get("officer_id") or g.get("admin_id")})

    return app


def _get(app, token):
    return app.test_client().get("/protected", headers={"Authorization": f"Bearer {token}"})


def test_es256_token_is_accepted_via_jwks(ec_key, stub_jwks):
    # The regression: this exact shape used to 401 with `invalid_token`.
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    res = _get(_make_app(), token)
    assert res.status_code == 200
    assert res.get_json()["sub"] == "officer-1"


def test_role_is_still_enforced_on_a_validly_signed_token(ec_key, stub_jwks):
    token = _es256(ec_key, {"sub": "citizen-1", "app_metadata": {"role": "citizen"}})
    res = _get(_make_app(), token)
    assert res.status_code == 403


def test_admin_guard_also_uses_the_jwks_path(ec_key, stub_jwks):
    token = _es256(ec_key, {"sub": "admin-1", "app_metadata": {"role": "admin"}})
    res = _get(_make_app(guard=require_admin), token)
    assert res.status_code == 200


def test_hs256_token_signed_with_the_public_key_is_rejected(ec_key, stub_jwks, jwks):
    """Algorithm confusion — the attack that makes merging HS256 and ES256 catastrophic.

    The EC public key is published at the JWKS URL, so it is not secret. If HS256 were accepted
    alongside ES256, an attacker could HMAC-sign any claims they liked using that public key and
    the server would verify them with the same value — minting admin tokens from public data.
    """
    pub_pem = ec_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    # Forged by hand rather than via jwt.encode(): PyJWT refuses to USE a PEM as an HMAC secret,
    # but an attacker has no such scruples and is writing the bytes directly. This is what
    # actually arrives on the wire.
    def seg(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=")

    signing_input = (
        seg({"alg": "HS256", "typ": "JWT", "kid": KID})
        + b"."
        + seg({"sub": "attacker", "app_metadata": {"role": "admin"}})
    )
    signature = base64.urlsafe_b64encode(
        hmac.new(pub_pem, signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")
    forged = (signing_input + b"." + signature).decode()

    res = _get(_make_app(guard=require_admin), forged)
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_expired_es256_token_reports_token_expired(ec_key, stub_jwks):
    token = _es256(
        ec_key,
        {
            "sub": "officer-1",
            "app_metadata": {"role": "officer"},
            "exp": datetime.now(tz=timezone.utc) - timedelta(minutes=1),
        },
    )
    res = _get(_make_app(), token)
    assert res.status_code == 401
    assert res.get_json()["error"] == "token_expired"


def test_token_signed_by_an_unknown_key_is_rejected(stub_jwks):
    other_key = ec.generate_private_key(ec.SECP256R1())
    token = _es256(other_key, {"sub": "attacker", "app_metadata": {"role": "admin"}})
    res = _get(_make_app(guard=require_admin), token)
    assert res.status_code == 401


def test_jwks_is_cached_across_requests(ec_key, stub_jwks):
    """Without caching, every authenticated API call would make an HTTPS round-trip to Supabase."""
    app = _make_app()
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    for _ in range(3):
        assert _get(app, token).status_code == 200
    assert stub_jwks["count"] == 1


def test_jwks_unreachable_is_a_500_not_a_401(monkeypatch, ec_key):
    """A Supabase blip must not look like an invalid token, or every officer gets signed out."""

    def boom(self):
        raise jwt.PyJWKClientConnectionError("unreachable")

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", boom)
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    res = _get(_make_app(), token)
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


def test_jwks_takes_precedence_over_a_stale_legacy_secret(ec_key, stub_jwks):
    """Both configured: the asymmetric path wins, so a leftover secret can't weaken verification."""
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    assert _get(_make_app(secret=LEGACY_SECRET), token).status_code == 200

    legacy = jwt.encode(
        {"sub": "officer-1", "app_metadata": {"role": "officer"}}, LEGACY_SECRET, algorithm="HS256"
    )
    assert _get(_make_app(secret=LEGACY_SECRET), legacy).status_code == 401


def test_legacy_hs256_still_works_when_no_jwks_is_configured():
    """Self-hosted/older projects with only the shared secret must keep working."""
    token = jwt.encode(
        {"sub": "officer-1", "app_metadata": {"role": "officer"}}, LEGACY_SECRET, algorithm="HS256"
    )
    res = _get(_make_app(jwks_url=None, secret=LEGACY_SECRET), token)
    assert res.status_code == 200


def test_no_verification_material_at_all_is_a_500(ec_key):
    res = _get(_make_app(jwks_url=None, secret=None), "irrelevant")
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


# --- Code review 2026-08-13 ---------------------------------------------------------------


def test_token_for_another_audience_is_rejected(ec_key, stub_jwks):
    """Without an `aud` check the trust model was merely "signed by the project key", which
    accepts any other token the project ever mints for a different service."""
    token = _es256(
        ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}, "aud": "some-other-api"}
    )
    res = _get(_make_app(), token)
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_token_from_another_issuer_is_rejected(ec_key, stub_jwks):
    token = _es256(
        ec_key,
        {
            "sub": "officer-1",
            "app_metadata": {"role": "officer"},
            "iss": "https://evil.supabase.co/auth/v1",
        },
    )
    res = _get(_make_app(), token)
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_token_without_exp_never_expires_so_it_is_rejected(ec_key, stub_jwks):
    """PyJWT only validates `exp` when present, so a token minted without one is immortal."""
    claims = {"sub": "officer-1", "app_metadata": {"role": "officer"}}
    payload = {"aud": "authenticated", "iss": ISSUER, **claims}
    token = jwt.encode(payload, ec_key, algorithm="ES256", headers={"kid": KID})
    res = _get(_make_app(), token)
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_an_unknown_kid_is_only_looked_up_once(ec_key, stub_jwks):
    """Negative cache: a forged `kid` bypasses the lifespan window (PyJWKClient refetches with
    refresh=True on a miss) and lru_cache never memoizes the raised exception — so without this
    an unauthenticated flood cost one live HTTPS fetch per request."""
    app = _make_app()
    token = _es256(ec_key, {"sub": "attacker", "app_metadata": {"role": "admin"}}, kid="no-such-kid")

    assert _get(app, token).status_code == 401
    fetches_after_first = stub_jwks["count"]
    for _ in range(5):
        assert _get(app, token).status_code == 401

    # The five repeats were served from the negative cache, not from Supabase.
    assert stub_jwks["count"] == fetches_after_first


def test_a_connectivity_failure_does_not_poison_the_kid_cache(monkeypatch, ec_key, jwks):
    """A blip says nothing about the kid. Caching it would turn a transient Supabase outage into
    60 seconds of spurious 401s for perfectly valid tokens."""
    app = _make_app()
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})

    def boom(self):
        raise jwt.PyJWKClientConnectionError("unreachable")

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", boom)
    assert _get(app, token).status_code == 500

    # Supabase comes back; the very next request must succeed.
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: jwks)
    auth_module._jwk_clients.clear()
    assert _get(app, token).status_code == 200


def test_non_json_jwks_response_is_a_500_not_a_traceback(monkeypatch, ec_key):
    """A paused Supabase project or a captive portal returns an HTML error page. json.load raises
    JSONDecodeError, which PyJWKClient does NOT wrap — it used to escape to Flask's generic
    handler, outside the deliberate 500/401 contract."""

    def html(self):
        raise json.JSONDecodeError("Expecting value", "<html>503</html>", 0)

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", html)
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    res = _get(_make_app(), token)
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


def test_anonymous_caller_gets_401_not_a_configuration_hint():
    """Someone who presented no credential must not learn whether auth is configured."""
    app = _make_app(jwks_url=None, secret=None)
    res = app.test_client().get("/protected")
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_signing_keys_are_not_cached_past_the_lifespan_window(ec_key, stub_jwks, jwks):
    """cache_keys=True put an lru_cache with no TTL in front of the lifespan window, so a REVOKED
    key kept verifying until the worker restarted. With it off, dropping a key from the JWK set
    takes effect on the next refresh."""
    app = _make_app()
    token = _es256(ec_key, {"sub": "officer-1", "app_metadata": {"role": "officer"}})
    assert _get(app, token).status_code == 200

    # Revoke: the key disappears from the published set, and the lifespan window elapses.
    jwks["keys"] = []
    auth_module._jwk_clients[JWKS_URL].jwk_set_cache.lifespan = -1

    assert _get(app, token).status_code == 401
