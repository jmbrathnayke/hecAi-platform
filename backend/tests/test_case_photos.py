"""Case evidence photographs (migration 038) — who may add one, and who may see one.

The point of this endpoint is that a compensation decision can be shown. The point of these tests
is that showing it never widens who can see a family's damaged home: the photographs of a case are
visible to exactly the people the case itself is visible to, and to nobody else.

The object store is faked (no network in CI) and the DB is faked (no Postgres in CI), so what is
exercised here is the authorisation, the source labelling, the duplicate handling and the audit
trail -- not Supabase's behaviour, which is verified separately by a live round-trip.
"""
import io
from datetime import datetime, timezone

import jwt
import pytest

from app import create_app

SECRET = "test-jwt-secret-0123456789-abcdef-ghij"
GALNEWA = "ගල්නැව"
THALAWA = "තලාව"
ANURADHAPURA = "අනුරාධපුරය"
POLONNARUWA = "පොළොන්නරුව"

REF = "HEC-2026-0301"          # Galnewa, Anuradhapura, household HH-1 (citizen-1)
OTHER_REF = "HEC-2026-0302"    # Thalawa, Anuradhapura, household HH-2
OFFLINE = "4f1c1a5e-2b7e-4c3a-9d2e-0a1b2c3d4e5f"   # REF's offline id

JPEG = b"\xff\xd8\xff\xe0" + b"fake jpeg bytes" * 4


def _token(sub, role=None, **meta):
    app_metadata = dict(meta)
    if role:
        app_metadata["role"] = role
    return jwt.encode({"sub": sub, "app_metadata": app_metadata}, SECRET, algorithm="HS256")


def _auth(sub, role=None, **meta):
    return {"Authorization": f"Bearer {_token(sub, role, **meta)}"}


def _officer(divisions=(GALNEWA,), sub="officer-1"):
    return _auth(sub, "officer", assigned_divisions=list(divisions))


def _admin(district=ANURADHAPURA):
    return _auth("admin-1", "admin", district_id=district)


def _ds(division=GALNEWA):
    return _auth("ds-1", "ds_officer", ds_division=division)


def _citizen(sub="citizen-1"):
    return _auth(sub)


def _upload(client, ref, headers, data=JPEG, content_type="image/jpeg", filename="a.jpg"):
    return client.post(
        f"/api/v1/cases/{ref}/photos",
        data={"photo": (io.BytesIO(data), filename, content_type)},
        content_type="multipart/form-data",
        headers=headers,
    )


