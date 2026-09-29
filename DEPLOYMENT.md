# Azure Deployment Guide — HEC Platform

Deploying the HEC platform to Azure App Service with a custom domain registered at Namecheap.

Target domain: **`hecai.site`** (registered at Namecheap, no DNS records added yet). Every command
below is ready to copy and paste as-is — the only placeholders left are `<from backend/.env>` style
secret values and the certificate thumbprints in §8.

**Supersedes** `_bmad-output/planning-artifacts/render-deploy-checklist.md`, which targets
Render/Vercel and is stale (it says "21 migrations (002–022)"; the repo has 37, `002`–`038`). Do not
copy its numbers or its environment-variable list.

---

## 0. Target architecture

This is a **two-tier** application, so it needs **two** App Services. That is the single most
important thing to understand before starting.

```
                        Namecheap DNS (hecai.site)
                                    |
                    +---------------+---------------+
                    | ALIAS @        CNAME www      |
                    v                               v
        +---------------------------------------------------+
        |  App Service: hecai-frontend   (Node 20, Linux)   |
        |  Next.js 15 + React 19, next-intl (si/ta/en),      |
        |  serwist PWA service worker,                       |
        |  TF.js MobileNetV2 served from /public (8.8 MB)    |
        +---------------------------------------------------+
                    | browser fetch -> NEXT_PUBLIC_API_URL
                    v
        +---------------------------------------------------+
        |  App Service: hecai-backend    (Python 3.12)      |
        |  Flask 3 + gunicorn (gthread, 1 worker, 4 threads) |
        |  scikit-learn RF models (94 MB of .joblib)         |
        +---------------------------------------------------+
              |                    |                  |
              v                    v                  v
        Neon Postgres        Supabase Auth      Supabase Storage
        (unchanged)          (JWKS ES256)       (private bucket,
                                                 signed URLs)
```

| Decision | Choice | Why |
|---|---|---|
| Hosting | App Service **Linux**, code deploy | No Dockerfile exists in the repo; Oryx builds both tiers from source |
| Database | **Neon, unchanged** | Migrations 002–038 are already applied there; no migration in this deploy |
| Auth + storage | **Supabase, unchanged** | Only the redirect allowlists change |
| Tier | **Basic B1 × 2 separate plans** | F1 cannot serve TLS on a custom domain; separate plans avoid memory contention |
| Canonical host | `www.hecai.site` | Apex also bound and serving |

### Two code facts that dictate the deploy order

1. **`NEXT_PUBLIC_API_URL` is compiled into the frontend at build time**, not read at runtime. It is
   consumed in 19 files as `process.env.NEXT_PUBLIC_API_URL ?? ""`. The backend must therefore exist,
   and its URL must be an app setting, **before** the frontend is built.
   **⇒ Backend first, frontend second.** Reversed, the live site calls `localhost:5000`.
2. **CORS is already `origins: "*"`** (`backend/app/__init__.py:145`), so adding a new domain needs
   **no backend code change**. Login redirect URLs are likewise built from `window.location.origin`
   at runtime (`app/officer/login/page.tsx:84`, `app/admin/login/page.tsx:88`,
   `app/ds/login/page.tsx:82`) — no code change, but two external consoles must be updated (§6).

### Two secrets you must COPY, never regenerate

Both live in `backend/.env` (gitignored, local only):

- **`NIC_PEPPER`** — keys the HMAC behind the household-registry UNIQUE index (migration 024).
  A new value silently orphans **every registered household**. There is no recovery path, by design —
  a reversible one would defeat the pepper. Risk R-13.
- **`BANK_DETAILS_KEY`** — Fernet key for bank account numbers. A new key makes existing rows
  undecryptable, breaking the DS payment screen.

This is the highest-risk mistake in the whole process.

### Cost

Two B1 plans ≈ **$26/month**. The Azure free-trial credit expires 30 days after activation and the
Azure for Students grant is capped; after that B1 either bills or the apps stop. Set a calendar
reminder for the day after the viva and run the teardown in §10.4.

---

## 1. Prerequisites

### 1.1 Azure CLI login

**Account: the personal one (`janithrathnayake01@gmail.com`), which holds the $200 trial credit.**
Not the NSBM student account — that is a different identity with a different subscription, and
mixing them is how you end up deploying into the wrong place.

