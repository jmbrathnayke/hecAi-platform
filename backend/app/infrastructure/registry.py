"""Household lookups for the submit gate (Story 8.4, FR-10.3 / FR-10.6).

Every submission and lookup path needs the same answer — "which registered household is this
for?" — from a different starting point:

    citizen self-service   the verified JWT `sub`              -> resolve_by_registrant()
    officer-assisted       a household reference               -> resolve_by_ref()
    officer lookup         the NIC the officer types (POST body) -> resolve_by_nic()

Every function takes the CALLER'S cursor rather than opening its own, so the lookup happens inside
the same transaction as the insert it gates. Opening a second connection here would let a
household be revoked between the check and the write.

FR-10.6 lives here too: the resolved row carries the household's own district and ds_division, and
callers use those INSTEAD of anything the client sent. Before Epic 8 the division was an optional
field the client filled in, nullable and unvalidated (migrations 010/015) — which meant a case
could be stored with ds_division NULL and become invisible to the division-scoped officer query at
officer.py:61. Deriving it from the household closes that.
"""
from app.infrastructure.security.nic_identity import NicPepperMissing, nic_hmac

# Only an active household may back a new case. 'transferred' and 'revoked' rows are kept for the
# audit trail and for FR-10.5 history; they must not let a new claim through.
_ACTIVE = "active"

_COLUMNS = "id, household_ref, district, ds_division, status"


def _row_to_household(row):
    if not row:
        return None
    return {
        "id": row[0],
        "household_ref": row[1],
        "district": row[2],
        "ds_division": row[3],
        "status": row[4],
    }


def resolve_by_registrant(cur, citizen_id):
    """The household this Supabase account registered, or None.

    Used on the citizen self-service path, where the identity comes from the verified JWT and the
    body is never consulted — a client that could name its own household could file cases against
    someone else's registration.
    """
    if not citizen_id:
        return None
    cur.execute(
        f"SELECT {_COLUMNS} FROM households WHERE registrant_uid = %s AND status = %s "
        f"ORDER BY id DESC LIMIT 1",
        (citizen_id, _ACTIVE),
    )
    return _row_to_household(cur.fetchone())


def resolve_by_ref(cur, household_ref):
    """A household by its HH-YYYY-NNNN reference, or None.

    Used on the officer-assisted path. The officer looks the family up first (they are holding the
    citizen's card), and the reference travels in the submit body. This DOES trust a staff-supplied
    identifier — deliberately, and no more than the platform already trusts an officer to file a
    case on a citizen's behalf at all. The officer's own id is still taken from their verified JWT
    and written alongside, so every such case is attributable.
    """
    if not isinstance(household_ref, str) or not household_ref.strip():
        return None
    cur.execute(
        f"SELECT {_COLUMNS} FROM households WHERE household_ref = %s AND status = %s",
        (household_ref.strip().upper(), _ACTIVE),
    )
    return _row_to_household(cur.fetchone())


def resolve_by_nic(cur, nic, pepper):
    """The household a NIC belongs to — as registrant OR as a declared member — or None.

    Used by the officer's household lookup (households.py), where the officer types the citizen's
    NIC. Matching declared members too, not just registrants, is the point: a son whose father
    registered the family is covered by that registration and must be able to report.

    Returns None rather than raising on a malformed NIC or a missing pepper — the caller has one
    "not found" answer to give and no use for an exception.
    """
    try:
        digest = nic_hmac(nic, pepper)
    except (ValueError, TypeError, NicPepperMissing):
        return None
    cur.execute(
        f"SELECT h.{', h.'.join(_COLUMNS.split(', '))} "
        f"  FROM household_members m JOIN households h ON h.id = m.household_id "
        f" WHERE m.nic_hmac = %s AND h.status = %s LIMIT 1",
        (digest, _ACTIVE),
    )
    return _row_to_household(cur.fetchone())
