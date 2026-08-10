"""Operational scripts (Story 7.4). Not imported by the Flask app and not collected by pytest.

Run as modules from `backend/` so `app.*` imports resolve:

    python -m scripts.seed_research_data
    python -m scripts.clear_research_data

`python scripts/seed_research_data.py` will ImportError on `from app.infrastructure...`.
"""
