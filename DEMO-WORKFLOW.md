# HEC Platform — Demo මාර්ගෝපදේශය

**2026-09-28 දින සජීවී පද්ධතියෙන් සත්‍යාපනය කරන ලදී.** මෙහි ඇති සෑම URL එකක්ම, බොත්තමක්ම සහ අංකයක්ම
ඇත්තටම browser එකෙන් පරීක්ෂා කර ඇත.

> 🆕 **2026-09-28 වෙනස්කම් දෙක** — දෙකම demo එකේ පේනවා:
> 1. **සාක්ෂි ඡායාරූප** — පවුලේ සහ නිලධාරියාගේ ඡායාරූප දැන් case එකට අමුණනවා, සහ
>    officer/admin/DS තුන්දෙනාටම පේනවා (§3.3, §4, §5, §6).
> 2. **Open-set gate** — හානි ඡායාරූපයක් නොවන එකක් දැම්මොත් දැන් `No Damage`, වන්දියක් නෑ (§4).

---

## 0 · පටන් ගන්න කලින්

### ⚠️ WARP VPN එක **ON** විය යුතුයි

මේ network එකෙන් port 5432 (PostgreSQL) block වෙනවා. WARP නැතුව database එක සම්බන්ධ වෙන්නේ නෑ, සහ
**හැම screen එකක්ම හිස්ව පේනවා.** Demo එකට කලින් ඒක තහවුරු කරගන්න.

### Servers දෙක

| | Command | URL |
|---|---|---|
| Backend (Flask) | `cd hec-platform/backend` → `./venv/Scripts/python.exe -m flask --app wsgi run --port 5000` | `http://localhost:5000` |
| Frontend (Next.js) | `cd hec-platform/frontend` → `npm run dev` | **`http://localhost:3000`** |

> **වැදගත්:** පරණ server process එකක් port එක අල්ලාගෙන ඉන්නවා නම් අලුත් එක start වෙන්නේ නෑ, ඒත් error
> එකක් පෙන්නන්නේත් නෑ. සැකයක් නම් PowerShell එකෙන්:
> `Get-NetTCPConnection -LocalPort 5000 -State Listen`

### දෙකම වැඩද කියලා බලන්න

```
http://localhost:5000/api/v1/health      →  200
http://localhost:3000/en/login           →  login page එක පේනවා
```

---

## 1 · පද්ධතිය ප්‍රදේශය අනුව බෙදෙන්නේ කොහොමද

මේක supervisorට පැහැදිලි කරන්න වැදගත්ම කරුණු වලින් එකක්.

### දාමය

```
පුරවැසියා පවුල register කරනවා
        ↓  දිස්ත්‍රික්කය + ප්‍රාදේශීය ලේකම් කොට්ඨාසය තෝරනවා
        ↓     (උදා:  අනුරාධපුරය  /  ගල්නැව)
        ↓
පුරවැසියා සිද්ධියක් report කරනවා
        ↓  ⚠️ report එකේදී ප්‍රදේශය අහන්නේ නෑ —
        ↓     ඒක ස්වයංක්‍රීයව පවුලෙන් copy වෙනවා  (cases.py:143-145)
        ↓
case එකට district + ds_division_id ලැබෙනවා
        ↓
මේ ප්‍රදේශය අයිති නිලධාරීන්ට case එක පේනවා
```

**ප්‍රධාන කරුණ:** නිලධාරියෙක් තමන්ගේ ප්‍රදේශය **තෝරන්නේ නෑ**. ඒක එයාගේ account එකේ (JWT token එකේ)
අත්සන් කරලා තියෙනවා, සහ server එක ඒක token එකෙන් **විතරක්** කියවනවා — කිසිම request එකකින් නෙවෙයි.
ඒ කියන්නේ නිලධාරියෙකුට URL එක වෙනස් කරලා වෙන ප්‍රදේශයක case බලන්න **බෑ**.

### Role එකින් එකට

| Role | Scope | Database query | දකින්නේ |
|---|---|---|---|
| **DS Officer** | කොට්ඨාසය **එකයි** | `WHERE ds_division_id = %s` | ගල්නැව → **29** |
| **DWC Officer** | පවරපු කොට්ඨාස (එකක් හෝ කිහිපයක්) | `WHERE ds_division_id = ANY(%s)` | ගල්නැව → **29** |
| **DWC Admin** | **දිස්ත්‍රික්කය මුළුමනින්ම** | `WHERE district = %s` | අනුරාධපුරය → **40** |
| **System Admin** | ප්‍රදේශයක් නෑ | — | cases නෑ; users විතරයි |

### සජීවී සාක්ෂිය

අනුරාධපුරය දිස්ත්‍රික්කයේ කොට්ඨාස **11ක්**, cases **40ක්**:

```
අනුරාධපුරය
    ගල්නැව         29        ← DS සහ Officer දකින්නේ මේක විතරයි
    ඉපලෝගම          2
    තඹුත්තේගම       1
    කැකිරාව          1
    ... තව කොට්ඨාස 7ක්
    ─────────────────
    එකතුව          40        ← Admin දකින්නේ මේ ඔක්කොම
```

**හොඳම නිරූපණය:** officer දෙන්නෙක් සංසන්දනය කරන්න —

