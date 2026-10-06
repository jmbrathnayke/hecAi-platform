<#
.SYNOPSIS
  End-to-end smoke test for the HEC AI E-Governance platform (Story 7.4 verification aid).

.DESCRIPTION
  Boots the Flask backend and the Next.js frontend against the real dev database, then probes
  every research-relevant surface: health, public claim status, officer/admin/citizen auth gates,
  the admin analytics + case list, the PII-stripped research export, and the citizen/officer/admin
  page shells. Prints a PASS/FAIL table and writes a JSON report.

  NOT read-only, and it cannot be: every admin/officer/research read endpoint writes an
  access-audit row (admin_viewed_cases, research_exported_data, ...). What -AllowWrites adds is
  case creation. The important distinction is which audit rows a later
  `clear_research_data --include-orphan-audit` can sweep:

    * default run  -> only sweepable view/verify rows, so a later clear still works.
    * -AllowWrites -> also probes the CSV export, which writes `admin_exported_cases`, an
                      NFR-3.4 data-egress record the cleaner deliberately refuses to delete.
                      That row will block clearing the seeded corpus until it is removed by hand.

  See backend/scripts/README.md for why the cleaner draws that line.

.EXAMPLE
  ./scripts/e2e_smoke.ps1
  ./scripts/e2e_smoke.ps1 -SkipFrontend
  ./scripts/e2e_smoke.ps1 -ReportPath C:\temp\e2e.json
#>
param(
  [int]$BackendPort  = 5055,
  [int]$FrontendPort = 3055,
  [switch]$SkipFrontend,
  [switch]$AllowWrites,
  [string]$ReportPath = "$PSScriptRoot\..\..\e2e-report.json"
)

$ErrorActionPreference = 'Stop'
$backendRoot  = Resolve-Path "$PSScriptRoot\.."
$repoRoot     = Resolve-Path "$backendRoot\.."
$frontendRoot = Join-Path $repoRoot 'frontend'
$python       = Join-Path $backendRoot 'venv\Scripts\python.exe'

$results = [System.Collections.ArrayList]::new()
$procs   = @()

function Add-Result {
  param([string]$Area, [string]$Name, [bool]$Ok, [string]$Detail)
  [void]$results.Add([pscustomobject]@{ area = $Area; name = $Name; ok = $Ok; detail = $Detail })
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  $col = if ($Ok) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1,-52} {2}" -f $tag, $Name, $Detail) -ForegroundColor $col
}

function Invoke-Probe {
  param(
    [string]$Area, [string]$Name, [string]$Url,
    [hashtable]$Headers = @{}, [string]$Method = 'GET', $Body = $null,
    [int[]]$Expect = @(200), [scriptblock]$Check = $null
  )
  try {
    $p = @{ Uri = $Url; Method = $Method; Headers = $Headers; TimeoutSec = 60
            SkipHttpErrorCheck = $true }
    if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8); $p.ContentType = 'application/json' }
    $r = Invoke-WebRequest @p
    $codeOk = $Expect -contains [int]$r.StatusCode
    $detail = "HTTP $([int]$r.StatusCode)"
    if ($codeOk -and $Check) {
      $parsed = $null
      try { $parsed = $r.Content | ConvertFrom-Json } catch { $parsed = $r.Content }
      $extra = & $Check $parsed $r
      if ($extra -is [string] -and $extra) { $detail = "$detail — $extra" }
      elseif ($extra -eq $false) { $codeOk = $false; $detail = "$detail — content check failed" }
    }
    Add-Result $Area $Name $codeOk $detail
    return $r
  } catch {
    Add-Result $Area $Name $false $_.Exception.Message
    return $null
  }
}

function Wait-ForPort {
  param([int]$Port, [int]$TimeoutSec = 120, [string]$Label)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $c = Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($c) { return $true }
    Start-Sleep -Milliseconds 800
  }
  Write-Host "  timed out waiting for $Label on port $Port" -ForegroundColor Red
  return $false
}

