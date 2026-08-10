"""Shared constants and the pure planning function for research seeding (Story 7.4, RER-4).

`build_plan()` is deliberately DB-free so the distribution rules in AC1/AC2 can be asserted by
the ordinary pytest suite (`tests/test_seed_plan.py`) with no Postgres — the same reason the rest
of this codebase fakes its DB in tests. Everything that touches a connection lives in
seed_research_data.py / clear_research_data.py.

TWO VOCABULARIES, and mixing them is the single easiest way to break this story:

  * `cases.damage_category` ∈ {crop, property, combined, none} — the incident form's keys
    (frontend/app/[locale]/report/damage/page.tsx). This is what the compensation model's
    _DAMAGE_TYPE_MAP is keyed on.
  * `inference_log.prediction` / `override_category` / `ground_truth` ∈
    {crop_damage, no_damage, property_damage} — the 3 MobileNetV2 classes, alphabetical.

`none` is deliberately absent from _DAMAGE_TYPE_MAP (a false report is not a claim), so a seeded
case with damage_category='none' — or with a model class name in that column — gets NO
compensation estimate at all and silently fails AC2. Hence SEED_DAMAGE_CATEGORIES excludes it.
"""
import json
import uuid
from datetime import timedelta

from app.infrastructure.ml.compensation import LOOKUP_PATH

# Fixed namespace so offline_ids are reproducible across runs and machines. This is what makes
# the seeder idempotent: a re-run recomputes the same UUIDs and finds the rows already present.
SEED_NAMESPACE = uuid.UUID("7e5d0000-7f4a-5e4d-9c1b-000000000744")

SEED_ACTOR = "seed-script"
SEED_OFFICER_ID = "seed-officer-01"

# The "-seed" marker is a research-integrity control, not decoration: it keeps synthetic
# inference rows distinguishable from real ones in any export, so seeded metrics can never be
# mistaken for the dissertation's real model numbers (which live in backend/ml/results/).
SEED_MODEL_VERSION = "seed-1.0"
SEED_MODEL_TYPE = "mobilenetv2"  # must be in inference.py's VALID_MODEL_TYPES

DEFAULT_COUNT = 50
RNG_SEED = 20260810

# PRD:344 — "Model training and pilot evaluation are limited to ... primarily Polonnaruwa,
# Anuradhapura, Hambantota, and Monaragala." cases.district is TEXT holding the Sinhala name
# (migration 015); there is no district_id column despite ds_division_id's misleading suffix.
PILOT_DISTRICTS = (
    "අනුරාධපුරය",   # Anuradhapura
    "පොළොන්නරුව",  # Polonnaruwa
    "මොණරාගල",     # Monaragala
    "හම්බන්තොට",    # Hambantota
)

MODEL_CLASSES = ("crop_damage", "no_damage", "property_damage")  # alphabetical, 3 not 4
SEED_DAMAGE_CATEGORIES = ("crop", "property", "combined")  # 'none' excluded — see module docstring
SEVERITIES = ("Minor", "Moderate", "Severe")
LOCALES = ("si", "ta", "en")

# admin.py's real status machine: Submitted -> Under Review -> Approved/Rejected -> Payment
# Processed. The epic's "~40/20/25/15" is not integral over 50 cases; 40/20/26/14 is the nearest
# integral realisation and keeps the four buckets whole at any count.
STATUS_RATIOS = (
    ("Submitted", 0.40),
    ("Under Review", 0.20),
    ("Approved", 0.26),
    ("Rejected", 0.14),
)

OVERRIDE_RATE = 0.30  # AC2/AC3: migration 006's override-rate query must return exactly this
DISAGREE_RATE = 0.16  # ground_truth != prediction, see _assign_ground_truth
CONFIDENCE_MIN = 0.30
CONFIDENCE_MAX = 0.95

_PREDICTION_FOR_CATEGORY = {
    "crop": "crop_damage",
    "property": "property_damage",
    # 'combined' is a case-level rollup of multiple photos, never a model class of its own; the
    # per-photo row we seed for it is whichever class the "first" photo produced.
    "combined": "crop_damage",
}


def load_pilot_divisions():
    """DS-division names per pilot district, taken from the compensation model's own prior-year
    lookup so every seeded division is one the model actually knows.

    A division absent from this lookup falls through _prior_year_features() to the
    {0.0, -1.0, 0.0} sentinel, which collapses every estimate in that district onto the same
    uninformative value. Sorted for determinism — dict/JSON ordering is not a contract.
    """
    with open(LOOKUP_PATH, encoding="utf-8") as fh:
        lookup = json.load(fh)

    divisions = {d: set() for d in PILOT_DISTRICTS}
    for key in lookup:
        district, division, damage_type = key.split("|")
        if district in divisions and damage_type == "property":
            divisions[district].add(division)

    result = {d: sorted(v) for d, v in divisions.items()}
    missing = [d for d, v in result.items() if not v]
    if missing:
        raise RuntimeError(f"No property divisions in the lookup for: {missing}")
    return result


def _largest_remainder(count, ratios):
    """Split `count` across `ratios` so the parts sum to exactly `count`.

    Plain rounding does not: 50 x (0.40, 0.20, 0.26, 0.14) rounds to 20+10+13+7 by luck, but
    e.g. 150 x the same ratios rounds to 60+30+39+21 = 150 only because the remainders happen to
    cooperate. Largest-remainder makes it exact for any count, which AC1 depends on.
    """
    raw = [(name, count * ratio) for name, ratio in ratios]
    floors = [(name, int(value)) for name, value in raw]
    shortfall = count - sum(v for _, v in floors)
    order = sorted(range(len(raw)), key=lambda i: raw[i][1] - floors[i][1], reverse=True)
    counts = dict(floors)
    for i in order[:shortfall]:
        counts[raw[i][0]] += 1
    return counts