| Account | Scope | Cases |
|---|---|---|
| `e2e-officer@hec-e2e.lk` | ගල්නැව | **29** |
| `e2e-officer-other@hec-e2e.lk` | අම්බලන්තොට | **4** |

එකම screen එක, එකම code එක, **සම්පූර්ණයෙන් වෙනස් data**. Supervisorට මේක පෙන්නුවොත් scoping එක
ක්‍රියාත්මකයි කියලා එකපාරම තේරෙනවා.

### ⚠️ ගල්නැව කියන්නේ උදාහරණයක් විතරයි

Demo එකේ ගල්නැව නිතර එනවා — **ඒක demo data එක එතන හදලා තියෙන නිසා විතරයි.** පද්ධතිය ශ්‍රී ලංකාවේ
**මුළු HEC ප්‍රදේශයටම** වැඩ කරනවා.

පුරවැසියෙකුට registration එකේදී තෝරන්න පුළුවන්:

```
දිස්ත්‍රික්ක   20
කොට්ඨාස      167
```

| දිස්ත්‍රික්කය | කොට්ඨාස | | දිස්ත්‍රික්කය | කොට්ඨාස |
|---|---:|---|---|---:|
| අනුරාධපුරය | 24 | | මාතලේ | 10 |
| අම්පාර | 23 | | පුත්තලම | 9 |
| කුරුණෑගල | 14 | | පොළොන්නරුව | 8 |
| මඩකලපුව | 13 | | හම්බන්තොට | 7 |
| ත්‍රිකුණාමලය | 12 | | බදුල්ල | 6 |
| මොණරාගල | 12 | | රත්නපුර · වව්නියාව | 5 · 5 |
| මහනුවර | 4 | | යාපනය · කිළිනොච්චිය · මන්නාරම් · මුලතිව් | 3 බැගින් |
| නුවරඑලිය | 2 | | කුරුණැගල | 1 |

**ගල්නැව කියන්නේ අනුරාධපුරයේ කොට්ඨාස 24න් එකක් විතරයි.**

### ප්‍රදේශයක නමක් code එකේ තියෙනවද? **නෑ**

මුළු repository එකම scan කළා:

```
backend/app/     →  කිසිම ප්‍රදේශයක නමක් නෑ
frontend code    →  නෑ
```

ප්‍රදේශ නම් තියෙන්නේ **data එකේ විතරයි**, code එකේ නෙවෙයි:

| තැන | මොකක්ද |
|---|---|
| `district_reference.json` | දිස්ත්‍රික්ක 20 / කොට්ඨාස 167 — picker එකට |
| `compensation_prior_year_lookup.json` | model එකේ lookup (හැම කොට්ඨාසයකටම) |
| `scripts/data/officer-app-metadata.json` | **demo නිලධාරියාට ප්‍රදේශය පවරන seed file එක** |
| tests | fixtures |

Query එක `WHERE ds_division_id = ANY(%s)` — ඒ `%s` එකට එන්නේ ඒ නිලධාරියාගේ token එකේ තියෙන දේ,
ඒක මොකක් වුණත්. **වෙනත් ප්‍රදේශයක නිලධාරියෙක් හදන්නේ System Admin screen එකෙන් ප්‍රදේශය පවරලා —
code එකට අත ගහන්නේ නෑ.**

### 💡 Supervisor "වෙන ප්‍රදේශයකට වැඩ කරනවද?" කියලා ඇහුවොත් — විනාඩි 2

**ක්‍රමය 1 — ඉක්මන්ම (accounts දෙකක්):**

1. `e2e-officer-other@hec-e2e.lk` / `HecE2E!2026` → `/officer/login`
2. **අම්බලන්තොට** cases **4** පේනවා — ගල්නැව එකක්වත් නෑ
3. Sign out → `e2e-officer@hec-e2e.lk` → **ගල්නැව** cases **29**

එකම screen, එකම code, එකම query. වෙනස් වෙන්නේ token එකේ ප්‍රදේශය විතරයි.

**ක්‍රමය 2 — වඩාත් ප්‍රබලයි (scoping එකේ ඇත්ත පරීක්ෂාව):**

අලුත් පවුලක් **`පොළොන්නරුව / හිගුරක්ගොඩ`** වලින් register කරලා report එකක් දාන්න.
ඒ case එක **ගල්නැව officerට පේන්නේම නෑ** — ඒත් `පොළොන්නරුව` admin කෙනෙක් ඉන්නවා නම් එයාට පේනවා.

### 🗺️ Staff Coverage Map — කොයි ප්‍රදේශ ක්‍රියාත්මකද

*(2026-09-25 සජීවී දත්ත)*

Case එකක් **සම්පූර්ණයෙන් process කරන්න නම් තුන්දෙනාම ඕන:**

| ඕන කෙනා | නැත්නම් කරන්න බැරි දේ |
|---|---|
| **DWC Officer** (කොට්ඨාසය) | ක්ෂේත්‍රයට ගිහින් **check** කරන එක · photo එකෙන් **classify** කරන එක · **estimate** එක හදන එක |
| **DWC Admin** (දිස්ත්‍රික්කය) | පරීක්ෂා කරලා **approve** කරන එක · මුදල නිර්දේශ කරන එක |
| **DS Officer** (කොට්ඨාසය) | **අවසන් මුදල** තීරණය කරන එක · **ගෙවන** එක |

