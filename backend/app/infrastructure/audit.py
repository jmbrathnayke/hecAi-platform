"""Tamper-evident audit log writes (FR-5.5, AD-4). See migration 012 for why this exists:
audit_log previously had neither a cryptographic hash chain nor working role-based
tamper-evidence — this module is the actual FR-5.5 implementation.

Every row's `hash` covers its own content AND the previous row's `hash` (`prev_hash`),
so altering any historical row breaks every hash computed after it, not just its own —
that break is what `verify_chain()` detects.

Concurrency: `write_audit_log()` takes a transaction-scoped Postgres advisory lock before
reading the current chain tip, so two concurrent writers (e.g. two officers submitting at
once) can never both read the same "previous hash" and fork the chain. The lock is a single
global key — the chain spans the whole table, not per-case — and auto-releases at the
caller's transaction commit/rollback (`pg_advisory_xact_lock`, not the session-scoped
variant, so it stays correct under transaction-mode connection pooling).
"""
import hashlib
import json
from datetime import datetime, timezone

# Arbitrary constant identifying this specific lock in Postgres's advisory-lock keyspace.
# Any fixed int works; it only needs to be unique among this app's advisory locks (there
# are no others today).
_AUDIT_CHAIN_LOCK_KEY = 987654321


def _compute_hash(prev_hash, case_id, event, actor_id, metadata, created_at_iso):
    """Deterministic hash of one logical entry. `sort_keys=True` so the same logical
    entry always hashes identically regardless of dict key ordering (Python dicts don't
    guarantee it across processes/versions)."""
    payload = json.dumps(
        {
            "prev_hash": prev_hash,
            "case_id": case_id,
            "event": event,
            "actor_id": actor_id,
            "metadata": metadata,
            "created_at": created_at_iso,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def write_audit_log(cur, case_id, event, actor_id, metadata=None):
    """Insert a hash-chained audit_log row using the caller's cursor — same transaction
    as whatever case/state change this entry is auditing, so the two commit or roll back
    together. `metadata` is a plain dict or None, never a pre-serialized string."""
    cur.execute("SELECT pg_advisory_xact_lock(%s)", (_AUDIT_CHAIN_LOCK_KEY,))
    cur.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    prev_hash = row[0] if row else None

    created_at = datetime.now(timezone.utc)
    entry_hash = _compute_hash(
        prev_hash, case_id, event, actor_id, metadata, created_at.isoformat()
    )

    cur.execute(
        """INSERT INTO audit_log (case_id, event, actor_id, metadata, created_at, hash, prev_hash)
           VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s)""",
        (
            case_id,
            event,
            actor_id,
            json.dumps(metadata) if metadata is not None else None,
            created_at,
            entry_hash,
            prev_hash,
        ),
    )


def verify_chain(cur):
    """Walk the whole audit_log chain in id order and confirm every hashed row's hash
    matches its own content plus the previous hashed row's hash. A NULL-hash row is a
    documented legacy entry (predates migration 012) — skipped, not a break, and the
    chain is expected to start fresh at the next hashed row.

    Returns (is_valid: bool, broken_id: int | None). broken_id is the first row whose
    stored hash doesn't match its recomputed hash, or whose prev_hash doesn't match the
    previous hashed row's actual hash.
    """
    cur.execute(
        "SELECT id, case_id, event, actor_id, metadata, created_at, hash, prev_hash "
        "FROM audit_log ORDER BY id ASC"
    )
    expected_prev = None
    for id_, case_id, event, actor_id, metadata, created_at, hash_, prev_hash in cur.fetchall():
        if hash_ is None:
            continue  # legacy pre-chain row — not part of the chain, not a break

        if prev_hash != expected_prev:
            return False, id_

        recomputed = _compute_hash(prev_hash, case_id, event, actor_id, metadata, created_at.isoformat())
        if recomputed != hash_:
            return False, id_
        expected_prev = hash_

    return True, None
