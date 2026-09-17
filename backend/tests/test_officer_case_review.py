"""Officer case review — the link from a citizen's report to the officer's on-device AI assessment.

What these tests pin down, in the order a real claim experiences it:

  * only an officer of the case's DS division (or its submitting officer) can see or act on it;
  * starting a review records the responsible officer and tells the citizen "Under Review" ONCE;
  * the assessment is recorded through inference_log (the existing research log), regenerates the
    AI-assisted estimate for THAT case, and is audited as decision support -- never a final amount;
  * the district administrator is alerted, and the citizen is told the verification is complete;
  * a case the administrator has already decided cannot be re-assessed beneath that decision.
"""
from datetime import datetime, timezone

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
GALNEWA = "ගල්නැව"
THALAWA = "තලාව"
ANURADHAPURA = "අනුරාධපුරය"
REF = "HEC-2026-0301"
OFFLINE = "4f1c1a5e-2b7e-4c3a-9d2e-0a1b2c3d4e5f"


def _token(sub="officer-1", role="officer", divisions=(GALNEWA,)):
    meta = {"role": role, "assigned_divisions": list(divisions)}
    return jwt.encode({"sub": sub, "app_metadata": meta}, SECRET, algorithm="HS256")


def _auth(**kw):
    return {"Authorization": f"Bearer {_token(**kw)}"}


CLASSIFICATION = {
    "model_version": "mobilenetv2-1",
    "prediction": "property_damage",
    "confidence": 0.91,
    "ai_severity": "Severe",
    "ai_processing_time_ms": 412,
}


class FakeCursor:
    """Follows the SQL the endpoints issue; anything unexpected fails the test loudly."""

    def __init__(self, store):
        self.store = store
        self._one = None
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _case_by_id(self, case_id):
        return next(c for c in self.store["cases"].values() if c["id"] == case_id)

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        self.store["sql"].append(s)
        if "pg_advisory_xact_lock" in s:
            self._one = (1,)
        elif s.startswith("SELECT hash FROM audit_log"):
            self._one = (self.store["audit"][-1]["hash"],) if self.store["audit"] else None
        elif s.startswith("INSERT INTO audit_log"):
            self.store["audit"].append({"case_id": params[0], "event": params[1],
                                        "actor_id": params[2], "metadata": params[3],
                                        "hash": params[5]})
        elif "FROM cases c LEFT JOIN households h" in s and "c.assigned_officer_id" in s:
            reference, officer_id, divisions = params
            c = self.store["cases"].get(reference)
            in_scope = c is not None and (
                c["officer_id"] == officer_id
                or (c["ds_division_id"] is not None and c["ds_division_id"] in divisions))
            self.store["locked"] = self.store.get("locked", 0) + ("FOR UPDATE OF c" in s)
            self._one = None if not in_scope else (
                c["id"], reference, OFFLINE, c["status"], c["damage_category"], 8.1, 80.2,
                datetime(2026, 9, 1, tzinfo=timezone.utc), None, "app",
                c.get("submitted_by_officer", False), c["district"], c["ds_division_id"],
                "HH-2026-0003", c.get("assigned_officer_id"), c.get("officer_review_started_at"),
                c.get("officer_assessed_at"), c.get("officer_assessed_by"), None,
            )
        elif s.startswith("UPDATE cases SET status = 'Under Review'"):
            case = self._case_by_id(params[-1])
            case["status"] = "Under Review"
            case["assigned_officer_id"] = case.get("assigned_officer_id") or params[0]
            case["officer_review_started_at"] = (case.get("officer_review_started_at")
                                                 or datetime(2026, 9, 2, tzinfo=timezone.utc))
            if "officer_assessed_at = now()" in s:
                case["officer_assessed_at"] = datetime(2026, 9, 2, 1, tzinfo=timezone.utc)
                case["officer_assessed_by"] = params[1]
        elif s.startswith("INSERT INTO inference_log"):
            self.store["inference"].append({"case_id": params[0], "model_type": params[1],
                                            "prediction": params[4], "confidence": params[5],
                                            "was_overridden": params[6],
                                            "override_category": params[8],
                                            "input_features": params[3]})
        elif s.startswith("SELECT prediction, confidence, was_overridden"):
            rows = [r for r in self.store["inference"] if r["case_id"] == params[0]]
            self._one = None if not rows else (
                rows[-1]["prediction"], rows[-1]["confidence"], rows[-1]["was_overridden"],
                rows[-1]["override_category"], "mobilenetv2-1", {"ai_severity": "Severe"},
                datetime(2026, 9, 2, tzinfo=timezone.utc))
        elif s.startswith("SELECT amount_lkr, raw_estimate_lkr, capped, model_version, created_at"):
            est = self.store["estimates"].get(params[0])
            self._one = None if est is None else (est, est, False, "rf_compensation_v2",
                                                  datetime(2026, 9, 2, tzinfo=timezone.utc))
        elif s.startswith("SELECT amount_lkr FROM compensation_estimates"):
            est = self.store["estimates"].get(params[0])
            self._one = None if est is None else (est,)
        elif s.startswith("SELECT event, created_at FROM audit_log"):
            self._rows = [(a["event"], datetime(2026, 9, 2, tzinfo=timezone.utc))
                          for a in reversed(self.store["audit"]) if a["case_id"] == params[0]]
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return FakeCursor(self.store)

    def close(self):
        pass