```
cases එකතුව                      77
  officer කෙනෙක් ඉන්නවා          33
  admin කෙනෙක් ඉන්නවා            40
  DS officer කෙනෙක් ඉන්නවා       29
  ────────────────────────────────────
  තුන්දෙනාම ඉන්නවා (end-to-end)  29      ← 38%
```

| දිස්ත්‍රික්කය | Admin | තත්ත්වය |
|---|:---:|---|
| **අනුරාධපුරය** | ✅ | **ගල්නැව සම්පූර්ණයි (cases 29)**. අනිත් කොට්ඨාස 10ට officer/DS නෑ (cases 11) |
| **පොළොන්නරුව** | ❌ | කොට්ඨාස 7, cases 12 — කවුරුවත් නෑ |
| **මොණරාගල** | ❌ | කොට්ඨාස 11, cases 12 — කවුරුවත් නෑ |
| **හම්බන්තොට** | ❌ | අම්බලන්තොට ට officer ✅, ඒත් **admin නෑ** → approve කරන්න බෑ |

### හරියටම කොහෙද නතර වෙන්නේ

```
අම්බලන්තොට  →  Officer ✅  →  classify ✅  estimate ✅
                    ↓
                Admin ❌     →  🛑 approve කරන්න කෙනෙක් නෑ

ඉපලෝගම     →  Officer ❌   →  🛑 classify කරන්න කෙනෙක් නෑ
                                (Admin ✅ ඉන්නවා — case එක පේනවා,
                                 ඒත් AI result එකක් නැතුව approve කරන්නේ මොකද?)

වැලිකන්ද    →  තුන්දෙනාම ❌  →  🛑 report එක ගිහින් එතනම තියෙනවා
```

### ⚠️ ඒත් දත්ත නැති වෙන්නේ නෑ — මේක rollout තත්ත්වයක්

- පුරවැසියෙක් **ඕනෑම කොට්ඨාසයකින්** report කරන්න පුළුවන් — **දැන්මම**
- Case එක නිවැරදි කොට්ඨාසයට ලේබල් වෙලා, database එකේ ආරක්ෂිතව තියෙනවා
- `/en/status?ref=…` එකෙන් පුරවැසියාට තත්ත්වය බලාගන්න පුළුවන් — login එකක්වත් නැතුව
- **නිලධාරියෙක් හදන දවසේ** ඒ ඉතිහාසය ඔක්කොම එයාට පේනවා — **bell එකේ පරණ notification ඇතුළුව**
  (feed එක බලන්නේ scope එක විතරයි, account එක හදපු දිනය නෙවෙයි)

### 💡 Supervisor "අනිත් ප්‍රදේශ වලට මොකද?" කියලා ඇහුවොත්

**මේ table එකම පෙන්නන්න.** ඒක සඟවන්න දෙයක් නෙවෙයි — **ක්‍රමයෙන් ව්‍යාප්ත වෙන ක්‍රමයක්
(incremental rollout)** කියලා පෙන්නනවා:

> ගල්නැව වලින් pilot එකක් පටන් අරන්, කොට්ඨාසය කොට්ඨාසය ව්‍යාප්ත කරන්න පුළුවන් — **දත්ත නැති නොවී**.
> අලුත් කොට්ඨාසයක් ක්‍රියාත්මක කරන්නේ **System Admin screen එකෙන් විනාඩි 2කින්**
> (`/system/users` → account → role + ප්‍රදේශය). **Code එකට අත ගහන්නේ නෑ.**

**Demo එකට ගල්නැව පාවිච්චි කරන්න** — end-to-end සම්පූර්ණයෙන් වැඩ කරන එකම කොට්ඨාසය ඒක.

---

## 2 · Demo Accounts

සියලුම staff accounts වල password: **`HecE2E!2026`**

| Role | Email | Login URL | Scope |
|---|---|---|---|
| DWC Officer | `e2e-officer@hec-e2e.lk` | `/officer/login` | ගල්නැව |
| DWC Officer (වෙනත්) | `e2e-officer-other@hec-e2e.lk` | `/officer/login` | අම්බලන්තොට |
| DWC Admin | `e2e-admin@hec-e2e.lk` | `/admin/login` | අනුරාධපුරය |
| DS Officer | `e2e-ds@hec-e2e.lk` | `/ds/login` | ගල්නැව |
| System Admin | `janithmanujaya1@gmail.com` | `/system/login` | — |

> ⚠️ **System Admin** එකේ password එක ඔයාගේ Google account එකේ එක — මම ඒක දන්නේ නෑ. **Demo එකට කලින්
> එක පාරක් sign in වෙලා බලන්න.** Google button එකත් තියෙනවා.

පුරවැසි accounts (password: **`SusTest!2026`**): `sus-p1a@hec-e2e.lk`, `sus-p2a@hec-e2e.lk`,
`sus-p3a@hec-e2e.lk` — තුන්දෙනාටම පවුල් register කරලා තියෙනවා.

---

## 3 · පුරවැසියා (Citizen)

