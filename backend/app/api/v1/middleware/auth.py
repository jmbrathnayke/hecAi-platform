"""Officer auth middleware (Story 3.1).

`require_officer()` independently decodes and validates the Supabase JWT server-side —
per CRITICAL #2, the frontend's `assigned_divisions` claim is never trusted directly;
every officer-scoped route re-derives it here from a signature-verified token.

AUTHORIZATION CLAIMS LIVE IN `app_metadata`, NOT `user_metadata` (fixed 2026-08-11).
A signature-verified token is not the same thing as a trustworthy one. Supabase lets any
authenticated client rewrite its OWN `user_metadata` through `auth.updateUser()`, and the
result is signed by Supabase like any other claim — so while these guards read `role` from
there, a citizen could set `{"role": "system_admin"}` on themselves and walk into
/research/export with a perfectly valid signature. `app_metadata` is writable only with the
service-role key, which never leaves the server, so it is the only metadata field that can
carry an authorization decision. `district_id` and `assigned_divisions` move with it: they
are not descriptive, they decide WHICH district's data you can read.

There is deliberately NO fallback to `user_metadata` — a fallback would restore exactly the
escalation path this closes. Existing Supabase users must be migrated before their tokens
authorize anything again; see backend/scripts/migrate_auth_metadata.py, which COPIES claims a
user already has in `user_metadata`. A staff member who never had them there (anyone who signed
up through Google OAuth) is invisible to that script and must be granted claims outright with
backend/scripts/set_staff_claims.py. Running only the former and seeing "0 users updated" does
not mean there is nothing to do — it usually means every account still needs the latter.

SIGNATURE VERIFICATION IS ES256-VIA-JWKS, NOT HS256 (fixed 2026-08-11).
Supabase issues asymmetrically-signed tokens; these guards previously hard-coded
`algorithms=["HS256"]` against the legacy shared secret, so PyJWT raised InvalidAlgorithmError
on every real token and *every authenticated request 401'd*. Verification mode is now chosen
from server configuration — JWKS when the project publishes one, the legacy secret otherwise —
and the two are never accepted by the same decode call; see _ASYMMETRIC_ALGORITHMS.
"""
import functools
import threading
import time

import jwt
from flask import current_app, g, jsonify, request

# The single claim these guards trust for authorization.
AUTHZ_CLAIM = "app_metadata"

# Asymmetric algorithms accepted when the project publishes a JWKS (fixed 2026-08-11).
#
# HS256 IS DELIBERATELY ABSENT FROM THIS LIST, and the two verification modes below are chosen
# from SERVER CONFIG — never from the token's own `alg` header. Letting a token select its
# verification algorithm is the classic JWT algorithm-confusion attack: with HS256 accepted
# alongside ES256, an attacker takes the EC PUBLIC key (published at the JWKS URL, so not a
# secret at all), HMAC-signs a token of their choosing with it, and the server — using that same
# public key as the shared secret — verifies it happily. Forged admin tokens for anyone who can
# read a public URL. Keeping the algorithm set tied to the key source closes that off.
_ASYMMETRIC_ALGORITHMS = ["ES256", "RS256"]

# Re-fetch the JWKS at most this often. PyJWKClient additionally refetches on a `kid` miss, so
# key rotation is picked up immediately rather than waiting out this window.
_JWKS_LIFESPAN_SECONDS = 300

# How long an unknown `kid` is remembered as bad. See _kid_recently_missed() for why this exists.
_KID_MISS_TTL_SECONDS = 60
_KID_MISS_MAX_ENTRIES = 256

# One client per URL, reused across requests: it owns the key cache, so building a fresh one per
# request would mean an HTTPS round-trip to Supabase on every authenticated API call.
_jwk_clients = {}
_jwk_clients_lock = threading.Lock()

# Negative cache of `kid`s the JWKS endpoint does not know about, keyed by (url, kid).
_kid_misses = {}
_kid_misses_lock = threading.Lock()


def _jwk_client(url):
    with _jwk_clients_lock:
        client = _jwk_clients.get(url)
        if client is None:
            # cache_keys=False IS DELIBERATE (code review 2026-08-13).
            #
            # cache_keys=True wraps get_signing_key() in an lru_cache with NO time component,
            # which sits in front of the `lifespan` window below. Once a kid resolved once, that
            # key was returned forever without ever consulting the refreshed JWK set — so
            # revoking a COMPROMISED Supabase signing key was a no-op against a long-lived
            # worker: tokens signed by the revoked key kept verifying until the process
            # restarted (16-entry LRU, ~2 kids in practice, so eviction never happened either).
            # With it off, `lifespan` is authoritative and a revocation takes effect in <=300s.
            client = jwt.PyJWKClient(
                url, cache_keys=False, lifespan=_JWKS_LIFESPAN_SECONDS, timeout=10
            )
            _jwk_clients[url] = client
        return client


