"""Claim workflow stages (human-in-the-loop governance, migration 033).

The five FR-6.2 statuses stay the only values of cases.status. A STAGE is a finer, derived view of
where a claim is in the intended lifecycle:

    submitted -> officer_review -> officer_assessed -> dwc_approved -> ds_final_decided
      -> payment_processed            (or `rejected`, which is not a step ON the journey)

Derived from timestamps rather than stored, so it can never disagree with the status column or the
audit trail that recorded each checkpoint. Pure -- no DB, no Flask -- so every surface (officer,
admin, DS, the public status page) computes it the same way.
"""

STAGES = (
    "submitted",
    "officer_review",
    "officer_assessed",
    "dwc_approved",
    "ds_final_decided",
    "payment_processed",
)


def workflow_stage(status, officer_review_started_at=None, officer_assessed_at=None,
                   ds_final_at=None, submitted_by_officer=False):
    """-> one of STAGES, or "rejected".

    An officer-assisted submission is assessed at the moment of submission (the officer was present
    and classified the damage on-device), so it enters the journey already at `officer_assessed`.
    """
    if status == "Rejected":
        return "rejected"
    if status == "Payment Processed":
        return "payment_processed"
    if status == "Approved":
        return "ds_final_decided" if ds_final_at else "dwc_approved"
    if officer_assessed_at or submitted_by_officer:
        return "officer_assessed"
    if status == "Under Review" or officer_review_started_at:
        return "officer_review"
    return "submitted"
