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

from app.api.v1.middleware.auth import require_admin, require_officer

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


# ---------------------------------------------------------------------------
# require_admin() (Story 5.1) — mirrors the require_officer() block 1:1 at district scope.
# A separate decorator so an officer token can never reach an admin route (CRITICAL #1);
# g.admin_id / g.district_id are populated only from a signature-verified token.
# ---------------------------------------------------------------------------


def _make_admin_app(secret=SECRET):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.config["SUPABASE_JWT_SECRET"] = secret

    @app.route("/admin-protected")
    @require_admin()
    def admin_protected():
        return jsonify({"admin_id": g.admin_id, "district_id": g.district_id})

    return app


def test_admin_missing_token_returns_401():
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected")
    assert res.status_code == 401
    assert res.get_json()["error"] == "missing_token"


def test_admin_invalid_token_returns_401():
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": "Bearer not-a-jwt"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_admin_expired_token_returns_401():
    claims = {
        "sub": "admin-1",
        "user_metadata": {"role": "admin", "district_id": "DIST-1"},
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
    }
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "token_expired"


def test_officer_token_rejected_from_admin_route_403():
    # CRITICAL #1: an officer token must NOT grant admin access.
    claims = {"sub": "officer-1", "user_metadata": {"role": "officer", "assigned_divisions": ["DIV-1"]}}
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"


def test_admin_missing_role_metadata_returns_403():
    claims = {"sub": "admin-1"}  # no user_metadata at all
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 403


def test_admin_missing_server_secret_returns_500():
    claims = {"sub": "admin-1", "user_metadata": {"role": "admin"}}
    client = _make_admin_app(secret=None).test_client()
    res = client.get(
        "/admin-protected", headers={"Authorization": f"Bearer {_token(claims, secret=SECRET)}"}
    )
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


def test_valid_admin_token_exposes_g_context():
    claims = {"sub": "admin-42", "user_metadata": {"role": "admin", "district_id": "DIST-7"}}
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["admin_id"] == "admin-42"
    assert body["district_id"] == "DIST-7"


def test_admin_missing_sub_claim_returns_401():
    claims = {"user_metadata": {"role": "admin", "district_id": "DIST-1"}}  # no sub
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_admin_empty_sub_claim_returns_401():
    claims = {"sub": "", "user_metadata": {"role": "admin"}}
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_admin_alg_none_token_is_rejected():
    # Classic alg-confusion attack: header {"alg": "none"} with no signature must be refused.
    claims = {"sub": "admin-1", "user_metadata": {"role": "admin"}}

    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = _b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps(claims).encode())
    forged_token = f"{header}.{payload}."  # empty signature segment
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {forged_token}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_admin_missing_district_id_is_allowed_with_none():
    # district_id is optional at the claim level (the DB CHECK enforces it, not the guard) —
    # an admin token without it still authenticates; g.district_id is simply None.
    claims = {"sub": "admin-9", "user_metadata": {"role": "admin"}}
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    assert res.get_json()["district_id"] is None


def test_admin_non_string_district_id_is_coerced_to_none():
    # Defensive (code review 2026-07-09): a malformed claim (e.g. a list/number instead of a
    # string) must not flow unchecked into g.district_id.
    claims = {"sub": "admin-9", "user_metadata": {"role": "admin", "district_id": ["DIST-1"]}}
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {_token(claims)}"})
    assert res.status_code == 200
    assert res.get_json()["district_id"] is None


def test_admin_wrong_algorithm_token_is_rejected():
    # Ports require_officer()'s test_wrong_algorithm_token_is_rejected for require_admin()
    # (code review 2026-07-09) — a token signed with a different algorithm than our explicit
    # allow-list (HS256 only) must be rejected outright.
    claims = {"sub": "admin-1", "user_metadata": {"role": "admin"}}
    mismatched_token = jwt.encode(claims, SECRET, algorithm="HS384")
    client = _make_admin_app().test_client()
    res = client.get("/admin-protected", headers={"Authorization": f"Bearer {mismatched_token}"})
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"