class FakeCursor:
    """Follows the SQL these endpoints issue; anything unexpected fails the test loudly."""

    def __init__(self, store):
        self.store = store
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        self.store["sql"].append(s)

        if "pg_advisory_xact_lock" in s:
            self._rows = [(None,)]       # the hash-chain serialisation write_audit_log takes
        elif s.startswith("SELECT hash FROM audit_log"):
            self._rows = [(a["hash"],) for a in self.store["audit"][-1:]]
        elif s.startswith("SELECT c.id FROM cases c"):
            self._rows = [(c["id"],) for c in self.store["cases"].values()
                          if self._case_visible(c, s, params)]
        elif "FROM case_photos WHERE case_id = %s ORDER BY id" in s:
            self._rows = [(p["id"], p["source"], p["storage_path"], p["content_type"],
                           p["byte_size"], p["created_at"])
                          for p in self.store["photos"] if p["case_id"] == params[0]]
        elif s.startswith("SELECT id FROM case_photos WHERE case_id = %s AND sha256"):
            self._rows = [(p["id"],) for p in self.store["photos"]
                          if p["case_id"] == params[0] and p["sha256"] == params[1]]
        elif s.startswith("SELECT count(*) FROM case_photos"):
            self._rows = [(sum(1 for p in self.store["photos"]
                               if p["case_id"] == params[0] and p["source"] == params[1]),)]
        elif s.startswith("INSERT INTO case_photos"):
            case_id, source, path, ctype, size, digest, uploader = params
            if any(p["case_id"] == case_id and p["sha256"] == digest for p in self.store["photos"]):
                self._rows = []          # ON CONFLICT DO NOTHING
            else:
                new_id = len(self.store["photos"]) + 1
                self.store["photos"].append({
                    "id": new_id, "case_id": case_id, "source": source, "storage_path": path,
                    "content_type": ctype, "byte_size": size, "sha256": digest,
                    "uploaded_by": uploader, "created_at": datetime(2026, 9, 28, tzinfo=timezone.utc),
                })
                self._rows = [(new_id,)]
        elif "INSERT INTO audit_log" in s:
            self.store["audit"].append({"case_id": params[0], "event": params[1],
                                        "actor": params[2], "metadata": params[3],
                                        "hash": params[5]})
            self._rows = [(1,)]
        else:
            raise AssertionError(f"unexpected SQL: {s}")

    def _case_visible(self, case, sql, params):
        ref = params[0]
        if case["canonical_id"] != ref and case["offline_id"] != ref:
            return False
        if "c.citizen_id = %s" in sql:
            # The household link is households.registrant_uid (migration 025). Named here as the
            # real column because a fake that accepted any name is exactly what let an
            # UndefinedColumn reach the live database with every test green.
            assert "h.registrant_uid = %s" in sql, "citizen scope must join households on registrant_uid"
            subject = params[1]
            return case["citizen_id"] == subject or case["household_registrant"] == subject
        column = "district" if "district = ANY" in sql else "ds_division_id"
        scope = params[1]
        in_scope = case[column] is not None and case[column] in scope
        if "c.officer_id = %s" in sql:
            return in_scope or case["officer_id"] == params[2]
        return in_scope

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConn:
    def __init__(self, store):
        self.store = store

    def cursor(self):
        return FakeCursor(self.store)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass


@pytest.fixture
def store():
    return {
        "cases": {
            REF: {"id": 301, "canonical_id": REF, "offline_id": OFFLINE,
                  "district": ANURADHAPURA, "ds_division_id": GALNEWA,
                  "officer_id": None, "citizen_id": "citizen-1", "household_registrant": "citizen-1"},
            OTHER_REF: {"id": 302, "canonical_id": OTHER_REF,
                        "offline_id": "11111111-1111-4111-8111-111111111111",
                        "district": ANURADHAPURA, "ds_division_id": THALAWA,
                        "officer_id": None, "citizen_id": "citizen-2",
                        "household_registrant": "citizen-2"},
        },
        "photos": [],
        "audit": [],
        "sql": [],
        "uploaded": [],
        "signed": [],
    }


@pytest.fixture
def client(monkeypatch, store):
    app = create_app({"TESTING": True, "DATABASE_URL": "postgresql://fake",
                      "SUPABASE_JWT_SECRET": SECRET})
    monkeypatch.setattr("app.api.v1.case_photos._get_connection", lambda: FakeConn(store))
    monkeypatch.setattr("app.api.v1.case_photos.photo_store.is_configured", lambda: True)

    def fake_upload(path, data, content_type):
        store["uploaded"].append({"path": path, "bytes": len(data), "content_type": content_type})
        return True

    def fake_sign_many(paths):
        store["signed"].append(list(paths))
        return {p: f"https://storage.example/signed/{p}?token=x" for p in paths}

    monkeypatch.setattr("app.api.v1.case_photos.photo_store.upload", fake_upload)
    monkeypatch.setattr("app.api.v1.case_photos.photo_store.sign_many", fake_sign_many)
    return app.test_client()


def events(store, case_id=301):
    return [a["event"] for a in store["audit"] if a["case_id"] == case_id]


# --- uploading -------------------------------------------------------------

def test_a_citizen_adds_their_own_photo_and_it_is_labelled_citizen(client, store):
    res = _upload(client, REF, _citizen())
    assert res.status_code == 201
    assert res.get_json()["source"] == "citizen"
    assert store["photos"][0]["case_id"] == 301
    assert store["uploaded"][0]["path"].startswith("301/citizen/")
    assert "case_photo_uploaded" in events(store)