### 3.1 අලුත් account එකක් හදන එක

```
http://localhost:3000/en/login
```

1. **"Create an account"** ඔබන්න
2. Email එකක් දෙන්න (ඇත්ත එකක් — confirmation යනවා)
3. Password එකක් **තමන්ම හදාගන්න** (අකුරු 8කට වඩා), දෙපාරක් type කරන්න
4. **"Create account"** ඔබන්න

> Google sign-in එකක් පුරවැසියන්ට නෑ — ඒක design එකක්. පවුලේ වැඩිහිටියෙකුට Google account එකක්
> නැතුවත් පද්ධතිය පාවිච්චි කරන්න පුළුවන් වෙන්න ඕන.

**භාෂාව මාරු කරන්න:** URL එකේ `/en/` කියන එක `/si/` හෝ `/ta/` කියලා වෙනස් කරන්න.
`http://localhost:3000/si/login`

### 3.2 පවුල register කරන එක

```
http://localhost:3000/en/register
```

අවශ්‍ය දේවල්:
- ලියාපදිංචි කරන්නාගේ **නම** සහ **ජා.හැ. අංකය**
- පවුලේ සාමාජිකයන් (නම + ජා.හැ.)
- **දිස්ත්‍රික්කය** සහ **කොට්ඨාසය** ← **මෙතනදී තමයි ප්‍රදේශය තීරණය වෙන්නේ**
- **ලිපිනය** (අනිවාර්යයි)
- Contact email (notification යන තැන)
- බැංකු විස්තර (අත්‍යවශ්‍ය නෑ)

**Demo එකට:** `අනුරාධපුරය` / `ගල්නැව` දාන්න — එතකොට demo staff accounts වලට case එක පේනවා.

> 💡 **පෙන්නන්න වටිනා දෙයක්:** ලියාපදිංචි වුණ ජා.හැ. අංකයක් ආයෙත් register කරන්න try කරන්න.
> පද්ධතිය ප්‍රතික්ෂේප කරලා *"Your family is already registered"* කියනවා. **ඒක FR-10.2 duplicate-claim
> control එක** — එකම පවුලට දෙපාරක් වන්දි ගන්න බැරි වෙන්න.

### 3.3 සිද්ධියක් report කරන එක

```
http://localhost:3000/en/report
```

පියවර 4යි:

| # | Screen | කරන්නේ |
|---|---|---|
| 1 | **Family** | පවුල තහවුරු කරනවා (ජා.හැ. ආයෙත් අහන්නේ නෑ) |
| 2 | **Location** | GPS ස්වයංක්‍රීයව (තත්පර 10) → **map එකේ pin එක පේනවා, හදන්නත් පුළුවන්** |
| 3 | **Damage** | බෝග / දේපළ / දෙකම |
| 4 | **Photos** | photo 1–10 — **දැන් මේවා case එකට upload වෙනවා** 🆕 |

**"Submit Report"** → **Proof of Claim** එකක් එනවා, HEC යොමු අංකය එක්ක.

> ⏱️ Submit වෙන්න **තත්පර 10-12ක්** යනවා (Neon database එක us-east-1 එකේ + VPN). ඒක normal.
> PoC screen එක යොමු අංකය එනකම් බලාගෙන ඉන්නවා — Download/Share buttons ඒ වෙනකම් disable වෙලා.

> 🆕 **ඡායාරූප දැන් නිලධාරීන්ට පේනවා (2026-09-28).**
> කලින් පවුලේ ඡායාරූප දුරකථනයේම තිබුණා — server එකට **කවදාවත් ආවේ නෑ**. ඒ නිසා admin approve
> කරලා, DS ගෙවලා තිබුණේ **class label එකක් සහ ප්‍රතිශතයක් මත විතරයි**. දැන් ඒවා case එකට
> අමුණනවා, සහ officer/admin/DS තුන්දෙනාටම පේනවා.
>
> **වැදගත්:** citizen කිසිම බොත්තමක් ඔබන්නේ නෑ. **Report එක sync වුණාට පස්සේ වහාම** ඡායාරූප
> තනියම යනවා (offline queue එකක් — case එකක් නැතුව ඡායාරූපයක් අමුණන්න බෑ, ඒ නිසා පිළිවෙල එයයි).
> Internet නැති තැනක report කරොත්, connection එක ආපු ගමන් යනවා.
> ප්‍රායෝගිකව: **PoC යොමු අංකය තිරයේ පේනකම් ඉන්න** (තත්පර 10–12) — ඒ වෙනකොට ඡායාරූපත් ගිහින්.
> 2026-09-28 මැනපු එක: photo 2ක් → sync → **201, 201**.

### 3.4 තත්ත්වය බලන එක

```
http://localhost:3000/en/my-cases          ← login එකක් එක්ක
http://localhost:3000/en/status?ref=HEC-2026-0288   ← login එකක් නැතුව
```

දෙවැන්න වැදගත්: **login එකක්, permission එකක්, email එකක් ඕන නෑ.** PoC එකේ යොමු අංකය ඇති. දුරකථනය
නැති වුණත් තත්ත්වය බලාගන්න පුළුවන්.

