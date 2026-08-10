"""Tests for GET /api/v1/research/export (Story 7.3, FR-7.3, NFR-3.3, RER-2/3/6).

DB faked (no Postgres), same FakeConn/FakeCursor style as test_admin_export.py, scoped to this
endpoint's own three queries: the COUNT for the audit row, the export SELECT, and the audit_log
INSERT.

KEY DIFFERENCE FROM test_admin_export.py, and the reason this file exists separately:
the admin export collapses inference_log's append-only fan-out to ONE row per case (LATERAL
+ LIMIT 1), and its tests assert that collapse. The research export deliberately does the
OPPOSITE -- every inference row is its own research record, because an AI prediction and the
officer override that corrected it are two distinct data points for RER-2/NFR-6.3. The
fan-out test below is what catches someone copy-pasting admin.py's LATERAL block into here.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
import psycopg2
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"  # >=32 bytes for HS256

DISTRICT_A = "අනුරාධපුරය"
DISTRICT_B = "කොළඹ"
DIVISION_A = "ඉපලෝගම"

# Every field name that must NEVER appear in a research export (AC2/NFR-3.3), asserted against
# the real serialized JSON body rather than trusted by inspection.
#
# `input_features` and `override_reason` are the two that a naive column-name PII review misses:
# inference_log.input_features is JSONB literally containing officer_id (see inference.py), and
# override_reason is officer-typed free text that can contain anything at all.
PII_FIELDS = (
    "nic",
    "citizen_nic_plain",
    "submitter_identity_hash",
    "citizen_mobile_plain",
    "mobile",
    "gps_lat",
    "gps_lng",
    "officer_id",
    "citizen_id",
    "input_features",
    "override_reason",
)

# The subset of PII_FIELDS safe to grep for as raw substrings of the serialized body. The short
# tokens are excluded on purpose: "nic" is a substring of "case_ca(nic)al_id" and "mobile" would
# match any future "mobilenetv2" model_type value, so a body-wide substring scan for them fails
# on legitimate output. Those are covered by the exact-key assertion instead.
PII_SUBSTRINGS = tuple(f for f in PII_FIELDS if f not in ("nic", "mobile"))

# The complete, intended key set (AC1). Asserting equality — not just absence of known-bad names
# — is what catches a PII column added to the SELECT under a name nobody thought to blocklist.
EXPECTED_KEYS = {
    "inference_log_id",
    "case_canonical_id",
    "model_type",
    "model_version",
    "prediction",
    "confidence",
    "was_overridden",
    "override_category",
    "ground_truth",
    "damage_category",
    "district",
    "ds_division_id",
    "compensation_estimate_lkr",
    "approved_amount",
    "created_at",
}


def _token(sub="researcher-1", role="system_admin", exp_delta=None):
    claims: dict[str, Any] = {"sub": sub, "user_metadata": {"role": role}}
    if role is None:
        claims["user_metadata"] = {}
    if exp_delta is not None:
        claims["exp"] = datetime.now(timezone.utc) + exp_delta
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


def _case(
    id_,
    district=DISTRICT_A,
    canonical_id=None,
    damage_category="property",
    approved_amount=None,
    ds_division_id=None,
):
    return {
        "id": id_,
        "canonical_id": canonical_id or f"HEC-2026-{id_:04d}",
        "district": district,
        "damage_category": damage_category,
        "approved_amount": approved_amount,
        "ds_division_id": ds_division_id,
    }


def _inference(
    id_,
    case_id,
    model_type="mobilenetv2",
    model_version="1.0.0",
    prediction="property_damage",
    confidence=0.9,
    was_overridden=False,
    override_category=None,
    ground_truth=None,
    created_at=None,
):
    return {
        "id": id_,
        "case_id": case_id,
        "model_type": model_type,
        "model_version": model_version,
        "prediction": prediction,
        "confidence": confidence,
        "was_overridden": was_overridden,
        "override_category": override_category,
        "ground_truth": ground_truth,
        "created_at": created_at or datetime(2026, 7, 8, 10, 0, 0, tzinfo=timezone.utc),
    }


def _estimate(case_id, amount_lkr):
    return {"case_id": case_id, "amount_lkr": amount_lkr}


class FakeCursor:
    def __init__(self, store, name=None):
        self.store = store
        self.name = name
        self.itersize = None
        self._rows = []
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _case_for(self, case_id):
        for c in self.store["cases"]:
            if c["id"] == case_id:
                return c
        return None

    def _estimate_for(self, case_id):
        for e in self.store["compensation_estimates"]:
            if e["case_id"] == case_id:
                return e
        return None

    def _joined(self):
        """INNER JOIN inference_log -> cases, LEFT JOIN compensation_estimates, ORDER BY il.id.

        The harness READS THE SQL to decide whether to collapse the fan-out, the same way
        test_admin_export.py's _matching() consumes the WHERE text. Without this the fake would
        return one row per inference_log entry no matter what the real query said, and
        test_inference_fan_out_is_preserved_not_collapsed would be asserting a property of this
        test file rather than of admin-style LATERAL creeping into research.py. Verified: adding
        a LATERAL to _RESEARCH_SELECT makes that test fail.
        """
        log = self.store["inference_log"]
        if "LATERAL" in self._sql.upper():
            latest = {}
            for il in sorted(log, key=lambda r: (r["created_at"], r["id"])):
                latest[il["case_id"]] = il
            log = list(latest.values())

        out = []
        for il in sorted(log, key=lambda r: r["id"]):
            c = self._case_for(il["case_id"])
            if c is None:  # inner join drops orphans
                continue
            ce = self._estimate_for(c["id"])
            out.append(
                (
                    il["id"],
                    c["canonical_id"],
                    il["model_type"],
                    il["model_version"],
                    il["prediction"],
                    il["confidence"],
                    il["was_overridden"],
                    il["override_category"],
                    il["ground_truth"],
                    c["damage_category"],
                    c["district"],
                    c["ds_division_id"],
                    ce["amount_lkr"] if ce else None,
                    c["approved_amount"],
                    il["created_at"],
                )
            )
        return out

    def execute(self, sql: str, params: tuple[Any, ...] = ()):
        self._sql = sql
        if "pg_advisory_xact_lock" in sql:
            self._result = None
        elif sql.startswith("SELECT COUNT(*)") and "inference_log" in sql:
            self._result = (len(self._joined()),)
        elif "SELECT il.id, c.canonical_id, il.model_type" in sql:
            limit = params[0]
            self._rows = self._joined()[:limit]
        elif "INSERT INTO audit_log" in sql:
            case_id, event, actor_id, metadata, created_at, hash_, prev_hash = params
            self.store["audit"].append(
                {
                    "id": len(self.store["audit"]) + 1,
                    "case_id": case_id,
                    "event": event,
                    "actor_id": actor_id,
                    "metadata": json.loads(metadata) if metadata is not None else None,
                    "created_at": created_at,
                    "hash": hash_,
                    "prev_hash": prev_hash,
                }
            )
        elif "SELECT hash FROM audit_log" in sql:
            self._result = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._result

    def close(self):
        pass


class FakeConn:
    def __init__(self, store):
        self.store = store
        self.commits = 0
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self, name=None):
        return FakeCursor(self.store, name=name)

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


@pytest.fixture
def store():
    return {
        "cases": [
            _case(1, ds_division_id=DIVISION_A),
            _case(2, district=DISTRICT_B, damage_category="crop", approved_amount=45000.0),
            _case(3),  # no inference rows -> must not appear (inner join)
        ],
        "inference_log": [
            _inference(10, 1, confidence=0.55, prediction="crop_damage"),
            # Same case, later row: the officer override. BOTH must survive the export.
            _inference(
                11, 1, confidence=0.91, prediction="crop_damage", was_overridden=True,
                override_category="property_damage",
                created_at=datetime(2026, 7, 8, 10, 0, 0, tzinfo=timezone.utc),
            ),
            _inference(12, 2, model_type="random_forest", prediction="property_damage"),
        ],
        "compensation_estimates": [_estimate(1, 125000.0)],
        "audit": [],
    }


@pytest.fixture
def conn(store):
    return FakeConn(store)


@pytest.fixture
def client(monkeypatch, conn):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )
    monkeypatch.setattr("app.api.v1.research._get_connection", lambda: conn)
    return app.test_client()


# --- AC3: authorization -------------------------------------------------------------------


def test_missing_token_401(client):
    assert client.get("/api/v1/research/export").status_code == 401


def test_malformed_token_401(client):
    res = client.get(
        "/api/v1/research/export", headers={"Authorization": "Bearer not-a-jwt"}
    )
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


def test_expired_token_401(client):
    res = client.get(
        "/api/v1/research/export", headers=_auth(exp_delta=timedelta(hours=-1))
    )
    assert res.status_code == 401
    assert res.get_json()["error"] == "token_expired"


def test_token_without_sub_401(client):
    token = jwt.encode(
        {"user_metadata": {"role": "system_admin"}}, SECRET, algorithm="HS256"
    )
    res = client.get(
        "/api/v1/research/export", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 401
    assert res.get_json()["error"] == "invalid_token"


@pytest.mark.parametrize("role", ["officer", "admin", None])
def test_non_system_admin_403(client, role):
    """An officer, a district admin, and a plain citizen are each rejected (AC3).

    `admin` matters most: the district-admin token that CAN call /admin/export must not
    reach the research corpus, which is deliberately un-scoped by district.
    """
    res = client.get("/api/v1/research/export", headers=_auth(role=role))
    assert res.status_code == 403
    assert res.get_json()["error"] == "forbidden"


def test_server_misconfigured_500_when_secret_absent(monkeypatch, conn):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake"})
    monkeypatch.setattr("app.api.v1.research._get_connection", lambda: conn)
    res = app.test_client().get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_misconfigured"


# --- AC1: shape ---------------------------------------------------------------------------


def test_export_returns_expected_contract(client):
    res = client.get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 200
    rows = res.get_json()
    assert isinstance(rows, list)

    first = rows[0]
    assert set(first) == {
        "inference_log_id",
        "case_canonical_id",
        "model_type",
        "model_version",
        "prediction",
        "confidence",
        "was_overridden",
        "override_category",
        "ground_truth",
        "damage_category",
        "district",
        "ds_division_id",
        "compensation_estimate_lkr",
        "approved_amount",
        "created_at",
    }


def test_inference_fan_out_is_preserved_not_collapsed(client):
    """Case 1 has TWO inference rows (AI result + officer override) -> TWO export rows.

    This is the exact inverse of test_admin_export.py's dedup assertion, and it is the
    regression guard against reusing admin.py's LEFT JOIN LATERAL ... LIMIT 1 here. Under
    that (wrong) query this test sees 1 row for case 1 and fails.
    """
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    case1 = [r for r in rows if r["case_canonical_id"] == "HEC-2026-0001"]
    assert len(case1) == 2
    assert {r["inference_log_id"] for r in case1} == {10, 11}
    assert [r["was_overridden"] for r in sorted(case1, key=lambda r: r["inference_log_id"])] == [
        False,
        True,
    ]


def test_case_without_inference_rows_is_absent(client):
    """Case 3 has no inference_log row -> inner JOIN drops it (nothing to research)."""
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert all(r["case_canonical_id"] != "HEC-2026-0003" for r in rows)


def test_missing_compensation_estimate_is_null_not_zero(client):
    """Case 2 has no compensation_estimates row.

    Must serialize as null, never 0.0 -- a fabricated zero would be silently absorbed into a
    dissertation MAE calculation as a real prediction of "no payout".
    """
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    case2 = [r for r in rows if r["case_canonical_id"] == "HEC-2026-0002"][0]
    assert case2["compensation_estimate_lkr"] is None


def test_model_type_distinguishes_classifier_from_regressor(client):
    """inference_log holds BOTH mobilenetv2 and random_forest rows.

    Without model_type in the payload a consumer computing classification metrics would
    silently fold RF rows into the confusion matrix.
    """
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert {r["model_type"] for r in rows} == {"mobilenetv2", "random_forest"}


def test_not_district_scoped(client):
    """Unlike /admin/export, research spans every district (cases 1 and 2 differ)."""
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert {r["district"] for r in rows} == {DISTRICT_A, DISTRICT_B}


def test_created_at_is_offset_free_utc(client):
    """Story 7.2's live run: "+00:00" suffixes break downstream spreadsheet/pandas parsing."""
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert all("+" not in r["created_at"] for r in rows)
    assert rows[0]["created_at"] == "2026-07-08 10:00:00"