The personal subscription lives in tenant **`3e3ed3f1-918d-4fee-a986-a87fa1243a3a`** ("Default
Directory", created automatically with the trial). It **enforces MFA**, so a plain `az login` fails
with `AADSTS50076` and then misleadingly reports "No subscriptions found". Log in to the tenant
explicitly:

```powershell
az logout
az account clear
az login --tenant 3e3ed3f1-918d-4fee-a986-a87fa1243a3a
```

Complete the MFA prompt in the browser. If the browser silently reuses a different Microsoft account,
force an account picker instead:

```powershell
az login --tenant 3e3ed3f1-918d-4fee-a986-a87fa1243a3a --use-device-code
```

Then confirm and pin the subscription:

```powershell
az account show --query "{sub:name, id:id, user:user.name}" -o table
az account set --subscription "<subscription id from above>"
az group show -n hecapp-rg --query "{name:name, location:location}" -o table
```

`user` must read `janithrathnayake01@gmail.com`. If `hecapp-rg` is **not found**, the existing
`hecai-frontend` was created under the student account — recreate it here (§1.1a) rather than
switching accounts.

### 1.1a Creating the resources (this is the path that was taken)

On 2026-09-28 the personal subscription (`Azure subscription 1`,
`5c565f3d-8f56-44d5-a0fa-cc5d7c30e7bd`) was **completely empty** — the `hecapp-rg` and
`hecai-frontend` created earlier were under the student account. Everything was therefore built
fresh here. Southeast Asia is the closest region to Sri Lanka and matches the Singapore region
`render.yaml` used:

```powershell
az provider register --namespace Microsoft.Web --wait
az group create -n hecapp-rg -l southeastasia

az appservice plan create -g hecapp-rg -n hecai-frontend-plan --is-linux --sku B1
az appservice plan create -g hecapp-rg -n hecai-backend-plan  --is-linux --sku B1

az webapp create -g hecapp-rg -p hecai-frontend-plan -n hecai-frontend --runtime "NODE:22-lts"
az webapp create -g hecapp-rg -p hecai-backend-plan  -n hecai-backend  --runtime "PYTHON:3.12"
```

`Microsoft.Web` must be registered before the first App Service in a brand-new subscription.
App Service names are globally unique; check one with:

```powershell
az rest --method post `
  --url "https://management.azure.com/subscriptions/<sub-id>/providers/Microsoft.Web/checknameavailability?api-version=2023-12-01" `
  --body '{"name":"hecai-frontend","type":"Microsoft.Web/sites"}'
```

The orphaned student-account resources can be deleted later; they are empty and idle, so it is not
urgent — but do not deploy into them by accident.

### 1.2 Repo state

```powershell
cd "C:\Users\User\Desktop\final research\hec-platform"
git status --porcelain
git branch --show-current
```

Deployment packages are built with `git archive`, so **only committed files ship**. Commit anything
you need deployed.

### 1.3 Migration parity (read-only gate)

There is no migration runner and no `schema_migrations` table; `Flask-Migrate` and `alembic` are in
`requirements.txt` but unused. All 37 migrations (`002`–`038`, there is deliberately no `001`) are
already applied to Neon, and Azure points at that same database, so **this deploy applies none**.
Confirm before proceeding:

```powershell
cd backend
python -m scripts.check_migration_parity --strict
```

Exit 0 means repo and database agree. Non-zero means drift — resolve it first.

### 1.4 Values to have at hand

Open these locally. Do not commit them and do not paste their contents anywhere that leaves the machine.

- `backend/.env` → `DATABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `NIC_PEPPER`,
  `BANK_DETAILS_KEY`, `SMTP_*`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- `frontend/.env.local` → `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Two dead variables — do **not** carry them to Azure: `NEXT_PUBLIC_BACKEND_URL` (read by no code; the
live one is `NEXT_PUBLIC_API_URL`) and `BLOB_READ_WRITE_TOKEN` (removed from `render.yaml` on
2026-08-13, read by no code). `VERCEL_OIDC_TOKEN` is Vercel-only leftover.

---

## 2. Frontend App Service

Assumes resource group `hecapp-rg` and Web App `hecai-frontend` already exist. Verify three things:

```powershell
az webapp show -g hecapp-rg -n hecai-frontend `
  --query "{state:state, host:defaultHostName, runtime:siteConfig.linuxFxVersion, plan:appServicePlanId}" -o json

az appservice plan list -g hecapp-rg --query "[].{name:name, tier:sku.tier, sku:sku.name, linux:reserved}" -o table
```

1. **`linux: true`** on the plan. If `false`, delete and recreate with `--is-linux` — Windows App
   Service needs iisnode for Next.js and is not worth fighting.
2. **`runtime`** is `NODE|22-lts`. Fix with:
   `az webapp config set -g hecapp-rg -n hecai-frontend --linux-fx-version "NODE|22-lts"`
3. **Tier is Basic or higher.** Free **F1 cannot serve a TLS certificate on a custom domain**, which
   defeats the entire exercise: `az appservice plan update -g hecapp-rg -n <plan> --sku B1`

> **Node 22, not 20.** App Service has retired Node 20 — `az webapp list-runtimes --os-type linux`
> now offers only `NODE|22-lts`, `NODE|24-lts` and `NODE|26`, and a create with `NODE:20-lts` fails
> outright. 22-lts is the nearest LTS and matches the Node v22.22.3 used for local development.
>
> **This leaves a CI/production drift.** `.github/workflows/frontend-ci.yml` pins
> `node-version: "20"`, so CI now proves the build green on a version production does not run. This
> is the same class of drift `render.yaml` documents for Python ("production previously ran 3.14
> while every test ran on 3.12"). Bump the frontend CI matrix to 22 to close it — not required for
> the deploy to work, but it should not be left unnoticed.

Then:

```powershell
az webapp config set -g hecapp-rg -n hecai-frontend `
  --startup-file "npm run start -- -p 8080" `
  --always-on true `
  --min-tls-version 1.2 `
  --http20-enabled true

az webapp update -g hecapp-rg -n hecai-frontend --https-only true
```

**Why the explicit `-p 8080`:** the `start` script in `package.json` is bare `next start`, which
listens on 3000, while the Linux Node image's reverse proxy talks to 8080. Without the flag every
request returns 502.

---

## 3. Backend App Service

```powershell
az appservice plan create -g hecapp-rg -n hecai-backend-plan --is-linux --sku B1
az webapp create -g hecapp-rg -p hecai-backend-plan -n hecai-backend --runtime "PYTHON:3.12"
```

`hecai-backend` must be globally unique on `azurewebsites.net`; add a suffix if taken and use that
name throughout.

**A separate plan, not the frontend's.** `synthetic_crop_compensation_v1.joblib` is 80 MB on disk and
expands substantially when unpickled — `render.yaml` documents that memory pressure as the reason for
`--workers 1`. Sharing one 1.75 GB B1 with the Node process invites an OOM mid-demo.

**Python 3.12, not newer.** `render.yaml` records that production once ran 3.14 while every test ran
on 3.12, and that PR #35's numpy/scikit-learn wheel fix is pinned to 3.12.
`.github/workflows/backend-ci.yml` is the contract; raise both together or neither.

```powershell
az webapp config set -g hecapp-rg -n hecai-backend `
  --startup-file "gunicorn wsgi:app --worker-class gthread --workers 1 --threads 4 --timeout 120 --bind=0.0.0.0:8000" `
  --always-on true `
  --min-tls-version 1.2

az webapp update -g hecapp-rg -n hecai-backend --https-only true

az webapp config appsettings set -g hecapp-rg -n hecai-backend --settings `
  WEBSITES_CONTAINER_START_TIME_LIMIT=600 `
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

The gunicorn flags are copied verbatim from `render.yaml`. `gthread` with one worker is a memory
decision (one process, therefore one copy of the model); 4 threads is effectively the Neon connection
ceiling, since there is no pool; `--timeout 120` exists because the 30-second default produced Story
7.2's 502-on-export. **`backend-ci.yml` has an automated check that fails if `workers > 1` without
gthread.** Only `--bind=0.0.0.0:8000` is added, because that is the port the Azure Python image
proxies to.

`WEBSITES_CONTAINER_START_TIME_LIMIT=600` because unpickling ~94 MB of joblib on one B1 core can
exceed the 230-second default.

### 3.1 Backend app settings

```powershell
az webapp config appsettings set -g hecapp-rg -n hecai-backend --settings `
  FLASK_ENV=production `
  FLASK_DEBUG=false `
  DATABASE_URL="<from backend/.env, must include ?sslmode=require>" `
  SUPABASE_URL="https://tshaqbutrmrmruuedpel.supabase.co" `
  SUPABASE_JWT_SECRET="<from backend/.env>" `
  SUPABASE_SERVICE_ROLE_KEY="<from backend/.env>" `
  NIC_PEPPER="<COPY EXACTLY, never regenerate>" `
  BANK_DETAILS_KEY="<COPY EXACTLY, never regenerate>" `
  VAPID_PUBLIC_KEY="<from backend/.env>" `
  VAPID_PRIVATE_KEY="<from backend/.env>" `
  VAPID_SUBJECT="mailto:<your email>" `
  SMTP_HOST="<from backend/.env>" `
  SMTP_PORT="<from backend/.env>" `
  SMTP_USERNAME="<from backend/.env>" `
  SMTP_PASSWORD="<from backend/.env>" `
  SMTP_FROM_EMAIL="<from backend/.env>" `
  SMTP_FROM_NAME="HEC Platform"
```

- **`SUPABASE_URL` is required, not optional.** `app/__init__.py` derives the JWKS endpoint and the
  expected `iss` from it. Without it the auth guards fall back to legacy HS256 and **every
  authenticated request 401s**. It is not a secret — the browser bundle already ships it. It is also
  scheme-checked by `_https_url()`, so it must be `https://`.
- `SUPABASE_JWKS_URL` is an override. Leave it unset; the derived value is correct.
- **Do not set `PORT`** — App Service owns it.
- Neon over 5432 works from App Service. (A local "Neon is down" symptom was a home-network port
  block, not Neon.)

---

## 4. Deploy the backend

`git archive` is the correct packaging tool: it ships exactly the tracked files, so `venv/`,
`__pycache__/` and `.env` are excluded automatically, while `ml/models/*.joblib` — which *are* tracked
— are included.

```powershell
cd "C:\Users\User\Desktop\final research\hec-platform"
$out = "$env:TEMP\hec-backend.zip"
git archive --format=zip --output=$out HEAD:backend
az webapp deploy -g hecapp-rg -n hecai-backend --src-path $out --type zip
az webapp log tail -g hecapp-rg -n hecai-backend
```

Oryx runs `pip install -r requirements.txt`. **Expect 8–15 minutes** — scipy, scikit-learn, pandas
and numpy are large wheels on one B1 core.

> **`az webapp deploy` will probably print `ERROR: ... Status Code: 504, 504.0 GatewayTimeout`.**
> This is the CLI's client-side polling giving up, **not** a failed deployment — Oryx keeps building
> server-side. Do not redeploy in response to it. Check the real status instead:
>
> ```powershell
> az webapp log deployment list -g hecapp-rg -n hecai-backend `
>   --query "[0].{status:status, complete:complete, progress:progress}" -o json
> ```
>
> `"progress": "Running oryx build..."` with `"complete": false` means it is still working. Poll
> until `complete` is `true`, then probe the health endpoint. The app returns **503 throughout** the
> build, which is expected and not diagnostic.

### Gate: do not continue until this returns 200

```powershell
curl.exe https://hecai-backend.azurewebsites.net/api/v1/health
```

The frontend build bakes in the backend URL, so starting it while the backend is broken means
debugging two tiers at once.

---

## 5. Deploy the frontend

App settings **first** — `NEXT_PUBLIC_*` values are inlined during the Oryx build.

```powershell
az webapp config appsettings set -g hecapp-rg -n hecai-frontend --settings `
  SCM_DO_BUILD_DURING_DEPLOYMENT=true `
  NPM_CONFIG_PRODUCTION=false `
  NEXT_PUBLIC_SUPABASE_URL="https://tshaqbutrmrmruuedpel.supabase.co" `
  NEXT_PUBLIC_SUPABASE_ANON_KEY="<from frontend/.env.local>" `
  NEXT_PUBLIC_API_URL="https://hecai-backend.azurewebsites.net"
```

> **Do NOT set `NODE_ENV=production` on the frontend, and do set `NPM_CONFIG_PRODUCTION=false`.**
> With `NODE_ENV=production`, Oryx's `npm install` skips `devDependencies` — and `tailwindcss`,
> `postcss`, `autoprefixer` and `typescript` all live there while `next build` needs them. The build
> then runs for ~7 minutes and dies with:
>
> ```
> An error occurred in `next/font`.
> Error: Cannot find module 'tailwindcss'
> > Build failed because of webpack errors
> ```
>
> This does not show up in CI, because `frontend-ci.yml` runs `npm ci` with `NODE_ENV` unset.
> `next start` sets `NODE_ENV=production` itself at runtime, so the app setting buys nothing and
> only breaks the build.

> **`NEXT_PUBLIC_API_URL` must NOT include `/api/v1`.** The client libraries append it themselves —
> `lib/syncQueue.ts` builds `${API_BASE}/api/v1/sync/batch`. With the suffix, every API call 404s.
> `backend/scripts/e2e_smoke.ps1` sets this variable *with* the suffix for its own purposes; do not
> copy that value here.

Leave `NEXT_PUBLIC_ENABLE_RER7_HARNESS` unset — it gates the RER-7 measurement harness, and unset
makes `/rer7-harness` resolve to nothing in production.

```powershell
$out = "$env:TEMP\hec-frontend.zip"
git archive --format=zip --output=$out HEAD:frontend
az webapp deploy -g hecapp-rg -n hecai-frontend --src-path $out --type zip
az webapp log tail -g hecapp-rg -n hecai-frontend
```

Oryx runs `npm install` then `npm run build` (~5–10 min). Two expected build behaviours:

- `next.config.ts` **throws** if `public/models/mobilenetv2` is missing — deliberate, so offline AI is
  never silently shipped broken. Those files are tracked, so `git archive` includes them. This is the
  error you get if you ever package with `Compress-Archive` while excluding `public/`.
- serwist compiles `app/sw.ts` → `public/sw.js` during the build. `sw.js` is gitignored and absent
  from the zip; that is correct, it is generated rather than shipped.

> **Build the frontend on B3, not B1.** `next build` on B1 (1.75 GB) is **OOM-killed** during
> "Collecting build traces" — the last step of the build. The failure is silent: the log simply
> stops mid-line, with no error, no exit code and `Errors (0)` in the Oryx summary, because the
> kernel kills the process rather than letting it report. Next.js's trace collector walks the whole
> dependency graph, and this project installs 838 packages including `@tensorflow/tfjs`.
>
> Scale up for the build, then straight back down — B3 is billed hourly, so this costs cents:
>
> ```powershell
> az appservice plan update -g hecapp-rg -n hecai-frontend-plan --sku B3   # 7 GB, before deploying
> # ... deploy ...
> az appservice plan update -g hecapp-rg -n hecai-frontend-plan --sku B1   # back down, after it works
> ```
>
> B1 is fine for *running* the built app; it is only the build that needs the headroom. The B3 pass
> is also much faster — on B1 the build took 25 minutes before dying.

Verify on the Azure hostname before touching DNS — `https://hecai-frontend.azurewebsites.net` should
307 to `/si` (default locale per `routing.ts`).

---

## 6. Auth consoles (before testing any login)

### 6.1 Supabase

Dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://www.hecai.site`
- **Redirect URLs:** `https://www.hecai.site/**`, `https://hecai.site/**`,
  `https://hecai-frontend.azurewebsites.net/**`, and keep `http://localhost:3000/**` for local dev

This matters more than it looks. `middleware.ts` carries an explicit workaround: because Supabase
allowlists only the site root, emailed sign-in links return to `/?code=<uuid>` rather than
`/auth/callback`, and the middleware forwards the code manually. If Site URL still points at
localhost, citizen email sign-in fails on the live domain with no visible error.

Also confirm the project is **not paused** — free-tier auto-pause presents as NXDOMAIN, not an outage.

### 6.2 Google Cloud Console

Staff sign-in uses Google OAuth, so Supabase alone is not enough. **APIs & Services → Credentials →
your OAuth 2.0 Client ID**:

- **Authorised JavaScript origins:** add `https://www.hecai.site` and `https://hecai.site`
- **Authorised redirect URIs:** `https://tshaqbutrmrmruuedpel.supabase.co/auth/v1/callback` should
  already be present; leave it

Missing this gives Google's `redirect_uri_mismatch` page on officer/admin/DS login — it looks like a
broken deploy but is purely a console setting.

---

## 7. Namecheap DNS

### 7.1 Values Azure needs

```powershell
az webapp show -g hecapp-rg -n hecai-frontend --query customDomainVerificationId -o tsv
az webapp show -g hecapp-rg -n hecai-frontend --query inboundIpAddress -o tsv
```

For this subscription the verification ID is:

```
B5D9545F86820BF7BB04C92D9FA27FBA5B41E6C85717C3A00F55644E0B22CE43
```

It is the same for the apex and `www` (and for `hecai-backend`, should §10.1 be done later). It is
not a secret — it is published in public DNS. It changes only if the app is deleted and recreated.

`inboundIpAddress` returns empty until the first custom hostname is bound; it is only needed as the
`A`-record fallback if Namecheap's ALIAS type is unavailable, so fetch it then if required.

### 7.2 Records

Namecheap → **Domain List** → **Manage** → **Advanced DNS**.

**Nameservers are already correct** — verified 2026-09-28, `hecai.site` delegates to
`dns1.registrar-servers.com` / `dns2.registrar-servers.com`, which is Namecheap BasicDNS. ALIAS records
are therefore available and no nameserver change is needed.

**Delete these two existing parking records first** (also verified 2026-09-28):

| Type | Host | Current value | Action |
|---|---|---|---|
| `A` | `@` | `162.255.119.223` (Namecheap parking) | **Delete** |
| `CNAME` | `www` | `parkingpage.namecheap.com` | **Delete** |

Leaving either in place means the apex or `www` keeps resolving to the parking page, and Azure's
hostname binding will fail its ownership check. Then add:

| Type | Host | Value | TTL |
|---|---|---|---|
| `TXT` | `asuid` | *(customDomainVerificationId)* | 1 min |
| `TXT` | `asuid.www` | *(same ID)* | 1 min |
| `ALIAS` | `@` | `hecai-frontend.azurewebsites.net` | 1 min |
| `CNAME` | `www` | `hecai-frontend.azurewebsites.net` | 1 min |

- The `asuid` TXT records prove ownership; Azure refuses to bind a hostname without them.
- **`ALIAS`** is how Namecheap supports CNAME-like behaviour at the apex (a literal CNAME on `@` is
  illegal in DNS). If ALIAS is absent from the dropdown, use an **`A` record** on `@` pointing at
  `inboundIpAddress` — it works, but that IP changes if the app is deleted and recreated, so ALIAS is
  preferred.
- Keep TTL at 1 minute while setting up; raise to Automatic once everything works.

### 7.3 Verify propagation before continuing

```powershell
nslookup -type=TXT asuid.hecai.site 8.8.8.8
nslookup -type=TXT asuid.www.hecai.site 8.8.8.8
nslookup www.hecai.site 8.8.8.8
nslookup hecai.site 8.8.8.8
```

Usually 5–30 minutes. A premature bind attempt fails ambiguously — you will not know whether the
record or the command was wrong.

---

## 8. Bind hostnames and issue free TLS

Strictly ordered: binding must succeed before a certificate can be issued.

```powershell
az webapp config hostname add -g hecapp-rg --webapp-name hecai-frontend --hostname www.hecai.site
az webapp config hostname add -g hecapp-rg --webapp-name hecai-frontend --hostname hecai.site

az webapp config ssl create -g hecapp-rg --name hecai-frontend --hostname www.hecai.site
az webapp config ssl create -g hecapp-rg --name hecai-frontend --hostname hecai.site

az webapp config ssl list -g hecapp-rg --query "[].{name:name, thumbprint:thumbprint}" -o table

az webapp config ssl bind -g hecapp-rg --name hecai-frontend `
  --certificate-thumbprint <www-thumbprint> --ssl-type SNI
az webapp config ssl bind -g hecapp-rg --name hecai-frontend `
  --certificate-thumbprint <apex-thumbprint> --ssl-type SNI
```

App Service Managed Certificates are free, valid 6 months and auto-renewing. They require **Basic
tier or above** (the concrete reason F1 was rejected in §2) and do not support wildcards — fine here,
since two specific hostnames are bound.

```powershell
curl.exe -I https://www.hecai.site
curl.exe -I https://hecai.site
```

Both should return 200 or 307 with no certificate warning.

---

## 9. Rebuild the frontend against the final domain

```powershell
az webapp deploy -g hecapp-rg -n hecai-frontend --src-path "$env:TEMP\hec-frontend.zip" --type zip
```

**Standing rule:** any change to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL` or
`NEXT_PUBLIC_SUPABASE_ANON_KEY` requires a **redeploy**, not just an app-setting change and restart.
A restart leaves the old value compiled into the JavaScript.

---

## 10. Optional, after the above is proven working

### 10.1 `api.hecai.site`

1. Namecheap: `TXT asuid.api` = the `customDomainVerificationId` of `hecai-backend` (different from
   the frontend's), and `CNAME api` → `hecai-backend.azurewebsites.net`
2. `az webapp config hostname add --webapp-name hecai-backend --hostname api.hecai.site`
3. `ssl create` + `ssl bind` as in §8
4. Set `NEXT_PUBLIC_API_URL=https://api.hecai.site` **and redeploy the frontend**

No CORS change needed.

### 10.2 Apex → www redirect

After §8 both hostnames serve the site directly and everything works; this only makes `www`
canonical. It requires a code change in `frontend/middleware.ts` — inserted as the **first**
statement of `middleware()`, before the RER-7 block:

```ts
const host = request.headers.get("host");
if (host === "hecai.site") {
  const url = new URL(request.url);
  url.host = "www.hecai.site";
  return NextResponse.redirect(url, 308);
}
```

It must run ahead of the `/auth/callback` bypass and the locale handling, or an OAuth `?code` could be
consumed on the wrong host. Requires a redeploy. **Leave this last:** `middleware.ts` gates every
authenticated route and already carries two hard-won fixes (the `/ds` 404 and the dropped `?code`).

### 10.3 Tighten CORS

`backend/app/__init__.py:145` uses `origins: "*"` and its own comment says "tighten in production via
environment variable" — but no such variable exists. With a real production origin now available,
read `CORS_ORIGINS` from the environment, defaulting to `"*"` so tests and local dev are unaffected.
A genuine security improvement, not required for the deploy, and worth a line in the thesis's
future-work section either way.

### 10.4 Teardown

```powershell
# stop billing, keep everything
az webapp stop -g hecapp-rg -n hecai-frontend
az webapp stop -g hecapp-rg -n hecai-backend

# or delete it all (irreversible)
az group delete -n hecapp-rg --yes
```

Neon and Supabase are untouched by either.

---

## 11. Verification checklist

**Infrastructure**

1. `curl.exe https://hecai-backend.azurewebsites.net/api/v1/health` → 200
2. `https://hecai-frontend.azurewebsites.net` → 307 to `/si`
3. `curl.exe -I https://www.hecai.site` and `https://hecai.site` → 200/307, valid cert
4. `az webapp log tail` on both apps shows no repeating exceptions

**Application** (demo accounts are in `DEMO-WORKFLOW.md`)

5. Language switcher si → ta → en, all render
6. Citizen email sign-in lands signed in (exercises the §6.1 path)
7. Citizen submits a report **with a photo**; it reaches the server and renders from the signed URL
8. Officer signs in at `/officer/login`, opens a case, runs classification. First load pulls 8.8 MB of
   TF.js shards; then airplane-mode and reload to prove the PWA precache
9. Officer submits a face or non-damage photo — the open-set gate rejects it rather than returning
   "property damage 94%"
10. DS signs in at `/ds/login`, opens a payable case, completes the payment flow
11. Admin at `/admin/login` exports CSV with the date-stamped filename (proves the
    `Content-Disposition` expose-headers path survived the domain change)
12. Notification bell populates; push notification arrives (VAPID needs HTTPS, so real domain only)
13. On a phone: "Add to Home Screen" installs the PWA

**Regression**

14. `cd frontend; npm test` and `cd backend; pytest` still pass — nothing here requires a code change
    except the optional §10.2 redirect

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Frontend 502 / "Application Error" | `next start` on :3000, proxy expects :8080 | Startup command `npm run start -- -p 8080` (§2) |
| Backend 502 on every route | gunicorn not bound to :8000 | Add `--bind=0.0.0.0:8000` (§3) |
| Build fails: `public/models/mobilenetv2 is missing` | Packaged without `public/` | Use `git archive` (§5) |
| Every authenticated request 401s | `SUPABASE_URL` unset → HS256 fallback | Set `SUPABASE_URL` (§3.1) |
| Every API call 404s | `NEXT_PUBLIC_API_URL` includes `/api/v1` | Strip the suffix, redeploy (§5) |
| API calls go to `localhost:5000` | `NEXT_PUBLIC_API_URL` set after the build | Redeploy the frontend (§9) |
| 500 `server_misconfigured` on registration | `NIC_PEPPER` missing | Set it — copied, not generated (§3.1) |
| Households look new / duplicate claims allowed | `NIC_PEPPER` **changed** | Restore the original. Digests are not re-derivable. |
| DS payment screen errors on bank details | `BANK_DETAILS_KEY` missing or changed | Restore the original (§3.1) |
| Staff provisioning returns 503 | `SUPABASE_SERVICE_ROLE_KEY` unset | Set it (§3.1) |
| Google login: `redirect_uri_mismatch` | Domain not in the OAuth client | Add JS origins (§6.2) |
| `hostname add`: "cannot verify ownership" | `asuid` TXT not propagated | Recheck §7.3, wait longer |
| `ssl create` fails | Hostname not bound, or plan is F1 | Bind first; upgrade to B1 (§2, §8) |
| `az webapp deploy` returns 504 GatewayTimeout | CLI polling timed out; Oryx is still building | Not a failure. Poll `az webapp log deployment list` until `complete: true` (§4) |
| Backend returns 503 during/after deploy | Build still running, or container still starting | Expected during the build; if it persists after `complete: true`, check `az webapp log tail` |
| `NODE:20-lts` rejected at create time | Node 20 retired from App Service | Use `NODE:22-lts` (§2) |
| Backend cold start times out | 94 MB of joblib on one B1 core | `WEBSITES_CONTAINER_START_TIME_LIMIT=600` + always-on (§3) |
| Backend OOM / random restarts | Both tiers sharing one B1 plan | Separate plans (§3) |
| DB connection refused | Missing `?sslmode=require`, or project paused | Fix the string; un-pause (§3.1, §6.1) |
| CSV export uses the fallback filename | `expose_headers` missing | Already correct in `app/__init__.py:145`; check for a proxy stripping headers |
| Push notifications silent | VAPID keys unset, or tested over HTTP | Set both keys; test on the HTTPS domain (§3.1) |
| Build log stops dead at `Collecting build traces`, `Errors (0)`, deploy marked failed | OOM kill on B1 (1.75 GB) | Scale plan to B3, redeploy, scale back to B1 (§5) |
| Managed cert creation never produces a certificate | App is 503, so HTTP validation cannot complete | Get the app serving first, then issue certs (§8) |
| Frontend build fails: `Cannot find module 'tailwindcss'` | `NODE_ENV=production` made npm skip devDependencies | Delete `NODE_ENV`, set `NPM_CONFIG_PRODUCTION=false`, redeploy (§5) |
| `npm install` fails on `@supabase/server` | Stray dependency in `package.json` | Resolves from `package-lock.json` today; if Oryx fails, check whether any code imports it and remove it if not |

---

## 13. Documentation follow-up

The thesis currently documents a Render/Vercel topology (`backend/render.yaml`, `VERCEL_OIDC_TOKEN`,
and `Figure4-5-deployment.png`). If the submission claims Azure, **Figure 4-5 and the deployment
section need updating** to the two-App-Service diagram in §0. `render.yaml` itself should stay in the
repo — it documents the gunicorn reasoning that the Azure startup command inherits.