**🔔 Bell එක** — `/en/my-cases` එකේ උඩ දකුණු පැත්තේ. තමන්ගේ පවුලේ cases වල update විතරයි.

---

## 4 · DWC Officer (ක්ෂේත්‍ර නිලධාරියා)

```
http://localhost:3000/officer/login
e2e-officer@hec-e2e.lk  /  HecE2E!2026
```

### Dashboard — `/officer/dashboard`

- 🔔 **22** — ගල්නැව කොට්ඨාසයේ notifications
- Filter: All · Submitted · Under Review · Approved · Rejected
- පහළ nav: 🏠 Home · 📝 New Report · 🤖 Classify · 📤 Queue · 👤 Profile

### ⭐ Case එකක් assess කරන එක — **මේක තමයි demo එකේ හදවත**

Case එකක් ඔබන්න → `/officer/cases/HEC-2026-XXXX`

1. **පවුලේ ඡායාරූප බලන්න** 🆕 — **"Officer assessment"** කොටසේ, **camera එකට කලින්**,
   *"Reported by the family"* කියලා label කරලා.
   මේවා පවුල report කරද්දී ගත්තු ඒවා, නිලධාරියා එතනට යන්න කලින්. Tile එකක් ඔබලා විශාල කරන්න පුළුවන්.
2. **"Start review"** ඔබන්න
3. **Photo එකක් දෙන්න** ("Take Photo" / gallery එකෙන්)
4. **MobileNetV2 එක browser එක ඇතුලේම run වෙනවා** — තත්පර 2-3ක්

```
AI Classification
Auto:        Crop Damage
Severity:    Minor
Confidence:  58%
mobilenetv2-v1 · on-device · 2487 ms
```

> 🔑 **Supervisorට කියන්න — මේක හරියටම කියන්න වැදගත්:**
> **Model එක ඡායාරූපය කිසිතැනකට යවන්නේ නෑ.** Classification එක සිද්ධ වෙන්නේ browser එක ඇතුලේම,
> තත්පර 2-3කින්, internet නැති තැනකත්. **Model input එක උපාංගයෙන් පිටතට යන්නේම නෑ** — ඒක තමයි
> පර්යේෂණයේ දායකත්වය (FR-2.1/2.2).
>
> **ඒත් ඡායාරූපය *සාක්ෂියක්* ලෙස case එකට අමුණනවා** 🆕 (2026-09-28). ඒ දෙක වෙනම දේවල් දෙකක්:
> *"කොහෙද classify වෙන්නේ"* සහ *"සාක්ෂිය ගබඩා වෙනවද"*. **කලින් ඡායාරූපය විසි වුණා**, ඒ නිසා
> approve කරන අයට නිලධාරියා දැක්කේ මොකක්ද කියලා බලන්න බැරි වුණා. දැන් පුළුවන්.

5. **"Accept"** හෝ **"Override"** (override එකට හේතුවක් ලියන්න ඕන)

> 🆕 **ඡායාරූපය හානි ඡායාරූපයක් නෙවෙයි නම් මොකද වෙන්නේ?** (2026-09-28)
> Model එකට පංති 3යි. ඒ නිසා මුහුණක් දැම්මොත් කලින් *"Property Damage 94%"* කිව්වා — පංති 3න්
> එකක් තෝරන්නම වෙනවා. දැන් **open-set gate** එකක් තියෙනවා: ඡායාරූපය පංති තුනටම සමාන නැත්නම්
> පංතිය **ඉවත දමලා `No Damage`** කියනවා, *"Outside the model's scope"* කියලා. **වන්දියක්
> ගණනය වෙන්නේ නෑ.** පෙන්නන්න ඕන නම් random photo එකක් දාන්න.
> මුහුණු 68කින් **86.8%ක්** අල්ලනවා; ඇත්ත HEC ඡායාරූප **0%ක්** වැරදියට reject වෙනවා.

6. **`Crop Damage` නම් → බෝග තක්සේරු form එක එනවා:**

| Field | උදාහරණය |
|---|---|
| බෝගය | Paddy · Banana · Coconut · Maize (bada irigu) · Vegetable |
| හානි වූ භූමිය | 2 අක්කර |
| හානියේ ප්‍රමාණය | 75% |

> 💡 **පෙන්නන්න:** බෝගය දාන්නේ නැතුව **"Submit Assessment"** ඔබන්න බෑ — button එක disable.
> **ඇයි:** AI එකට "මේක බෝග හානියක්" කියලා කියන්න පුළුවන්, ඒත් **"මේක වීද කෙසෙල්ද" කියලා කියන්න බෑ.**
> ඒක නිලධාරියා කුඹුරේ ඉඳන් හඳුනාගන්න ඕන දෙයක්. Server එකත් ඒක ප්‍රතික්ෂේප කරනවා (HTTP 400).

7. **"Submit Assessment"** ඔබන්න