def test_a_citizen_may_upload_by_the_offline_id_their_draft_still_holds(client, store):
    # The upload happens immediately after the case syncs, when the browser has the offline id it
    # minted and may not yet have stored the canonical one.
    assert _upload(client, OFFLINE, _citizen()).status_code == 201
    assert store["photos"][0]["case_id"] == 301


def test_an_officer_in_the_division_adds_a_photo_labelled_officer(client, store):
    res = _upload(client, REF, _officer())
    assert res.status_code == 201
    assert res.get_json()["source"] == "officer"
    assert store["uploaded"][0]["path"].startswith("301/officer/")


def test_neither_side_can_write_the_other_s_label(client, store):
    # The source is derived from the verified role, never from the request. It is what tells the
    # administrator whether they are looking at the claimant's account or the officer's
    # verification, so a client that could choose it could forge corroboration.
    _upload(client, REF, _citizen())
    _upload(client, REF, _officer(), data=JPEG + b"different")
    assert [p["source"] for p in store["photos"]] == ["citizen", "officer"]


def test_a_citizen_cannot_upload_to_another_household_s_case(client, store):
    assert _upload(client, OTHER_REF, _citizen("citizen-1")).status_code == 404
    assert store["photos"] == []


def test_an_officer_outside_the_division_cannot_upload(client, store):
    assert _upload(client, REF, _officer(divisions=(THALAWA,))).status_code == 404
    assert store["uploaded"] == []


def test_the_submitting_officer_reaches_their_own_case_outside_their_divisions(client, store):
    # An officer-assisted submission must stay workable if the officer is later reassigned.
    store["cases"][REF]["officer_id"] = "officer-9"
    res = _upload(client, REF, _officer(divisions=(THALAWA,), sub="officer-9"))
    assert res.status_code == 201


def test_an_administrator_may_read_but_never_upload(client, store):
    # They decide on evidence; they do not produce it. 403, not 404: they can see the case.
    assert _upload(client, REF, _admin()).status_code == 403
    assert store["uploaded"] == []


def test_a_ds_officer_may_read_but_never_upload(client, store):
    assert _upload(client, REF, _ds()).status_code == 403


def test_a_system_admin_reaches_no_case_at_all(client, store):
    assert _upload(client, REF, _auth("sys-1", "system_admin")).status_code == 404
    assert client.get(f"/api/v1/cases/{REF}/photos",
                      headers=_auth("sys-1", "system_admin")).status_code == 404


def test_an_unauthenticated_upload_is_401(client, store):
    assert _upload(client, REF, {}).status_code == 401


# --- what may be uploaded --------------------------------------------------

def test_a_non_image_is_refused_by_type(client, store):
    res = _upload(client, REF, _citizen(), data=b"<svg onload=alert(1)>",
                  content_type="image/svg+xml", filename="x.svg")
    assert res.status_code == 415
    assert store["uploaded"] == []


def test_an_empty_body_is_refused(client, store):
    assert client.post(f"/api/v1/cases/{REF}/photos", data={},
                       content_type="multipart/form-data",
                       headers=_citizen()).status_code == 400


def test_an_oversized_photo_is_refused_before_it_reaches_storage(client, store):
    from app.infrastructure.storage import photo_store
    res = _upload(client, REF, _citizen(), data=b"x" * (photo_store.MAX_BYTES + 1))
    assert res.status_code == 413
    assert store["uploaded"] == []


def test_the_per_source_limit_is_enforced(client, store):
    from app.infrastructure.storage import photo_store
    for i in range(photo_store.MAX_PHOTOS_PER_SOURCE):
        assert _upload(client, REF, _citizen(), data=JPEG + bytes([i])).status_code == 201
    res = _upload(client, REF, _citizen(), data=JPEG + b"one too many")
    assert res.status_code == 409
    assert res.get_json()["error"] == "too_many_photos"
    # The officer's allowance is separate: a full citizen gallery must not block verification.
    assert _upload(client, REF, _officer(), data=JPEG + b"officer").status_code == 201


