"""Classification validation and the append-only inference_log write (Story 3.4, migration 006).

Shared by every path that records an on-device MobileNetV2 classification: the research log endpoint
(POST /inference/log), the officer's assessment of a citizen's case (officer_cases.py), and an
officer-assisted submission that already carries its classification (cases.py / sync.py). One set of
rules, so a classification is never accepted on one path that another would reject.
"""
import json

from app.domain.validation import MIN_REASON_LENGTH

# The 3 model classes (ClassId). `combined` is a derived case-level rollup, never a per-photo
# class, so it is NOT a valid override target.
VALID_CATEGORIES = {"crop_damage", "no_damage", "property_damage"}

# Known model families (AC5 metric filters on model_type). Anything else is a client error.
VALID_MODEL_TYPES = {"mobilenetv2", "random_forest"}
# Match the inference_log VARCHAR limits (migration 006) so over-length input is a 400 here,
# not a StringDataRightTruncation 500 at INSERT.
MAX_MODEL_VERSION_LEN = 20
MAX_PREDICTION_LEN = 50


def parse_classification(body):
    """Validate an on-device classification (and any officer override) -> (fields, None) or
    (None, error_code).

    Shared by POST /inference/log and the officer case assessment (officer.py), so a classification
    recorded against a case is held to exactly the rules of the research log: known model families,
    a probability in range, and an override that carries a real class and a substantive reason.
    """
    model_version = body.get("model_version")
    if not isinstance(model_version, str) or not model_version:
        return None, "model_version_required"
    if len(model_version) > MAX_MODEL_VERSION_LEN:
        return None, "invalid_model_version"

    prediction = body.get("prediction")
    if not isinstance(prediction, str) or not prediction:
        return None, "prediction_required"
    if len(prediction) > MAX_PREDICTION_LEN:
        return None, "invalid_prediction"

    # model_type defaults to mobilenetv2; only known model families are accepted (they must
    # fit VARCHAR(20) and stay inside the AC5 metric filter).
    model_type = body.get("model_type") or "mobilenetv2"
    if model_type not in VALID_MODEL_TYPES:
        return None, "invalid_model_type"

    # confidence is an optional 0..1 probability stored in DECIMAL(5,4). Reject bools (bool is
    # an int subclass) and out-of-range values so a client mistake is a 400, not a numeric
    # overflow 500 (or a silently stored impossible probability).
    confidence = body.get("confidence")
    if confidence is not None:
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return None, "invalid_confidence"
        if not 0 <= confidence <= 1:
            return None, "invalid_confidence"

    # Only a real JSON boolean counts — bool("false") is True, so coercing here would let a
    # stringy "false" flip into the override branch.
    was_overridden = body.get("was_overridden", False)
    if not isinstance(was_overridden, bool):
        return None, "invalid_was_overridden"
    override_reason = body.get("override_reason")
    override_category = body.get("override_category")

    if was_overridden:
        # AC7: an override must carry a valid corrected class and a substantive reason.
        if not isinstance(override_category, str) or override_category not in VALID_CATEGORIES:
            return None, "invalid_override_category"
        if (
            not isinstance(override_reason, str)
            or len(override_reason.strip()) < MIN_REASON_LENGTH
        ):
            return None, "override_reason_too_short"
        # Store the reason without the surrounding whitespace the client's gate ignores.
        override_reason = override_reason.strip()
        # D1: "correcting" to the class the AI already predicted is not a disagreement — record
        # it as a non-override so the NFR-6.3 override-rate metric stays honest. The reason and
        # category are kept as an audit note.
        if override_category == prediction:
            was_overridden = False
    else:
        # A non-override row carries no override fields.
        override_reason = None
        override_category = None

    return {
        "model_version": model_version,
        "prediction": prediction,
        "model_type": model_type,
        "confidence": confidence,
        "was_overridden": was_overridden,
        "override_reason": override_reason,
        "override_category": override_category,
    }, None