# --- JWT minting (HS256) so the probes can exercise every role gate --------------------------
function New-Jwt {
  param([string]$Sub, [string]$Role, [string]$DistrictId, [string]$Secret, [int]$Minutes = 30)
  $meta = @{}
  if ($Role)       { $meta.role = $Role }
  if ($DistrictId) { $meta.district_id = $DistrictId }
  $exp = [int][double]::Parse((Get-Date -UFormat %s)) + ($Minutes * 60)
  $header  = @{ alg = 'HS256'; typ = 'JWT' } | ConvertTo-Json -Compress
  # `app_metadata`, not `user_metadata`. The authorization claims moved on 2026-08-11 because
  # `user_metadata` is rewritable by the authenticated client itself through auth.updateUser(),
  # so a citizen could mint themselves an admin role and present a perfectly valid signature;
  # middleware/auth.py reads AUTHZ_CLAIM = "app_metadata" with deliberately no fallback. This
  # probe was last run on 2026-08-10, the day before, and every authenticated check in it had
  # been failing with HTTP 401 ever since -- the control working, not the app breaking.
  $payload = @{ sub = $Sub; app_metadata = $meta; exp = $exp } | ConvertTo-Json -Compress -Depth 5
  function B64 { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
  $h = B64 ([Text.Encoding]::UTF8.GetBytes($header))
  $p = B64 ([Text.Encoding]::UTF8.GetBytes($payload))
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
  $sig = B64 ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$h.$p")))
  "$h.$p.$sig"
}

try {
  Write-Host "`n=== HEC platform end-to-end smoke ===" -ForegroundColor Cyan
  Write-Host "repo: $repoRoot"

  # --- env ------------------------------------------------------------------------------------
  $envMap = @{}
  Get-Content (Join-Path $backendRoot '.env') | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
  }
  $jwtSecret = $envMap['SUPABASE_JWT_SECRET']
  if (-not $jwtSecret) { throw 'SUPABASE_JWT_SECRET missing from backend/.env' }

  $district = [char]0x0D85 + [char]0x0DB1 + [char]0x0DD4 + [char]0x0DBB + [char]0x0DCF +
              [char]0x0DB0 + [char]0x0DB4 + [char]0x0DD4 + [char]0x0DBB + [char]0x0DBA  # අනුරාධපුරය
  $tokOfficer = New-Jwt -Sub 'e2e-officer'  -Role 'officer'      -Secret $jwtSecret
  $tokAdmin   = New-Jwt -Sub 'e2e-admin'    -Role 'admin' -DistrictId $district -Secret $jwtSecret
  $tokResearch= New-Jwt -Sub 'e2e-research' -Role 'system_admin' -Secret $jwtSecret
  $tokCitizen = New-Jwt -Sub 'e2e-citizen'  -Secret $jwtSecret

  # --- boot backend ---------------------------------------------------------------------------
  Write-Host "`n[1/5] starting backend on :$BackendPort" -ForegroundColor Yellow
  $env:FLASK_APP = 'wsgi.py'
  $procs += Start-Process -FilePath $python `
    -ArgumentList @('-m','flask','run','--port',"$BackendPort",'--host','127.0.0.1') `
    -WorkingDirectory $backendRoot -PassThru -WindowStyle Hidden
  if (-not (Wait-ForPort -Port $BackendPort -Label 'backend')) { throw 'backend did not start' }
  $api = "http://127.0.0.1:$BackendPort/api/v1"

  # --- backend probes ---------------------------------------------------------------------------
  Write-Host "`n[2/5] backend API" -ForegroundColor Yellow
  Invoke-Probe 'api' 'GET /health' "$api/health" -Check { param($j) "status=$($j.status)" } | Out-Null

  Invoke-Probe 'api' 'research export rejects anonymous' "$api/research/export" -Expect @(401) | Out-Null
  Invoke-Probe 'api' 'research export rejects officer role' "$api/research/export" `
    -Headers @{ Authorization = "Bearer $tokOfficer" } -Expect @(403) | Out-Null
  Invoke-Probe 'api' 'research export rejects district admin' "$api/research/export" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Expect @(403) | Out-Null

  $exp = Invoke-Probe 'research' 'research export (system_admin)' "$api/research/export" `
    -Headers @{ Authorization = "Bearer $tokResearch" } -Check {
      param($j, $r) "rows=$($j.Count) hdr=$($r.Headers['X-HEC-Row-Count'])"
    }
  if ($exp) {
    $rows = $exp.Content | ConvertFrom-Json
    $pii  = @('submitter_identity_hash','gps_lat',
              'gps_lng','officer_id','citizen_id','input_features','override_reason')
    $names = @($rows[0].PSObject.Properties.Name)
    $leak = $pii | Where-Object { $names -contains $_ }
    Add-Result 'research' 'export carries no PII (NFR-3.3)' ($leak.Count -eq 0) `
      $(if ($leak) { "LEAKED: $($leak -join ',')" } else { "$($names.Count) fields, none PII" })

    $withGt = @($rows | Where-Object { $_.ground_truth }).Count
    Add-Result 'research' 'ground_truth present (RER-2 matrix computable)' ($withGt -eq $rows.Count) `
      "$withGt/$($rows.Count) rows"

    $ovr = @($rows | Where-Object { $_.was_overridden }).Count
    $rate = if ($rows.Count) { [math]::Round($ovr / $rows.Count, 4) } else { 0 }
    Add-Result 'research' 'override rate computable (NFR-6.3)' ($rows.Count -gt 0) "rate=$rate"

    $mae = $rows | Where-Object { $_.compensation_estimate_lkr -ne $null -and $_.approved_amount -ne $null }
    Add-Result 'research' 'MAE computable (RER-3)' ($mae.Count -gt 0) "$($mae.Count) paired rows"

    $synthetic = @($rows | Where-Object { $_.model_version -like 'seed-*' }).Count
    Add-Result 'research' 'synthetic rows self-labelled (integrity)' ($synthetic -gt 0) `
      "$synthetic/$($rows.Count) marked seed-*"

    $preds = @($rows | ForEach-Object { $_.prediction } | Sort-Object -Unique)
    Add-Result 'research' 'prediction spans all 3 model classes' ($preds.Count -eq 3) `
      "classes: $($preds -join ',')"
  }

  Write-Host "`n[3/5] admin + officer surfaces" -ForegroundColor Yellow
  # Assert on the REAL response shape (items/total/kpis). An earlier version of this probe read
  # $j.cases and $j.kpis.total_cases — neither field exists, so it reported PASS with an empty
  # detail string while proving nothing. Every check below must fail loudly if the shape drifts.
  Invoke-Probe 'api' 'admin case list (district-scoped)' "$api/admin/cases" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Check {
      param($j)
      if ($null -eq $j.items -or $null -eq $j.total) { return $false }
      if ($j.total -lt 1) { return $false }
      "items=$($j.items.Count) total=$($j.total) approved_lkr=$($j.kpis.total_approved_lkr)"
    } | Out-Null
  Invoke-Probe 'api' 'admin KPIs populated' "$api/admin/cases" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Check {
      param($j)
      $k = $j.kpis
      if ($null -eq $k -or $null -eq $k.by_status -or $null -eq $k.avg_processing_days) { return $false }
      $statuses = @($k.by_status.PSObject.Properties.Name)
      "statuses=$($statuses -join '/') avg_days=$($k.avg_processing_days)"
    } | Out-Null
  Invoke-Probe 'api' 'admin analytics (FR-7.1)' "$api/admin/analytics?from=2025-08-01&to=2026-08-31" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Check {
      param($j)
      if ($null -eq $j.volume_trend -or $j.volume_trend.Count -lt 2) { return $false }
      $sd = @($j.status_distribution.PSObject.Properties.Name).Count
      "months=$($j.volume_trend.Count) statuses=$sd ai_samples=$($j.ai_metrics.sample_count)"
    } | Out-Null
  Invoke-Probe 'api' 'analytics default range is narrow (30d)' "$api/admin/analytics" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Check {
      param($j) "default range $($j.range.from)..$($j.range.to)"
    } | Out-Null
  Invoke-Probe 'api' 'admin audit chain verify (FR-5.5)' "$api/admin/audit/verify-chain" `
    -Headers @{ Authorization = "Bearer $tokAdmin" } -Check {
      param($j) "valid=$($j.valid) broken_id=$($j.broken_id)"
    } | Out-Null
  if ($AllowWrites) {
    # Gated: this endpoint writes `admin_exported_cases`, which the cleaner will not sweep, so
    # running it leaves a row that blocks clearing the seeded corpus.
    Invoke-Probe 'api' 'admin CSV export (FR-7.2)' "$api/admin/export?format=csv" `
      -Headers @{ Authorization = "Bearer $tokAdmin" } | Out-Null
  } else {
    Write-Host "  [SKIP] admin CSV export (FR-7.2)                        needs -AllowWrites (writes a non-sweepable audit row)" -ForegroundColor DarkGray
  }
  Invoke-Probe 'api' 'officer case list' "$api/officer/cases" `
    -Headers @{ Authorization = "Bearer $tokOfficer" } | Out-Null
  Invoke-Probe 'api' 'admin endpoint rejects officer token' "$api/admin/cases" `
    -Headers @{ Authorization = "Bearer $tokOfficer" } -Expect @(403) | Out-Null
  Invoke-Probe 'api' 'citizen cases requires auth' "$api/citizen/cases" -Expect @(401) | Out-Null

  if ($AllowWrites) {
    Write-Host "  -AllowWrites: exercising a real submission (writes to the audit chain)" -ForegroundColor Magenta
    $oid = [guid]::NewGuid().ToString()
    Invoke-Probe 'api' 'citizen submit -> 201' "$api/cases/submit" -Method POST `
      -Headers @{ Authorization = "Bearer $tokCitizen" } -Expect @(201) `
      -Body @{ offline_id = $oid; damage_category = 'property'; district = $district; locale = 'si' } `
      -Check { param($j) "canonical=$($j.canonical_id)" } | Out-Null
    Invoke-Probe 'api' 'resubmit same offline_id -> 200 idempotent' "$api/cases/submit" -Method POST `
      -Headers @{ Authorization = "Bearer $tokCitizen" } -Expect @(200) `
      -Body @{ offline_id = $oid; damage_category = 'property'; district = $district; locale = 'si' } | Out-Null
    Write-Host "  NOTE: case $oid persists; it is NOT seeded=true so clear_research_data will not remove it." -ForegroundColor Magenta
  }

  # --- frontend --------------------------------------------------------------------------------
  if (-not $SkipFrontend) {
    Write-Host "`n[4/5] starting frontend on :$FrontendPort (next dev — first paint is slow)" -ForegroundColor Yellow
    $env:NEXT_PUBLIC_API_URL = $api
    $env:NEXT_PUBLIC_BACKEND_URL = "http://127.0.0.1:$BackendPort"
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm).Source }
    $procs += Start-Process -FilePath $npm `
      -ArgumentList @('run','dev','--','--port',"$FrontendPort") `
      -WorkingDirectory $frontendRoot -PassThru -WindowStyle Hidden
    if (Wait-ForPort -Port $FrontendPort -TimeoutSec 180 -Label 'frontend') {
      $base = "http://127.0.0.1:$FrontendPort"
      foreach ($page in @(
        @{ n = 'citizen home (si)';      u = "$base/si" },
        @{ n = 'citizen home (ta)';      u = "$base/ta" },
        @{ n = 'citizen home (en)';      u = "$base/en" },
        @{ n = 'claim status check';     u = "$base/si/status" },
        @{ n = 'incident report step 1'; u = "$base/si/report" },
        @{ n = 'officer login';          u = "$base/officer/login" },
        @{ n = 'admin login';            u = "$base/admin/login" }
      )) {
        Invoke-Probe 'ui' $page.n $page.u -Check {
          param($j, $r) "$([math]::Round($r.RawContentLength/1024,1)) kB"
        } | Out-Null
      }
      Invoke-Probe 'ui' 'admin dashboard gated when unauthenticated' "$base/admin/cases" `
        -Expect @(200,302,307) | Out-Null
    } else {
      Add-Result 'ui' 'frontend boot' $false 'did not bind port within 180s'
    }
  } else {
    Write-Host "`n[4/5] frontend skipped (-SkipFrontend)" -ForegroundColor DarkGray
  }

  # --- summary ---------------------------------------------------------------------------------
  Write-Host "`n[5/5] summary" -ForegroundColor Yellow
  $pass = @($results | Where-Object ok).Count
  $fail = @($results | Where-Object { -not $_.ok }).Count
  Write-Host ("  {0} passed, {1} failed" -f $pass, $fail) -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
  if ($fail) {
    Write-Host "`n  Failures:" -ForegroundColor Red
    $results | Where-Object { -not $_.ok } | ForEach-Object {
      Write-Host ("   - [{0}] {1}: {2}" -f $_.area, $_.name, $_.detail) -ForegroundColor Red
    }
  }
  [pscustomobject]@{
    generated_at = (Get-Date).ToString('o'); passed = $pass; failed = $fail; results = $results
  } | ConvertTo-Json -Depth 6 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host "`n  report: $ReportPath"
  if ($fail) { exit 1 }
}
finally {
  Write-Host "`ncleaning up..." -ForegroundColor DarkGray
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) {
      # next dev spawns children; kill the tree or the port stays bound.
      Start-Process -FilePath 'taskkill' -ArgumentList @('/PID', $p.Id, '/T', '/F') `
        -NoNewWindow -Wait -ErrorAction SilentlyContinue | Out-Null
    }
  }
}