> ⏱️ **මේක දැනගෙන ඉන්න — නැත්නම් කැඩිලා වගේ පේනවා.**
>
> Submit කරාම **තත්පර 15–20ක්** යනවා, සහ **ඒ කාලෙදී තිරයේ පේන්නේ පරණ ඇස්තමේන්තුවයි.**
> (2026-09-25 මැනපු එක:)
>
> ```
> +5s … +15s    LKR 84,536.44   rf_compensation_v2              ← පරණ එක
> +20s          LKR 52,315.17   synthetic_crop_compensation_v1  ← අලුත් එක ✅
> ```
>
> **ආයෙත් Submit ඔබන්න එපා. Refresh කරන්න එපා.** බලාගෙන ඉන්න — තනියම වෙනස් වෙනවා.
> හේතුව: database එක us-east-1 එකේ + VPN එක. Supervisorට කලින්ම කියන්න:
> *"මේක cloud database එකකට යනවා, තත්පර 15ක් විතර ගන්නවා."*

8. ඊට පස්සේ වන්දි ඇස්තමේන්තුව එනවා:

```
LKR 111,283.86
synthetic_crop_compensation_v1
⚠️ Prototype estimate — the crop model is trained on synthetic data,
   not official compensation records.
```

> **වැදගත්:** බෝග model එක **කෘත්‍රිම (synthetic) දත්ත මත** පුහුණු කරලා තියෙන්නේ. ඒක UI එකේම
> ලියලා තියෙනවා. Supervisor ඒක අහයි — **පැහැදිලිව කියන්න.**

### බෝගය අනුව මුදල වෙනස් වෙනවා (2 අක්කර, 75%)

| Paddy | Banana | Coconut | Vegetable | Bada irigu |
|---:|---:|---:|---:|---:|
| 111,067 | 89,884 | 93,373 | 108,878 | 99,320 |

භූමිය අනුව (වී, 75%): 0.25 ac → **22,841** · 1 ac → **54,110** · 2 ac → **111,067**

> ⚠️ **Property Damage** නම් බෝග form එක **එන්නේම නෑ**, සහ පරණ `rf_compensation_v2` model එක
> පාවිච්චි වෙනවා. Model දෙකක් තියෙනවා, කවදාවත් එකතු කරලා නෑ.

---

## 5 · DWC Admin (පරිපාලක)

```
http://localhost:3000/admin/login
e2e-admin@hec-e2e.lk  /  HecE2E!2026
```

### Case List — `/admin/cases`

- 🔔 **30** — අනුරාධපුරය දිස්ත්‍රික්කයේ notifications
- **දිස්ත්‍රික්කයේ KPIs:** මේ මාසේ 27 · Approved 5 · Payment Processed 7 · Rejected 2 ·
  Submitted 18 · Under Review 8 · **එකතුව Rs. 953,786** · සාමාන්‍ය දින 3.3
- Filters: Status · From/To · Damage Type · **DS Division** · Officer assessment
- **"Export 40 cases"** — CSV

> 💡 **පෙන්නන්න:** **DS Division** filter එක. Admin ට කොට්ඨාස 11ම පේනවා; ඒක filter කරාම DS officer
> කෙනෙක් දකින දේ පේනවා. Hierarchy එක එකපාරම තේරෙනවා.

### Case එකක් අරින්න

List එකේ පේළියක් **ඔබන්න** → විස්තර panel එක එනවා:

- **📷 සාක්ෂි ඡායාරූප** 🆕 — පවුලේ ඒවා (*"Reported by the family"*) සහ නිලධාරියාගේ එක
  (*"Taken by the field officer"*). Tile එකක් ඔබලා විශාල කරන්න පුළුවන්.
- AI Result (classification, confidence, override වුණාද)
- **Compensation Estimate** — මුදල, model version, feature values
- **බෝග case එකක් නම්:** ⚠️ *"Prototype estimate — synthetic data"* + *"Crop identified by the officer: paddy"*
- **Audit Trail** — case එකට වුණ හැම දෙයක්ම, hash-chain එකත් එක්ක
- **Actions:** Approve · Reject · Request Info · Escalate

> 🔑 **Supervisorට කියන්න:** මේ panel එක තමයි approve කරන්නේ. 2026-09-28ට කලින් **මෙතන
> ඡායාරූපයක් තිබුණේම නෑ** — admin approve කරලා, DS ගෙවලා තිබුණේ පංති නාමයක් සහ ප්‍රතිශතයක්
> මත විතරයි. දැන් තීරණයේ **පදනම පෙන්නන්න පුළුවන්**, සහ අභියාචනයක් ආවොත් පරීක්ෂා කරන්නත් පුළුවන්.
>
> **තව දෙකක්:** ඡායාරූප තියෙන්නේ **private bucket** එකක; link එකක් හදන්නේ විනාඩි 10කට විතරයි.
> සහ **කවුරු බැලුවත් audit log එකට යනවා** (`case_photos_viewed`, role එකත් එක්ක).

**Approve** කරාම → DS officer ට notification එකක් යනවා (🔔), සහ පුරවැසියාට email එකක්.

### තව screens

```
/admin/analytics           charts සහ trends
/admin/settings            වන්දි සීමා (compensation caps)
```

---

## 6 · DS Officer (ප්‍රාදේශීය ලේකම්)

```
http://localhost:3000/ds/login
e2e-ds@hec-e2e.lk  /  HecE2E!2026
```

### Dashboard — `/ds/dashboard`

- 🔔 **6**
- උඩම: **`Division: ගල්නැව`** ← scope එක තිරයේම පේනවා
- Filters: All · Submitted · Under Review · **Approved** · Payment Processed

