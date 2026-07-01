"""Tests for require_officer() (Story 3.1).

A throwaway Flask app + route exercises the decorator directly: missing/expired/invalid
token -> 401, non-officer role -> 403, missing server secret -> 500, and on success
g.officer_id / g.assigned_divisions are populated from a signature-verified token (never
trusted from the client without decoding here).
"""
import base64
import json
from datetime import datetime, timedelta, timezone

import jwt
from flask import Flask, g, jsonify

from app.api.v1.middleware.auth import require_officer

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256


def _token(claims, secret=SECRET, **kwargs):
    return jwt.encode(claims, secret, algorithm="HS256", **kwargs)


def _make_app(secret=SECRET):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.config["SUPABASE_JWT_SECRET"] = secret

    @app.route("/protected")
    @require_officer()
    def protected():
        return jsonify({"officer_id": g.officer_id, "assigned_divisions": g.assigned_divisions})

    return app


def test_missing_token_returns_401():
    client = _make_app().test_client()
    res = client.get("/protected")
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_invalid_token_returns_401():
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": "Bearer not-a-jwt"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_expired_token_returns_401():
    claims = {
        "sub": "officer-1",
        "user_metadata": {"role": "officer", "assigned_divisions": ["DIV-1"]},
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
    }
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "token_expired"


def test_wrong_role_returns_403():
    claims = {"sub": "citizen-1", "user_metadata": {"role": "citizen"}}
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"


def test_missing_role_metadata_returns_403():
    claims = {"sub": "officer-1"}  # no user_metadata at all
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 403


def test_missing_server_secret_returns_500():
    claims = {"sub": "officer-1", "user_metadata": {"role": "officer"}}
    client = _make_app(secret=None).test_client()
    res = client.get(
        "/protected", headers={"Authorization": f"Bearer {_token(claims, secret=SECRET)}"}
    )
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


def test_valid_officer_token_exposes_g_context():
    claims = {
        "sub": "officer-42",
        "user_metadata": {"role": "officer", "assigned_divisions": ["DIV-1", "DIV-2"]},
    }
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["officer_id"] == "officer-42"
    assert body["assigned_divisions"] == ["DIV-1", "DIV-2"]


def test_non_list_assigned_divisions_coerced_to_empty_list():
    # Defensive: a malformed claim (e.g. a string instead of an array) must not crash
    # or leak into g.assigned_divisions as a non-list.
    claims = {"sub": "officer-1", "user_metadata": {"role": "officer", "assigned_divisions": "DIV-1"}}
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    assert res.get_json()["assigned_divisions"] == []


def test_non_string_elements_filtered_out_of_assigned_divisions():
    claims = {
        "sub": "officer-1",
        "user_metadata": {"role": "officer", "assigned_divisions": ["DIV-1", 42, None, "DIV-2"]},
    }
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    assert res.get_json()["assigned_divisions"] == ["DIV-1", "DIV-2"]


def test_missing_sub_claim_returns_401():
    claims = {"user_metadata": {"role": "officer", "assigned_divisions": ["DIV-1"]}}  # no sub
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_empty_sub_claim_returns_401():
    claims = {"sub": "", "user_metadata": {"role": "officer"}}
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_alg_none_token_is_rejected():
    # Classic alg-confusion attack: a token with header {"alg": "none"} and no signature,
    # claiming to be pre-verified. PyJWT must refuse this since "none" isn't in our
    # explicit `algorithms=["HS256"]` allow-list.
    claims = {"sub": "officer-1", "user_metadata": {"role": "officer"}}

    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = _b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps(claims).encode())
    forged_token = f"{header}.{payload}."  # empty signature segment
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {forged_token}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_wrong_algorithm_token_is_rejected():
    # A token signed with a different algorithm than our explicit allow-list (HS256 only)
    # must be rejected outright, not silently accepted under a mismatched verification path.
    claims = {"sub": "officer-1", "user_metadata": {"role": "officer"}}
    mismatched_token = jwt.encode(claims, SECRET, algorithm="HS384")
    client = _make_app().test_client()
    res = client.get("/protected", headers={"Authorization": f"Bearer {mismatched_token}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"
