"""Shared input-validation constants used by more than one API module.

MIN_REASON_LENGTH: minimum length of any free-text justification a reviewer/officer supplies
for an override or case-review action (AI override reason in inference.py, admin case-action
reason in admin.py). One definition so the two endpoints can't silently drift apart.
"""

MIN_REASON_LENGTH = 10