### ⭐ ගෙවීමක් කරන එක

1. **"Approved"** filter එක ඔබන්න
2. Case card එකක් තෝරන්න:

```
HEC-2026-0279   Approved
Household: HH-2026-0003 · Account ending 7890
AI-assisted estimate      LKR 84,536.44
DWC recommended amount    LKR 50,000
Final amount              —
[ සාක්ෂි ඡායාරූප බලන්න ]  [ බැංකු විස්තර වෙනස් කරන්න ]  [ Final compensation review ]
```

3. **"සාක්ෂි ඡායාරූප බලන්න"** 🆕 ඔබන්න *(DS තිරය පෙරනිමියෙන් සිංහලෙන්; English නම්
   "View evidence photographs")* — ඇත්ත ගෙවීම තීරණය කරන්නේ මේ තිරයේ, ඒ නිසා සාක්ෂිය
   මෙතනින්ම බලාගන්න පුළුවන් විය යුතුයි. (Card එකකට එකයි — ඔබපු එකේ ඡායාරූප විතරයි load වෙන්නේ.)
4. **"Final compensation review"** → **අවසන් මුදල** සහ **හේතුවක්** ලියන්න
5. ඊට පස්සේ තමයි **ගෙවීම authorize කරන්න පුළුවන්**

> 🔑 **Supervisorට කියන්න මේ තුන:**
>
> 1. **AI ඇස්තමේන්තුව කවදාවත් අවසන් මුදල වෙන්නේ නෑ.** DS officer ලියන අංකය තමයි අවසානය.
> 2. **DS තීරණය නැතුව ගෙවීම block වෙනවා** — HTTP 409. AI එකේ ඉඳන් ගෙවීමට කෙටි මාර්ගයක් නෑ.
> 3. **බැංකු අංකය සම්පූර්ණයෙන් පේන්නේ නෑ** — අන්තිම ඉලක්කම් 4 විතරයි (`ending 7890`).
>    Database එකේ ඒක encrypt කරලා.

---

## 7 · System Admin

```
http://localhost:3000/system/login
```

- `/system/users` — staff accounts හදන, roles දෙන, ප්‍රදේශ පවරන තැන
- 🔔 Bell එක තියෙනවා, ඒත් **හිස්** — ඒක නිවැරදියි. System admin ට ප්‍රදේශයක් නෑ, cases එක්ක වැඩකුත් නෑ.

---

## 8 · Demo පිළිවෙල (විනාඩි 15)

සම්පූර්ණ කතාව එක case එකකින් පෙන්නන්න:

| # | Role | කරන්නේ | විනාඩි |
|---|---|---|---|
| 1 | **Citizen** | Account හදනවා → පවුල register → **duplicate block එක පෙන්නනවා** | 4 |
| 2 | **Citizen** | **Photo 2ක්** එක්ක report → PoC යොමු අංකය | 3 |
| 3 | **Officer** | **පවුලේ ඡායාරූප** → **on-device AI** → බෝගය → **ඇස්තමේන්තුව** | 4 |
| 4 | **Admin** | **සාක්ෂි ඡායාරූප** + audit trail + synthetic label → **Approve** | 2 |
| 5 | **DS** | Evidence → Final amount → **ගෙවීම** | 1 |
| 6 | **Citizen** | `/en/status?ref=…` → **Payment Processed** | 1 |

**අමතක නොකරන්න:** හැම role එකකදීම **🔔 bell එක ඔබන්න.** Role එකින් එකට වෙනස් list එකක් —
scoping එක ක්‍රියාත්මකයි කියලා පෙන්නන්න හොඳම ක්‍රමය.

**🆕 ඡායාරූප demo කරන හොඳම ක්‍රමය:** පියවර 2දී citizen කෙනෙක් ලෙස photo 2ක් දාන්න, ඊට පස්සේ
පියවර 3දී **එම ඡායාරූප දෙකම officer තිරයේ** පෙන්නන්න. එකම කතාවේ දෙපැත්ත එකපාරම පේනවා.
කලින් සූදානම් කරපු case: **HEC-2026-0297** (citizen photo 2) · **HEC-2026-0294** (officer photo).

---

## 9 · අවුලක් ආවොත්

| ලක්ෂණය | හේතුව | විසඳුම |
|---|---|---|
| හැම screen එකක්ම හිස් | **WARP off** | WARP on කරන්න |
| "Failed to fetch" | Backend නවතිලා | `:5000` restart |
| Bell එක හිස් | session තාම load වෙනවා | තත්පර 5ක් ඉන්න (ස්වයංක්‍රීයව retry වෙනවා) |
| Submit එකට තත්පර 10+ | Neon us-east-1 + VPN | Normal — කලින් කියන්න |
| **Submit කළාම ඇස්තමේන්තුව වෙනස් වෙන්නේ නෑ** | **තත්පර 15–20ක් ගන්නවා** | **බලාගෙන ඉන්න. ආයෙත් ඔබන්න එපා** |
| "Register your family first" | account එකට පවුලක් නෑ | `/en/register` |
| "Your family is already registered" | ඒ ජා.හැ. දැනටමත් තියෙනවා | **ඒක feature එකක්** — පෙන්නන්න! |
| GPS එන්නේ නෑ | browser එකට permission නෑ | map එකේ pin එක අතින් තියන්න |
| **Citizen report කරාට පස්සේ ඡායාරූප officer ට පේන්නේ නෑ** | Case එක sync වුණාට **පස්සේ** තමයි ඒවා යන්නේ | තත්පර 10–20ක් ඉන්න, ඊට පස්සේ officer තිරය refresh කරන්න |
| Gallery එකේ "could not be loaded" | signed URL එක expire වෙලා (විනාඩි 10) | **Retry** ඔබන්න — අලුත් link එකක් එනවා |
| Tile එකක් තියෙනවා ඒත් රූපය නෑ | ඒ object එකට link එකක් හදන්න බැරි වුණා | තිරය refresh කරන්න; නැත්නම් storage එක බලන්න |