def _other_class(exclude, offset):
    """A model class that is not `exclude`, chosen deterministically by `offset`."""
    options = [c for c in MODEL_CLASSES if c != exclude]
    return options[offset % len(options)]


def build_plan(count=DEFAULT_COUNT, now=None, rng=None, divisions=None):
    """Return `count` fully-decided case dicts. Pure: no DB, no clock unless `now` is omitted.

    Determinism is structural, not statistical: every quota (statuses, overrides, ground-truth
    disagreements) is assigned by slicing one shuffled index list, so the counts are exact rather
    than approximately right. Two runs with the same seed produce identical plans.
    """
    if now is None:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
    if rng is None:
        import random

        rng = random.Random(RNG_SEED)
    if divisions is None:
        divisions = load_pilot_divisions()

    order = list(range(count))
    rng.shuffle(order)

    # --- statuses -------------------------------------------------------------------------
    status_counts = _largest_remainder(count, STATUS_RATIOS)
    status_by_index = {}
    cursor = 0
    for name, n in status_counts.items():
        for idx in order[cursor:cursor + n]:
            status_by_index[idx] = name
        cursor += n

    # --- overrides: exactly round(count * 0.30) -------------------------------------------
    n_override = round(count * OVERRIDE_RATE)
    override_indices = set(order[:n_override])

    # --- ground-truth disagreements -------------------------------------------------------
    # Arbitrary synthetic labelling, chosen only so the confusion matrix is non-degenerate. It
    # encodes NO claim about real model behaviour: a perfectly diagonal matrix would look like a
    # fabricated 100% accuracy, and matching the real 0.947 would be worse — it would look like
    # the genuine result. Most disagreements sit on overridden cases (officer corrected a wrong
    # prediction); a few sit on non-overridden ones (the AI was wrong and nobody caught it).
    n_disagree = round(count * DISAGREE_RATE)
    n_disagree_overridden = min(round(n_disagree * 0.625), n_override)
    n_disagree_clean = n_disagree - n_disagree_overridden

    overridden_ordered = [i for i in order if i in override_indices]
    clean_ordered = [i for i in order if i not in override_indices]
    disagree_indices = set(overridden_ordered[:n_disagree_overridden])
    disagree_indices.update(clean_ordered[:n_disagree_clean])

    # --- officer-assisted slice (~20%) -----------------------------------------------------
    officer_indices = set(order[-max(1, round(count * 0.20)):])

    span = max(count - 1, 1)
    plan = []
    for i in range(count):
        district = PILOT_DISTRICTS[i % len(PILOT_DISTRICTS)]
        district_divisions = divisions[district]
        damage_category = SEED_DAMAGE_CATEGORIES[i % len(SEED_DAMAGE_CATEGORIES)]
        status = status_by_index[i]

        # Spread evenly back over the trailing 12 months so Story 7.1's "last 12 months" trend
        # chart has a real shape. Leaving submitted_at to its NOW() default would pile all rows
        # onto one day and flatten the chart into a single spike.
        submitted_at = now - timedelta(days=round(i * 365 / span))

        if status in ("Approved", "Rejected"):
            # admin.py's avg_processing_days KPI is updated_at - submitted_at; leaving them equal
            # reports a meaningless 0.0 days. Clamped so a recent case never lands in the future.
            decided_at = min(submitted_at + timedelta(days=3 + (i % 19)), now)
        else:
            decided_at = submitted_at

        prediction = _PREDICTION_FOR_CATEGORY[damage_category]
        if damage_category == "combined" and i % 2:
            prediction = "property_damage"

        was_overridden = i in override_indices
        # Story 3.4 decision D1: a same-category "override" is recorded as a NON-override so the
        # NFR-6.3 metric stays honest. So an override must always change the class.
        override_category = _other_class(prediction, i) if was_overridden else None

        if i in disagree_indices:
            ground_truth = override_category if was_overridden else _other_class(prediction, i + 1)
        else:
            ground_truth = prediction

        plan.append({
            "index": i,
            "offline_id": str(uuid.uuid5(SEED_NAMESPACE, f"hec-seed-{i:03d}")),
            "status": status,
            "damage_category": damage_category,
            "district": district,
            "ds_division_id": district_divisions[i % len(district_divisions)],
            "submitted_at": submitted_at,
            "updated_at": decided_at,
            "locale": LOCALES[i % len(LOCALES)],
            "submitted_by_officer": i in officer_indices,
            "officer_id": SEED_OFFICER_ID if i in officer_indices else None,
            "ai_severity": SEVERITIES[i % len(SEVERITIES)],
            "prediction": prediction,
            "confidence": round(CONFIDENCE_MIN + (CONFIDENCE_MAX - CONFIDENCE_MIN) * i / span, 4),
            "was_overridden": was_overridden,
            "override_category": override_category,
            "ground_truth": ground_truth,
            # Approved cases need a human figure that differs from the model's, or MAE is
            # identically zero — another fabricated-perfect artifact. Deterministic +/-30%.
            "approval_factor": round(0.70 + 0.60 * ((i * 7) % 11) / 10, 3),
        })

    return plan