def test_confidence_is_json_number_not_decimal_string(client):
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert isinstance(rows[0]["confidence"], float)


# --- AC2: no PII --------------------------------------------------------------------------


def test_no_pii_keys_in_payload(client):
    """No row may carry a PII key, checked as an EXACT key match.

    Exact-match rather than substring: `case_canonical_id` legitimately contains "nic", so a
    naive body-wide scan for that token fails on correct output.
    """
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    assert rows
    for row in rows:
        leaked = set(row) & set(PII_FIELDS)
        assert not leaked, f"PII keys leaked into research export: {leaked}"


def test_payload_keys_are_exactly_the_declared_contract(client):
    """Equality, not just absence of blocklisted names.

    A blocklist only catches PII someone remembered to name; asserting the key set is EXACTLY
    the AC1 contract also catches a column added to the SELECT under a name nobody blocklisted.
    """
    rows = client.get("/api/v1/research/export", headers=_auth()).get_json()
    for row in rows:
        assert set(row) == EXPECTED_KEYS


def test_no_pii_substrings_anywhere_in_body(client):
    """Values too, not only keys — catches PII smuggled inside a nested/serialized value."""
    body = client.get("/api/v1/research/export", headers=_auth()).get_data(as_text=True)
    lowered = body.lower()
    for field in PII_SUBSTRINGS:
        assert field not in lowered, f"PII field {field!r} leaked into research export"