def test_a_retried_upload_of_the_same_bytes_is_absorbed(client, store):
    # The upload path retries offline. A retry that the server already stored must be a no-op,
    # not a second tile in the administrator's gallery.
    first = _upload(client, REF, _citizen())
    again = _upload(client, REF, _citizen())
    assert first.status_code == 201
    assert again.status_code == 200 and again.get_json()["duplicate"] is True
    assert len(store["photos"]) == 1
    assert len(store["uploaded"]) == 1, "storage is not touched by a known duplicate"


def test_no_row_is_written_when_storage_refuses(client, store, monkeypatch):
    # A row pointing at an object that was never stored is a permanently broken tile that also
    # counts towards the per-case limit.
    monkeypatch.setattr("app.api.v1.case_photos.photo_store.upload", lambda *a: False)
    res = _upload(client, REF, _citizen())
    assert res.status_code == 502
    assert store["photos"] == []


def test_an_unconfigured_deployment_says_so_instead_of_failing(client, store, monkeypatch):
    monkeypatch.setattr("app.api.v1.case_photos.photo_store.is_configured", lambda: False)
    res = _upload(client, REF, _citizen())
    assert res.status_code == 503
    assert res.get_json()["error"] == "storage_not_configured"


# --- reading ---------------------------------------------------------------

def _seed_two(client):
    _upload(client, REF, _citizen())
    _upload(client, REF, _officer(), data=JPEG + b"officer")


def test_everyone_with_the_case_in_scope_sees_both_sources_with_signed_urls(client, store):
    _seed_two(client)
    for headers in (_citizen(), _officer(), _admin(), _ds()):
        body = client.get(f"/api/v1/cases/{REF}/photos", headers=headers).get_json()
        assert [p["source"] for p in body["photos"]] == ["citizen", "officer"]
        assert all(p["url"].startswith("https://storage.example/signed/") for p in body["photos"])


def test_a_storage_path_is_never_returned_to_the_client(client, store):
    _seed_two(client)
    body = client.get(f"/api/v1/cases/{REF}/photos", headers=_admin()).get_json()
    assert all("storage_path" not in p for p in body["photos"])


def test_an_administrator_of_another_district_sees_nothing(client, store):
    _seed_two(client)
    res = client.get(f"/api/v1/cases/{REF}/photos", headers=_admin(district=POLONNARUWA))
    assert res.status_code == 404


def test_a_ds_officer_of_another_division_sees_nothing(client, store):
    _seed_two(client)
    assert client.get(f"/api/v1/cases/{REF}/photos", headers=_ds(THALAWA)).status_code == 404


def test_a_citizen_sees_only_their_own_household_s_case(client, store):
    _seed_two(client)
    assert client.get(f"/api/v1/cases/{REF}/photos", headers=_citizen("citizen-2")).status_code == 404


def test_a_case_with_no_photos_reads_as_an_empty_gallery(client, store):
    body = client.get(f"/api/v1/cases/{REF}/photos", headers=_admin()).get_json()
    assert body["photos"] == []


def test_a_tile_whose_object_cannot_be_signed_is_shown_as_unavailable(client, store, monkeypatch):
    # One bad object must not blank the whole gallery, and must not look like "no photographs".
    _seed_two(client)
    monkeypatch.setattr("app.api.v1.case_photos.photo_store.sign_many",
                        lambda paths: {list(paths)[0]: "https://storage.example/ok"})
    body = client.get(f"/api/v1/cases/{REF}/photos", headers=_admin()).get_json()
    assert len(body["photos"]) == 2
    assert body["photos"][0]["url"] is not None
    assert body["photos"][1]["url"] is None


def test_every_view_of_a_family_s_photographs_is_audited(client, store):
    # This is the control that makes storing them defensible: who looked is answerable.
    _seed_two(client)
    store["audit"].clear()
    client.get(f"/api/v1/cases/{REF}/photos", headers=_admin())
    viewed = [a for a in store["audit"] if a["event"] == "case_photos_viewed"]
    assert len(viewed) == 1
    assert viewed[0]["actor"] == "admin-1"
    assert '"role": "admin"' in viewed[0]["metadata"]
    assert "storage_path" not in viewed[0]["metadata"], "an audit row is a description, not a key"