# Open-set gate fields (frontend lib/oodGate.ts). They ride in input_features (JSONB) rather than
# in new columns, which is what that column is for -- the research feature snapshot -- and means no
# migration is needed to start recording them.
#
# WHY THEY MATTER TO THE RECORD. The gate can change `prediction` to no_damage for a photo that
# resembles none of the three trained classes. That is the right workflow outcome (a no_damage case
# is never priced), but without these fields a reader of inference_log could not tell a photo the
# model recognised as an intact field from a photo it recognised as nothing at all -- the
# no_damage rate would rise with no way to explain it, and the override-rate metric (NFR-6.3) would
# be computed over a mix of the two.
_GATE_MAX_DISTANCE = 2.0  # cosine distance lies in [0, 2]


def parse_gate_fields(body, prediction=None):
    """Validate the optional open-set gate fields -> (dict, None) or (None, error_code).

    Absent entirely (an older client, or the officer-assisted paths that predate the gate) is
    valid and yields an empty dict: the rest of the classification is still a complete record.

    `prediction` is the classification's own served class. When given, the invariant below is
    enforced; the caller passes it so the two halves of one record cannot contradict each other.
    """
    out = {}

    version = body.get("ai_gate_version")
    if version is not None:
        if not isinstance(version, str) or not version or len(version) > 40:
            return None, "invalid_gate_version"
        out["ai_gate_version"] = version

    for key in ("ai_gate_applied", "ai_out_of_domain"):
        value = body.get(key)
        if value is not None:
            # A real JSON boolean only -- bool("false") is True, so coercion would silently flip
            # a rejected photo into an accepted one.
            if not isinstance(value, bool):
                return None, "invalid_gate_flag"
            out[key] = value

    distance = body.get("ai_domain_distance")
    if distance is not None:
        if isinstance(distance, bool) or not isinstance(distance, (int, float)):
            return None, "invalid_domain_distance"
        if not 0 <= distance <= _GATE_MAX_DISTANCE:
            return None, "invalid_domain_distance"
        out["ai_domain_distance"] = float(distance)

    raw_prediction = body.get("ai_raw_prediction")
    if raw_prediction is not None:
        if raw_prediction not in VALID_CATEGORIES:
            return None, "invalid_raw_prediction"
        out["ai_raw_prediction"] = raw_prediction

    raw_confidence = body.get("ai_raw_confidence")
    if raw_confidence is not None:
        if isinstance(raw_confidence, bool) or not isinstance(raw_confidence, (int, float)):
            return None, "invalid_raw_confidence"
        if not 0 <= raw_confidence <= 1:
            return None, "invalid_raw_confidence"
        out["ai_raw_confidence"] = float(raw_confidence)

    # A rejected photo must say what it was rejected against, or the row cannot be audited later.
    if out.get("ai_out_of_domain") and "ai_domain_distance" not in out:
        return None, "domain_distance_required"

    # THE INVARIANT. If the gate rejected the photo, the served class is no_damage -- that is what
    # the gate does, and it is what keeps compensation.py from pricing a photo the model could not
    # recognise (_map_damage_category returns None only for no_damage). The server does not take
    # the client's word for both halves independently: a body claiming "out of domain" alongside
    # "property_damage" is a contradiction, and accepting it would let a rejected photo generate
    # an estimate. An officer override still works -- it travels in override_category, and leaves
    # `prediction` as the model's own answer.
    if out.get("ai_out_of_domain") and prediction is not None and prediction != "no_damage":
        return None, "out_of_domain_prediction_mismatch"

    return out, None


def insert_inference_log(cur, case_id, fields, input_features):
    """Append one inference_log row (never an update -- the log is append-only)."""
    cur.execute(
        """INSERT INTO inference_log
             (case_id, model_type, model_version, input_features, prediction,
              confidence, was_overridden, override_reason, override_category)
           VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s)""",
        (
            case_id,
            fields["model_type"],
            fields["model_version"],
            json.dumps(input_features),
            fields["prediction"],
            fields["confidence"],
            fields["was_overridden"],
            fields["override_reason"],
            fields["override_category"],
        ),
    )