def _kid_recently_missed(url, kid):
    """Has this `kid` already been rejected by the JWKS endpoint very recently?

    On a kid miss PyJWKClient re-fetches the JWK set with refresh=True, which BYPASSES the
    `lifespan` cache entirely, and lru_cache never memoizes the raised exception — so an
    unauthenticated caller looping on tokens with random `kid` headers forced one live HTTPS
    round-trip to Supabase per request, each blocking a sync worker for up to `timeout`.
    Remembering misses briefly makes the second and subsequent forgeries free (code review
    2026-08-13). Connectivity failures deliberately do NOT populate this cache — see the caller.
    """
    if not kid:
        return False
    with _kid_misses_lock:
        expiry = _kid_misses.get((url, kid))
        if expiry is None:
            return False
        if expiry <= time.monotonic():
            _kid_misses.pop((url, kid), None)
            return False
        return True


def _remember_kid_miss(url, kid):
    if not kid:
        return
    now = time.monotonic()
    with _kid_misses_lock:
        if len(_kid_misses) >= _KID_MISS_MAX_ENTRIES:
            for key, expiry in list(_kid_misses.items()):
                if expiry <= now:
                    _kid_misses.pop(key, None)
            # Still full of live entries — this is an active flood; drop the oldest insertion so
            # the map stays bounded rather than growing into a memory-exhaustion vector.
            if len(_kid_misses) >= _KID_MISS_MAX_ENTRIES:
                _kid_misses.pop(next(iter(_kid_misses)), None)
        _kid_misses[(url, kid)] = now + _KID_MISS_TTL_SECONDS


def _auth_configured():
    """Is there any way to verify a token at all? Guards return 500, not 401, when not."""
    return bool(
        current_app.config.get("SUPABASE_JWKS_URL")
        or current_app.config.get("SUPABASE_JWT_SECRET")
    )


def _decode_supabase_jwt(token):
    """Signature-verify a Supabase JWT and return its claims. Raises jwt.PyJWTError.

    Supabase projects issue ES256 (asymmetric) tokens signed by a rotating key published at the
    project's JWKS endpoint; the legacy shared-secret HS256 mode is on its way out. Verifying
    with `algorithms=["HS256"]` against an ES256 token raises InvalidAlgorithmError, which is
    what made every authenticated call 401 before this was fixed.

    Mode is decided by configuration: JWKS when the project publishes one, the legacy secret
    otherwise. See _ASYMMETRIC_ALGORITHMS for why the two must never be merged into one call.

    PRIVATE ON PURPOSE (code review 2026-08-13). It assumes _auth_configured() has already been
    checked; called directly with neither mode configured it would reach
    jwt.decode(token, None, ...), which raises outside the PyJWTError hierarchy and escapes the
    deliberate 500/401 contract in authenticated_claims(). Route code should use the guards.
    """
    if not _auth_configured():
        # Defence in depth: the only caller checks this first, but a future one might not.
        raise jwt.InvalidKeyError("no verification mode is configured")

    jwks_url = current_app.config.get("SUPABASE_JWKS_URL")
    if jwks_url:
        # The `kid` is attacker-controlled free text read from an as-yet-unverified header, so a
        # miss must be cheap. See _kid_recently_missed().
        kid = jwt.get_unverified_header(token).get("kid")
        if _kid_recently_missed(jwks_url, kid):
            raise jwt.InvalidKeyError("unknown key id (negatively cached)")
        try:
            signing_key = _jwk_client(jwks_url).get_signing_key_from_jwt(token)
        except jwt.PyJWKClientConnectionError:
            # We could not REACH the endpoint, which says nothing about this kid. Caching it
            # would turn a transient Supabase blip into 60s of spurious 401s for valid tokens.
            raise
        except jwt.PyJWKClientError:
            _remember_kid_miss(jwks_url, kid)
            raise

        # `aud`/`iss`/`exp` are enforced on THIS branch only (code review 2026-08-13). This is
        # the production path — render.yaml sets SUPABASE_URL inline, so a real deployment always
        # lands here. Without them the trust model was merely "signed by the project key", which
        # accepts any other token the project ever mints for a different audience or service.
        # The legacy HS256 branch below stays lenient: it is the self-hosted/older-project
        # fallback, and it is what the pre-existing test suite mints against.
        options = {"require": ["exp"]}
        issuer = current_app.config.get("SUPABASE_ISSUER")
        if not issuer:
            # A hand-set SUPABASE_JWKS_URL with no SUPABASE_URL to derive an issuer from.
            options["verify_iss"] = False
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=_ASYMMETRIC_ALGORITHMS,
            audience="authenticated",
            issuer=issuer,
            options=options,
        )
    return jwt.decode(
        token,
        current_app.config.get("SUPABASE_JWT_SECRET"),
        algorithms=["HS256"],
        options={"verify_aud": False},
    )


