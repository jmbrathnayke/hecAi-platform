"""Six end-to-end scenarios against a real database (Story 7.4, AC7/AC8, RER-4).

SCOPE HONESTY — read before quoting these results in the dissertation. RER-7 asks for a >= 95%
offline SUBMISSION COMPLETION RATE under three network conditions. That rate is a property of
the PWA — the service worker, the IndexedDB `sync_queue`, and the exponential backoff in
frontend/lib/syncQueue.ts (Stories 4.1/4.4) — and it is measured by the frontend jest suite, not
here. A backend test client has no service worker and cannot go offline.

What this file evidences is the SERVER half: that when a client does retry, the server is
idempotent, creates no duplicates, and returns a stable canonical_id. That is a necessary
condition for RER-7, not the whole of it. Claiming otherwise would not survive a viva.
"""
import os

import pytest

from tests.scenarios.conftest import (
    OFFICER_SUB,
    SCENARIO_DISTRICT,
    auth,
    case_payload,
    make_token,
)

pytestmark = pytest.mark.skipif(
    not os.getenv("HEC_SCENARIO_DB_URL"),
    reason="scenario suite needs a real Postgres; set HEC_SCENARIO_DB_URL",
)


def _row(db, sql, params):
    with db.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


# --- Scenario 1: online submission ---------------------------------------------------------

def test_scenario_online_submission(client, tokens, db, new_offline_id):
    oid = new_offline_id()
    res = client.post("/api/v1/cases/submit", json=case_payload(oid),
                      headers=auth(tokens["citizen"]))

    assert res.status_code == 201, res.get_json()
    assert res.get_json()["canonical_id"].startswith("HEC-")

    case = _row(db, "SELECT id, status, district, locale FROM cases WHERE offline_id = %s", (oid,))
    assert case is not None
    assert case[1] == "Submitted"
    assert case[2] == SCENARIO_DISTRICT
    # Proves migration 021 is applied — the whole submit path 500s without the locale column.
    assert case[3] == "si"

    case_id = case[0]
    assert _row(db, "SELECT count(*) FROM compensation_estimates WHERE case_id = %s",
                (case_id,))[0] == 1
    assert _row(db, "SELECT count(*) FROM audit_log WHERE case_id = %s", (case_id,))[0] >= 1


# --- Scenario 2: offline -> sync -----------------------------------------------------------

def test_scenario_offline_then_sync(client, tokens, db, new_offline_id):
    """Officer attribution on sync is opt-in per item, which is easy to get wrong in both
    directions. A queued CITIZEN draft flushed from an officer's device is not an officer
    submission and must stay unattributed; only an item explicitly flagged
    submitted_by_officer picks up the officer id — and then from the verified JWT sub, never
    from the payload."""
    citizen_ids = [new_offline_id() for _ in range(2)]
    officer_id_case = new_offline_id()
    batch = [case_payload(i) for i in citizen_ids]
    batch.append(case_payload(officer_id_case, submitted_by_officer=True,
                              officer_id="ignored-from-body"))

    res = client.post("/api/v1/sync/batch", json={"cases": batch},
                      headers=auth(tokens["officer"]))
    assert res.status_code == 200, res.get_json()
    assert len(res.get_json()["results"]) == 3

    for oid in citizen_ids:
        row = _row(db, "SELECT canonical_id, officer_id FROM cases WHERE offline_id = %s", (oid,))
        assert row is not None and row[0].startswith("HEC-")
        assert row[1] is None, "an unflagged queued draft must not gain officer attribution"

    attributed = _row(db, "SELECT canonical_id, officer_id, submitted_by_officer "
                          "FROM cases WHERE offline_id = %s", (officer_id_case,))
    assert attributed[0].startswith("HEC-")
    assert attributed[1] == OFFICER_SUB, "officer_id must come from the JWT, not the body"
    assert attributed[2] is True


# --- Scenario 3 + AC8: intermittent connectivity -------------------------------------------

def test_scenario_intermittent_connectivity_is_idempotent(client, tokens, db, new_offline_id):
    """A dropped connection mid-batch looks, from the server's side, exactly like a retry of the
    same payload. Ten cycles because a single retry can pass by luck (e.g. a unique-violation
    that happens to be swallowed); a repeated one exposes state that accumulates."""
    ids = [new_offline_id() for _ in range(3)]
    payload = {"cases": [case_payload(i) for i in ids]}

    first = client.post("/api/v1/sync/batch", json=payload, headers=auth(tokens["officer"]))
    assert first.status_code == 200
    canonical_first = {
        oid: _row(db, "SELECT canonical_id FROM cases WHERE offline_id = %s", (oid,))[0]
        for oid in ids
    }

    for cycle in range(10):
        again = client.post("/api/v1/sync/batch", json=payload, headers=auth(tokens["officer"]))
        assert again.status_code == 200, f"cycle {cycle}: {again.get_json()}"

    for oid in ids:
        count = _row(db, "SELECT count(*) FROM cases WHERE offline_id = %s", (oid,))[0]
        assert count == 1, f"{oid} duplicated after retries"
        current = _row(db, "SELECT canonical_id FROM cases WHERE offline_id = %s", (oid,))[0]
        assert current == canonical_first[oid], "canonical_id changed across retries"

    # One estimate per case, not one per retry — compensation_estimates has a UNIQUE(case_id)
    # index, so a re-estimate on retry would have raised rather than silently duplicated.
    for oid in ids:
        case_id = _row(db, "SELECT id FROM cases WHERE offline_id = %s", (oid,))[0]
        assert _row(db, "SELECT count(*) FROM compensation_estimates WHERE case_id = %s",
                    (case_id,))[0] == 1