@pytest.fixture
def store():
    return {
        "cases": {
            REF: {"id": 301, "status": "Submitted", "damage_category": "property",
                  "district": ANURADHAPURA, "ds_division_id": GALNEWA, "officer_id": None},
            "HEC-2026-0302": {"id": 302, "status": "Submitted", "damage_category": "crop",
                              "district": ANURADHAPURA, "ds_division_id": THALAWA,
                              "officer_id": None},
            "HEC-2026-0303": {"id": 303, "status": "Approved", "damage_category": "property",
                              "district": ANURADHAPURA, "ds_division_id": GALNEWA,
                              "officer_id": None, "officer_assessed_at": datetime(2026, 9, 1)},
        },
        "estimates": {301: 100000.0},
        "inference": [],
        "audit": [],
        "sql": [],
        "citizen_notified": [],
        "staff_notified": [],
        "estimate_calls": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                      "SUPABASE_JWT_SECRET": SECRET})
    monkeypatch.setattr("app.api.v1.officer_cases._get_connection", lambda: FakeConn(store))
    monkeypatch.setattr(
        "app.api.v1.officer_cases.notify_status_change_all",
        lambda cur, case_id, ref, mobile, status, actor, amount_lkr=None:
            store["citizen_notified"].append({"case_id": case_id, "status": status,
                                              "actor": actor}))
    monkeypatch.setattr(
        "app.api.v1.officer_cases.notify_staff_push",
        lambda cur, case_id, alert, role, scope, ref, actor:
            store["staff_notified"].append({"alert": alert, "role": role, "scope": scope,
                                            "ref": ref}))

    def fake_estimate(cur, case_id, category, division, submitted_at, district=None,
                      ai_severity=None, replace=False):
        store["estimate_calls"].append({"case_id": case_id, "category": category,
                                        "ai_severity": ai_severity, "replace": replace,
                                        "district": district, "division": division})
        amount = 130000.0 if ai_severity == "Severe" else 100000.0
        store["estimates"][case_id] = amount
        return {"amount_lkr": amount, "raw_estimate_lkr": amount, "capped": False,
                "model_version": "rf_compensation_v2"}

    monkeypatch.setattr("app.infrastructure.ml.compensation.estimate_and_store", fake_estimate)
    return app.test_client()


def events(store, case_id=301):
    return [a["event"] for a in store["audit"] if a["case_id"] == case_id]