def authenticated_claims():
    """Shared front half of every guard below.

    Returns `(claims, None)` on success, or `(None, (body, status))` for the caller to return.
    Factored out so the four guards cannot drift apart on error codes or — more importantly —
    on which algorithms they accept.
    """
    # Credential check FIRST (code review 2026-08-13). With the order reversed, a caller who
    # presented nothing at all learned "this deployment's auth is not configured" — a precise,
    # actionable signal handed to anonymous scanners. Someone with no token gets 401 regardless
    # of server state; the operator-facing 500 is only meaningful to a caller who actually
    # supplied a credential, and is preserved for exactly that case below.
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None, (jsonify({"error": "missing_token"}), 401)
    token = auth.split(" ", 1)[1]

    if not _auth_configured():
        # Server misconfiguration, not a client auth problem — mirrors cases.py.
        return None, (jsonify({"error": "server_misconfigured"}), 500)

    try:
        claims = _decode_supabase_jwt(token)
        # Debug-level only, so it is silent in production (where the level is INFO) but tells a
        # developer staring at a 403 exactly what the guard saw — absent role vs. wrong value vs.
        # claim in the wrong place — without decoding cookies by hand. No secrets: `sub` is an
        # opaque user id and the role is the thing being debugged.
        current_app.logger.debug(
            "auth: sub=%s role=%r app_metadata_keys=%s",
            claims.get("sub"),
            authz_role(claims),
            sorted(authz_metadata(claims).keys()),
        )
        return claims, None
    except jwt.PyJWKClientConnectionError:
        # We could not REACH the JWKS endpoint. The token may well be perfectly valid, so
        # calling it invalid would sign every officer out during a transient Supabase blip.
        # Fail closed, but report it as ours: 500, not 401.
        return None, (jsonify({"error": "server_misconfigured"}), 500)
    except jwt.ExpiredSignatureError:
        return None, (jsonify({"error": "token_expired"}), 401)
    except jwt.PyJWTError:
        return None, (jsonify({"error": "invalid_token"}), 401)
    except Exception:
        # PyJWKClient wraps URLError/TimeoutError into PyJWKClientConnectionError, but it does
        # NOT wrap json.JSONDecodeError — and a proxy, captive portal, or paused Supabase project
        # returning an HTML error page is exactly how this endpoint fails in practice. Without
        # this the exception escaped to Flask's generic handler: a traceback on every request
        # during the incident, a response shape the frontend does not expect, and the interactive
        # debugger if DEBUG were ever set. Fails closed, and stays inside the 500 contract.
        current_app.logger.exception("auth: JWKS verification raised a non-JWT error")
        return None, (jsonify({"error": "server_misconfigured"}), 500)


def authz_metadata(claims):
    """The server-controlled metadata dict, or {} if absent/malformed."""
    metadata = claims.get(AUTHZ_CLAIM)
    return metadata if isinstance(metadata, dict) else {}


def authz_role(claims):
    """The caller's role, or None. Never falls back to client-writable `user_metadata`."""
    role = authz_metadata(claims).get("role")
    return role if isinstance(role, str) else None