---

## 10 · අවංකව කියන්න ඕන දේවල්

Supervisor මේවා අහන්න පුළුවන්. **පැහැදිලිව උත්තර දෙන එක තමයි ශක්තිය.**

**1. බෝග වන්දි model එක synthetic data මත.**
ඇත්ත DWC dataset එකේ පංති `death / injury / property` — **බෝග කියන පංතියක්ම නෑ.** ඒ නිසා
`synthetic_crop_compensation_v1` කියන වෙනම prototype එකක්. R² 0.696 කියන්නේ **generator එකේ නීති
කොච්චර ඉගෙන ගන්න පුළුවන්ද** කියන එකයි — ශ්‍රී ලංකාවේ වන්දි නිරවද්‍යතාවය නොවේ. UI එකේම ඒක ලියලා තියෙනවා.

**2. පරණ model එකේ (`rf_compensation_v2`) serving path එකේ R² = −0.277.**
Benchmark එකේ 0.569. හේතුව: incident form එකේ පංති ඔක්කොම `property` එකට collapse වෙනවා. ඒක
thesis එකේ §6.5 එකේ ලියලා තියෙනවා.

**3. SUS = 69.2** (n=3), threshold 70 — **0.8කින් අතපසු**.
ඒත් items බැලුවම කතාව පැහැදිලියි: interface එක ගැන items 6ම හොඳයි (3.00–3.33); අඩුවෙලා තියෙන්නේ
**තනියම පටන් ගන්න පුළුවන් කියන විශ්වාසය** (item 4 = 1.67, තුන්දෙනාම එකඟ). ඒක **onboarding**
ප්‍රශ්නයක්, interface ප්‍රශ්නයක් නෙවෙයි.

**4. Admin list එකේ damage category නම් අවුල් සහගතයි** — සමහරක් `Crop Damage`, සමහරක් `crop_damage`.
Database එකේ vocabularies දෙකක් තියෙනවා (`crop` සහ `crop_damage`). Cosmetic ප්‍රශ්නයක්; ගණනය කිරීම්
වලට බලපාන්නේ නෑ.

**5. `compensation_caps` table එක හිස්** — වන්දි උපරිම සීමාව කිසිම case එකකට බලපාන්නේ නෑ.

**6. සාක්ෂි ඡායාරූප 2026-09-28දී තමයි එකතු කළේ** — ඊට කලින් server එකට රූපයක් ආවේම නෑ.
UI එකේ ඒක *privacy* කියලා ලියලා තිබුණා, ඒත් ඇත්තට ඒක **නොහැදූ feature එකක්**. දැන් හදලා.
**Model එකට කිසිම වෙනසක් නෑ** — inference තවම උපාංගයේම, weights byte-identical.
*තාම නැති දේ:* ඡායාරූපයක් මකන ක්‍රමයක් නෑ (append-only), සහ ස්වයංක්‍රීය retention policy එකක් නෑ —
ඒවා production deployment එකකට කලින් ඕන වෙනවා.

**7. Open-set gate එකට 100%ක් නෑ.** මුහුණු probe 68න් **86.8%ක්** අල්ලනවා; ඉතිරි **13.2%**
තාම පංතියක් ලබනවා (උදා: පාෂාණමය කඳු පසුබිමක් සහිත selfie එකක් — frame එකෙන් වැඩි කොටස
model එක දන්න පිටත බිමක්). Threshold එක ඇත්ත HEC ඡායාරූප **0%ක්** reject වෙන තැනට තියලා
තියෙන්නේ — නිලධාරියාට කරදර නොකර. **අඩු කරනවා, නැති කරන්නේ නෑ** — thesis §7.4 එකේ එහෙමම ලියලා.

---

## තත්ත්වය — 2026-09-28

```
Backend tests     999 passed, 17 skipped, 0 failed
Frontend tests    978 passed, 0 failed
TypeScript        clean
Lint              clean
Production build  exit 0
Migrations        038 දක්වා, Neon parity OK
Audit hash chain  VALID
Role E2E          11/11
Photo pipeline    citizen + officer, live verified (upload → signed URL → 3 roles)
Open-set gate     OOD probe 288න් 87.5% reject · ඇත්ත HEC ඡායාරූප 0% reject
```

Table 3.4 එකේ thresholds **ඔක්කොම මනිලා ඉවරයි** (SUS ඇතුළුව).