# --- Scenario 4: officer-assisted submission -----------------------------------------------

def test_scenario_officer_assisted_submission(client, tokens, db, new_offline_id):
    oid = new_offline_id()
    res = client.post(
        "/api/v1/cases/submit",
        json=case_payload(oid, submitted_by_officer=True, officer_id=OFFICER_SUB),
        headers=auth(tokens["officer"]),
    )
    assert res.status_code == 201, res.get_json()

    row = _row(db, "SELECT submitted_by_officer, officer_id FROM cases WHERE offline_id = %s",
               (oid,))
    assert row == (True, OFFICER_SUB)


def test_scenario_officer_assisted_rejects_a_mismatched_officer_id(client, tokens,
                                                                   new_offline_id):
    """Story 3.5's P4 fix: officer_id is never trusted from the body."""
    res = client.post(
        "/api/v1/cases/submit",
        json=case_payload(new_offline_id(), submitted_by_officer=True,
                          officer_id="somebody-else"),
        headers=auth(tokens["officer"]),
    )
    assert res.status_code == 403


# --- Scenario 5: AI override ---------------------------------------------------------------

def test_scenario_ai_override_is_logged_and_exported(client, tokens, db, new_offline_id):
    oid = new_offline_id()
    assert client.post("/api/v1/cases/submit", json=case_payload(oid),
                       headers=auth(tokens["citizen"])).status_code == 201

    res = client.post("/api/v1/inference/log", json={
        "offline_id": oid,
        "model_version": "scenario-1.0",
        "prediction": "crop_damage",
        "confidence": 0.61,
        "was_overridden": True,
        "override_category": "property_damage",
        "override_reason": "Officer inspected on site and reclassified the damage.",
    }, headers=auth(tokens["officer"]))
    assert res.status_code in (200, 201), res.get_json()

    case_id = _row(db, "SELECT id FROM cases WHERE offline_id = %s", (oid,))[0]
    logged = _row(db, "SELECT prediction, was_overridden, override_category "
                      "FROM inference_log WHERE case_id = %s", (case_id,))
    assert logged == ("crop_damage", True, "property_damage")

    export = client.get("/api/v1/research/export", headers=auth(tokens["researcher"]))
    assert export.status_code == 200, export.get_json()
    rows = export.get_json()
    matching = [r for r in rows if r["case_canonical_id"] and r["was_overridden"]]
    assert matching, "override row absent from the research export"
    # NFR-3.3 still holds on a real payload, not just the fake-DB fixture.
    assert "override_reason" not in rows[0]
    assert "officer_id" not in rows[0]


# --- Scenario 6: admin approve -------------------------------------------------------------

def test_scenario_admin_approve(client, tokens, db, new_offline_id):
    oid = new_offline_id()
    assert client.post("/api/v1/cases/submit", json=case_payload(oid),
                       headers=auth(tokens["citizen"])).status_code == 201

    case_id = _row(db, "SELECT id FROM cases WHERE offline_id = %s", (oid,))[0]
    estimate = _row(db, "SELECT amount_lkr FROM compensation_estimates WHERE case_id = %s",
                    (case_id,))[0]

    res = client.post(f"/api/v1/admin/cases/{oid}/action",
                      json={"action": "approve", "amount_lkr": float(estimate)},
                      headers=auth(tokens["admin"]))
    assert res.status_code == 200, res.get_json()

    row = _row(db, "SELECT status, approved_amount FROM cases WHERE id = %s", (case_id,))
    assert row[0] == "Approved"
    assert row[1] is not None

    assert _row(db, "SELECT count(*) FROM audit_log WHERE case_id = %s", (case_id,))[0] >= 2

    chain = client.get("/api/v1/admin/audit/verify-chain", headers=auth(tokens["admin"]))
    assert chain.status_code == 200
    assert chain.get_json()["valid"] is True


def test_admin_from_another_district_cannot_touch_the_case(client, tokens, new_offline_id):
    oid = new_offline_id()
    assert client.post("/api/v1/cases/submit", json=case_payload(oid),
                       headers=auth(tokens["citizen"])).status_code == 201

    other = make_token("scenario-admin-other", role="admin", district_id="පොළොන්නරුව")
    res = client.post(f"/api/v1/admin/cases/{oid}/action",
                      json={"action": "approve"}, headers=auth(other))
    assert res.status_code == 404  # 404 not 403 — district scoping must not confirm existence