def require_officer():
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            claims, error = authenticated_claims()
            if error:
                return error

            metadata = authz_metadata(claims)
            if authz_role(claims) != "officer":
                return jsonify({"error": "forbidden"}), 403

            officer_id = claims.get("sub")
            if not officer_id:
                # A validly-signed token missing `sub` is malformed, not just unauthorized —
                # don't let a None officer_id silently flow into downstream officer_id-keyed
                # queries/audit writes.
                return jsonify({"error": "invalid_token"}), 401

            assigned_divisions = metadata.get("assigned_divisions", [])
            if not isinstance(assigned_divisions, list):
                assigned_divisions = []
            g.officer_id = officer_id
            g.assigned_divisions = [d for d in assigned_divisions if isinstance(d, str)]
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_admin():
    """Guard admin-owned routes (Story 5.1). Mirrors require_officer()'s independent JWT
    validation and error-code conventions; a district admin's `district_id` is never trusted
    from the client — every admin-scoped route re-derives it here from a signature-verified
    token."""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            claims, error = authenticated_claims()
            if error:
                return error

            metadata = authz_metadata(claims)
            if authz_role(claims) != "admin":
                # An officer token (or any non-admin) must never grant admin access.
                return jsonify({"error": "forbidden"}), 403

            admin_id = claims.get("sub")
            if not admin_id:
                # A validly-signed token missing `sub` is malformed — don't let a None admin_id
                # flow into district-scoped queries/audit writes.
                return jsonify({"error": "invalid_token"}), 401

            district_id = metadata.get("district_id")
            g.admin_id = admin_id
            # A malformed claim (array/object/number) must not flow unchecked toward future
            # district-scoped queries/audit writes (code review 2026-07-09) — mirrors the
            # frontend's useAdminSession coercion of the same claim.
            g.district_id = district_id if isinstance(district_id, str) else None
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_ds_officer():
    """Guard Divisional Secretariat routes (Story 8.5, FR-10.4/10.5, NFR-3.2).

    A DS officer is scoped to ONE DS division — narrower than an officer's assigned_divisions
    list, and a level below require_admin()'s district. The three coexist deliberately: the DWC
    administrator oversees a district's pipeline, while the Divisional Secretariat authorises the
    payment for its own division. Adding this role does not widen or narrow either of the others.

    Mirrors require_admin()'s independent JWT validation and error-code conventions. The division
    is read from `app_metadata` only — reading it from client-writable `user_metadata` would let
    any authenticated citizen name their own division and read (and authorise payment on) another
    division's cases, the same escalation class resolved for `system_admin` on 2026-08-11.
    """
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            claims, error = authenticated_claims()
            if error:
                return error

            metadata = authz_metadata(claims)
            if authz_role(claims) != "ds_officer":
                return jsonify({"error": "forbidden"}), 403

            ds_officer_id = claims.get("sub")
            if not ds_officer_id:
                # A validly-signed token missing `sub` is malformed — don't let a None actor id
                # reach a payment-authorisation audit row.
                return jsonify({"error": "invalid_token"}), 401

            ds_division = metadata.get("ds_division")
            if not isinstance(ds_division, str) or not ds_division.strip():
                # Explicit 403 rather than falling through to `WHERE ds_division = NULL`, which
                # matches zero rows and is indistinguishable from "your division has no cases".
                # Same reasoning as admin.py's no_district_assigned (code review 2026-08-11).
                return jsonify({"error": "no_division_assigned"}), 403

            g.ds_officer_id = ds_officer_id
            g.ds_division = ds_division.strip()
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_research():
    """Guard the researcher-scoped export (Story 7.3, FR-7.3). Mirrors require_admin()'s
    independent JWT validation and error-code conventions.

    `system_admin` is introduced by this story (PO decision, OQ-A 2026-08-09). Authorization is
    the signature-verified JWT, so no migration is required for this guard to work: the `users`
    table is a durable mirror of Supabase's role claims, not the auth source — and its
    CHECK (role IN ('officer','admin')) means a system_admin simply has no `users` row today.

    RESOLVED 2026-08-11: this role was previously read from client-writable `user_metadata`,
    which meant any authenticated citizen could self-assign `system_admin` via
    `auth.updateUser()` and export the entire research corpus. It now comes from
    `app_metadata` (module docstring), closing the condition that gated a public HTTPS deploy.

    Deliberately does NOT set a district scope: research spans every district, unlike
    require_admin()'s g.district_id.
    """
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            claims, error = authenticated_claims()
            if error:
                return error

            if authz_role(claims) != "system_admin":
                # An officer or DISTRICT-admin token must never reach the research corpus:
                # unlike /admin/export it is not district-scoped, so a district admin would
                # otherwise read every district's data through this route.
                return jsonify({"error": "forbidden"}), 403

            researcher_id = claims.get("sub")
            if not researcher_id:
                # A validly-signed token missing `sub` is malformed — don't let a None actor_id
                # flow into the audit row for a bulk data egress.
                return jsonify({"error": "invalid_token"}), 401

            g.researcher_id = researcher_id
            return f(*args, **kwargs)

        return wrapper

    return decorator


def require_citizen():
    """Guard citizen-owned routes (Story 4.0). Mirrors require_officer()'s independent JWT
    validation, but a citizen is a plain authenticated Supabase user with NO staff role: any
    officer/admin token is rejected (403) so a staff `sub` is never treated as a citizen_id.
    Sets g.citizen_id from the signature-verified `sub`."""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            claims, error = authenticated_claims()
            if error:
                return error

            # Staff detection stays on the same authoritative claim. Reading it from
            # `user_metadata` here would let a staff member hide their role to be treated as a
            # citizen — the mirror image of the escalation, and it would attach their staff
            # `sub` to citizen-owned rows.
            if authz_role(claims) in ("officer", "admin", "system_admin", "ds_officer"):
                # A valid Supabase token, but staff — not a citizen. Never scope their cases here.
                return jsonify({"error": "forbidden"}), 403

            citizen_id = claims.get("sub")
            if not citizen_id:
                # A validly-signed token missing `sub` is malformed — don't let a None citizen_id
                # flow into ownership-keyed queries.
                return jsonify({"error": "invalid_token"}), 401

            g.citizen_id = citizen_id
            return f(*args, **kwargs)

        return wrapper

    return decorator