# ------------------------------------------------------------------------------ scope
def test_the_area_officer_sees_the_citizen_case(client, store):
    res = client.get(f"/api/v1/officer/cases/{REF}", headers=_auth())
    assert res.status_code == 200
    body = res.get_json()
    assert body["case"]["canonical_id"] == REF
    assert body["case"]["ds_division"] == GALNEWA
    assert body["case"]["household_ref"] == "HH-2026-0003"
    assert body["workflow"]["stage"] == "submitted"
    assert body["actions"] == {"can_start_review": True, "can_assess": True,
                               "already_assessed": False}
    assert events(store) == ["officer_viewed_case"]


def test_an_officer_of_another_division_gets_404_not_403(client):
    res = client.get("/api/v1/officer/cases/HEC-2026-0302", headers=_auth())
    assert res.status_code == 404


def _keys(value):
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def test_the_detail_carries_no_personal_data(client):
    body = client.get(f"/api/v1/officer/cases/{REF}", headers=_auth()).get_json()
    forbidden = {"citizen_mobile_plain", "submitter_identity_hash", "nic", "nic_hmac",
                 "citizen_nic_plain", "bank_details", "contact_email"}
    assert not (_keys(body) & forbidden)


@pytest.mark.parametrize("role", ["admin", "ds_officer", None])
def test_non_officers_are_refused(client, role):
    token = jwt.encode({"sub": "x", "app_metadata": {"role": role} if role else {}}, SECRET,
                       algorithm="HS256")
    res = client.get(f"/api/v1/officer/cases/{REF}", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 403


def test_a_malformed_reference_is_rejected_before_any_query(client, store):
    res = client.get("/api/v1/officer/cases/not-a-ref", headers=_auth())
    assert res.status_code == 400
    assert store["sql"] == []


# ------------------------------------------------------------------------------ start review
def test_starting_a_review_assigns_the_officer_and_tells_the_citizen_once(client, store):
    first = client.post(f"/api/v1/officer/cases/{REF}/start-review", headers=_auth())
    assert first.status_code == 200
    case = store["cases"][REF]
    assert case["status"] == "Under Review"
    assert case["assigned_officer_id"] == "officer-1"
    assert first.get_json()["workflow"]["stage"] == "officer_review"
    assert store["citizen_notified"] == [{"case_id": 301, "status": "Under Review",
                                          "actor": "officer-1"}]
    assert "officer_review_started" in events(store)
    assert store["locked"] >= 1, "the write path must lock the case row"

    # A second officer (same division) repeats the call: nothing changes, nobody is re-notified.
    again = client.post(f"/api/v1/officer/cases/{REF}/start-review",
                        headers=_auth(sub="officer-2"))
    assert again.status_code == 200
    assert case["assigned_officer_id"] == "officer-1", "responsibility is never silently moved"
    assert len(store["citizen_notified"]) == 1
    assert events(store).count("officer_review_started") == 1


def test_a_decided_case_cannot_be_reopened_for_review(client):
    res = client.post("/api/v1/officer/cases/HEC-2026-0303/start-review", headers=_auth())
    assert res.status_code == 409
    assert res.get_json()["error"] == "case_not_open"


# ------------------------------------------------------------------------------ assessment
def _assess(client, ref=REF, **overrides):
    body = {**CLASSIFICATION, **overrides}
    return client.post(f"/api/v1/officer/cases/{ref}/assessment", json=body, headers=_auth())


def test_the_assessment_is_recorded_through_inference_log_for_that_case(client, store):
    res = _assess(client)
    assert res.status_code == 200
    assert store["inference"][0]["case_id"] == 301
    assert store["inference"][0]["prediction"] == "property_damage"
    assert store["inference"][0]["model_type"] == "mobilenetv2"
    assert '"source": "officer_case_assessment"' in store["inference"][0]["input_features"]
    body = res.get_json()
    assert body["ai_result"]["prediction"] == "property_damage"
    assert body["workflow"]["stage"] == "officer_assessed"
    assert store["cases"][REF]["officer_assessed_by"] == "officer-1"


def test_the_estimate_is_regenerated_with_the_officer_severity_and_labelled_as_support(client,
                                                                                      store):
    body = _assess(client).get_json()
    assert store["estimate_calls"] == [{"case_id": 301, "category": "property",
                                        "ai_severity": "Severe", "replace": True,
                                        "district": ANURADHAPURA, "division": GALNEWA}]
    assert body["ai_assisted_estimate"]["amount_lkr"] == 130000.0
    assert body["ai_assisted_estimate"]["is_final_decision"] is False
    generated = next(a for a in store["audit"] if a["event"] == "compensation_estimate_generated")
    assert '"decision_support_only": true' in generated["metadata"]
    assert '"previous_amount_lkr": 100000.0' in generated["metadata"]


def test_an_override_prices_the_officer_class_not_the_model_class(client, store):
    _assess(client, prediction="property_damage", was_overridden=True,
            override_category="crop_damage", override_reason="Paddy field trampled, not a house.")
    assert store["estimate_calls"][0]["category"] == "crop"
    assert store["inference"][0]["was_overridden"] is True


def test_no_damage_does_not_regenerate_an_estimate_but_records_why(client, store):
    _assess(client, prediction="no_damage", ai_severity="None")
    assert store["estimate_calls"] == []
    assert "compensation_estimate_not_regenerated" in events(store)


def test_the_administrator_is_alerted_and_the_citizen_told_on_first_assessment(client, store):
    _assess(client)
    assert store["staff_notified"] == [{"alert": "assessment_complete", "role": "admin",
                                        "scope": ANURADHAPURA, "ref": REF}]
    assert [n["status"] for n in store["citizen_notified"]] == ["Assessment Complete"]

    # A reassessment re-alerts the administrator (the estimate may have changed) but not the family.
    _assess(client, ai_severity="Moderate")
    assert len(store["staff_notified"]) == 2
    assert [n["status"] for n in store["citizen_notified"]] == ["Assessment Complete"]
    recorded = [a for a in store["audit"] if a["event"] == "officer_assessment_recorded"]
    assert '"reassessment": true' in recorded[-1]["metadata"]


def test_an_assessment_on_a_submitted_case_also_records_the_review_start(client, store):
    _assess(client)
    assert events(store).index("officer_review_started") < events(store).index(
        "officer_assessment_recorded")


def test_every_workflow_transition_is_audited(client, store):
    client.post(f"/api/v1/officer/cases/{REF}/start-review", headers=_auth())
    _assess(client)
    assert {"officer_review_started", "officer_assessment_recorded",
            "compensation_estimate_generated"} <= set(events(store))


def test_a_decided_case_cannot_be_reassessed(client, store):
    res = _assess(client, ref="HEC-2026-0303")
    assert res.status_code == 409
    assert store["inference"] == []


def test_an_out_of_scope_case_cannot_be_assessed(client, store):
    res = _assess(client, ref="HEC-2026-0302")
    assert res.status_code == 404
    assert store["inference"] == []


@pytest.mark.parametrize("override,error", [
    ({"prediction": "elephant"}, "invalid_prediction"),
    ({"confidence": 1.5}, "invalid_confidence"),
    ({"ai_severity": "Catastrophic"}, "invalid_ai_severity"),
    ({"was_overridden": True, "override_category": "crop_damage", "override_reason": "short"},
     "override_reason_too_short"),
    ({"ai_processing_time_ms": -1}, "invalid_processing_time"),
])
def test_invalid_assessments_are_rejected_without_writing(client, store, override, error):
    res = _assess(client, **override)
    assert res.status_code == 400
    assert res.get_json()["error"] == error
    assert store["inference"] == [] and store["audit"] == []
