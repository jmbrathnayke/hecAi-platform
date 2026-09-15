"""District / DS-division vocabulary lookups (Story 8.2).

Reads `backend/ml/models/district_reference.json`, which maps **ds_division -> district** for all
167 divisions in the DWC compensation dataset. That file is the inverse of the frontend's
`public/data/district_reference.json` (district -> [divisions]); the two were verified pair-for-pair
identical on 2026-08-26 (167 pairs, zero missing, zero disagreements), so a division the citizen's
picker offers always validates here.

WHY VALIDATE AT ALL. Every prior writer of these columns treated them as free text — migration 010
called ds_division_id "a nullable hook", migration 015 said the picker is "additive, never a hard
submit gate", and report.py carries a note about an unvalidated ds_division_id overflowing a PDF
cell. That was tolerable while the column was decorative. From FR-10.6 it is not: the case inherits
its division FROM the household, and that value decides which officers and which Divisional
Secretariat ever see the case. A typo here means a case nobody is scoped to.

`app/infrastructure/ml/compensation.py` also reads this file, for a different purpose (deriving a
district when only a division is known). Two readers of one data file is deliberate — the
alternative is a second copy that can drift.
"""
import json
import os
import threading

_MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))), "ml", "models")
DISTRICT_REF_PATH = os.path.join(_MODELS_DIR, "district_reference.json")

# Loaded once. The lock matters under gunicorn's threaded workers: two requests racing on first
# use would otherwise both parse the file, and one could read a half-populated dict.
_lock = threading.Lock()
_division_to_district = None


def _reference():
    """-> {ds_division: district}. Empty dict if the file is missing or malformed.

    Degrading to {} rather than raising mirrors compensation.py's handling of the same file. The
    caller decides what an empty vocabulary means; for registration it means every division is
    rejected, which is the correct fail-closed behaviour for a routing field.
    """
    global _division_to_district
    if _division_to_district is None:
        with _lock:
            if _division_to_district is None:
                try:
                    with open(DISTRICT_REF_PATH, encoding="utf-8") as f:
                        loaded = json.load(f)
                    _division_to_district = loaded if isinstance(loaded, dict) else {}
                except (FileNotFoundError, OSError, ValueError):
                    _division_to_district = {}
    return _division_to_district


def district_for_division(ds_division):
    """-> the district a DS division belongs to, or None if the division is unknown."""
    if not isinstance(ds_division, str):
        return None
    return _reference().get(ds_division.strip())


def is_valid_pair(district, ds_division):
    """-> True only if the division exists AND belongs to the district the caller claims.

    Checking the PAIR, not each half: 'තලාව' is a real division and 'අම්පාර' is a real district,
    but that combination does not exist. Accepting it would route the case to officers in a
    district the incident did not happen in.
    """
    if not isinstance(district, str) or not district.strip():
        return False
    return district_for_division(ds_division) == district.strip()


def districts():
    """-> every district name in the reference data, sorted.

    Needed by user provisioning: an administrator is scoped to one district, and a district_id
    claim that matches nothing produces an account whose dashboard is permanently empty. That
    failure is silent and looks identical to "no cases yet", so the value is validated at the
    point it is assigned rather than discovered later.
    """
    return sorted(set(_reference().values()))


def all_divisions():
    """-> [(ds_division, district)] for every division, sorted by district then division.

    For pickers. A DS-division field left as free text is unusable: the names are Sinhala, there
    are 167 of them, and a user has no way to discover a valid one — the only feedback is a
    rejection after submitting. Carrying the district alongside disambiguates the several
    divisions that share a name with their district.
    """
    return sorted(_reference().items(), key=lambda pair: (pair[1], pair[0]))


def is_valid_district(district):
    """-> True if the district exists in the reference data."""
    if not isinstance(district, str) or not district.strip():
        return False
    return district.strip() in set(_reference().values())


def is_valid_division(ds_division):
    """-> True if the DS division exists in the reference data, in any district."""
    return district_for_division(ds_division) is not None


def divisions_in(district):
    """-> sorted DS divisions of a district. For error messages and operator scripts."""
    if not isinstance(district, str):
        return []
    target = district.strip()
    return sorted(d for d, dist in _reference().items() if dist == target)