# --- audit --------------------------------------------------------------------------------


def test_audit_row_written_before_body(client, store):
    res = client.get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 200
    assert len(store["audit"]) == 1
    entry = store["audit"][0]
    assert entry["event"] == "research_exported_data"
    assert entry["actor_id"] == "researcher-1"
    assert entry["metadata"]["row_count_at_audit"] == 3
    assert entry["metadata"]["truncated"] is False


def test_forbidden_request_writes_no_audit_row(client, store):
    client.get("/api/v1/research/export", headers=_auth(role="admin"))
    assert store["audit"] == []


def test_truncation_headers_and_cap(client, monkeypatch, store):
    monkeypatch.setattr("app.api.v1.research.RESEARCH_MAX_ROWS", 2)
    res = client.get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 200
    assert len(res.get_json()) == 2
    assert res.headers["X-HEC-Truncated"] == "true"
    assert res.headers["X-HEC-Row-Count"] == "2"
    assert store["audit"][0]["metadata"]["truncated"] is True
    assert store["audit"][0]["metadata"]["matched_count"] == 3


def test_untruncated_export_reports_false(client):
    res = client.get("/api/v1/research/export", headers=_auth())
    assert res.headers["X-HEC-Truncated"] == "false"
    assert res.headers["X-HEC-Row-Count"] == "3"


