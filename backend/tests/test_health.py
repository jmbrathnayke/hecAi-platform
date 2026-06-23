import pytest
from app import create_app


@pytest.fixture
def client():
    app = create_app({"TESTING": True})
    return app.test_client()


def test_health_returns_ok(client):
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.get_json() == {"status": "ok"}


def test_health_content_type_is_json(client):
    resp = client.get("/api/v1/health")
    assert "application/json" in resp.content_type


def test_health_unknown_route_returns_404(client):
    resp = client.get("/api/v1/unknown")
    assert resp.status_code == 404