# --- failure paths ------------------------------------------------------------------------


def test_connection_failure_returns_500(monkeypatch):
    app = create_app(
        {"TESTING": True, "DATABASE_URL": "postgresql://fake", "SUPABASE_JWT_SECRET": SECRET}
    )

    def _boom():
        raise psycopg2.OperationalError("no route to host")

    monkeypatch.setattr("app.api.v1.research._get_connection", _boom)
    res = app.test_client().get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_error"


def test_query_failure_returns_500_and_closes_connection(client, monkeypatch, conn):
    """A failure AFTER the audit row must still be a clean 500, not a partial 200 body."""
    original = FakeCursor.execute

    def _fail_on_export(self, sql, params=()):
        if "SELECT il.id, c.canonical_id, il.model_type" in sql:
            raise psycopg2.OperationalError("connection lost")
        return original(self, sql, params)

    monkeypatch.setattr(FakeCursor, "execute", _fail_on_export)
    res = client.get("/api/v1/research/export", headers=_auth())
    assert res.status_code == 500
    assert res.get_json()["error"] == "server_error"
    assert conn.closed is True


def test_connection_closed_on_success(client, conn):
    client.get("/api/v1/research/export", headers=_auth())
    assert conn.closed is True


def test_head_request_does_not_leak_the_connection(client, conn):
    """Flask auto-registers HEAD for every GET route.

    Story 7.2's review found this leaked a DB connection per request in its streaming CSV path:
    Python does not run a generator's finally when it is closed before ever being advanced, and
    Werkzeug does exactly that for HEAD. This route buffers instead of streaming and closes the
    connection in a finally before the Response is built, so HEAD is safe by construction --
    this test locks that property in rather than assuming it.
    """
    res = client.head("/api/v1/research/export", headers=_auth())
    assert res.status_code == 200
    assert conn.closed is True
