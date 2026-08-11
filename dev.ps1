<#
.SYNOPSIS
    Runs the HEC frontend (Next.js) and backend (Flask) together in one console.

.DESCRIPTION
    Starts both services, waits until each is actually answering, then streams their
    output into this window with a coloured [backend] / [frontend] prefix. Ctrl+C stops
    both cleanly.

    Killing is done with `taskkill /T` (whole process tree), not Stop-Process: Flask's
    debug reloader and npm both spawn grandchildren that survive a bare PID kill and
    keep holding the port.

.PARAMETER Install
    Install/refresh dependencies first (pip install -r requirements.txt, npm install).
    Needed on a fresh clone or after a dependency change.

.PARAMETER BackendOnly
    Start only the Flask API.

.PARAMETER FrontendOnly
    Start only the Next.js app. Assumes a backend is already running at -BackendPort.

.PARAMETER BackendPort
    Port for Flask. Default 5000 — matches NEXT_PUBLIC_API_URL in frontend/.env.local,
    so changing it means the frontend will point at the wrong place unless you change
    that too.

.PARAMETER FrontendPort
    Port for Next.js. Default 3000.

.PARAMETER Open
    Open the frontend in the default browser once it is ready.

.EXAMPLE
    .\dev.ps1
    Start both, the usual case.

.EXAMPLE
    .\dev.ps1 -Install -Open
    First run after a clone: install dependencies, start both, open the browser.

.EXAMPLE
    .\dev.ps1 -BackendOnly
    Just the API, e.g. when running the frontend from another terminal or an IDE.
#>
# PowerShell 7+ (pwsh), not Windows PowerShell 5.1: this uses ProcessStartInfo.ArgumentList,
# which does not exist on .NET Framework. ArgumentList is worth the requirement — it passes each
# argument as its own token, so paths containing spaces (this repo lives under "final research")
# cannot be split by the naive quoting rules of the older .Arguments string.
#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [int]$BackendPort = 5000,
    [int]$FrontendPort = 3000,
    [switch]$Open
)

$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$BackendDir  = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$VenvPython  = Join-Path $BackendDir 'venv\Scripts\python.exe'

$runBackend  = -not $FrontendOnly
$runFrontend = -not $BackendOnly

if ($BackendOnly -and $FrontendOnly) {
    throw "-BackendOnly and -FrontendOnly are mutually exclusive."
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err ($msg) { Write-Host "  x $msg" -ForegroundColor Red }
function Write-Ok  ($msg) { Write-Host "  + $msg" -ForegroundColor Green }

# --- Preflight -------------------------------------------------------------------------
# Fail here with something actionable rather than letting a child process die with a
# stack trace two seconds after launch.
Write-Step "Checking the workspace"

if ($runBackend) {
    if (-not (Test-Path $VenvPython)) {
        Write-Err "No virtualenv at backend\venv."
        Write-Host "    Create it with:" -ForegroundColor DarkGray
        Write-Host "      py -3 -m venv `"$BackendDir\venv`"" -ForegroundColor DarkGray
        Write-Host "      & `"$VenvPython`" -m pip install -r `"$BackendDir\requirements.txt`"" -ForegroundColor DarkGray
        exit 1
    }
    if (-not (Test-Path (Join-Path $BackendDir '.env'))) {
        Write-Warn "backend\.env is missing - Flask will start but DB/JWT-backed routes will fail. See backend\.env.example."
    }
}

if ($runFrontend) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Err "node was not found on PATH. Install Node.js, then re-run."
        exit 1
    }
    if (-not (Test-Path (Join-Path $FrontendDir 'node_modules')) -and -not $Install) {
        Write-Err "frontend\node_modules is missing. Re-run with -Install."
        exit 1
    }
    if (-not (Test-Path (Join-Path $FrontendDir '.env.local'))) {
        Write-Warn "frontend\.env.local is missing - Supabase auth will throw on load. See frontend\.env.local.example."
    }
}

# A port already in use is the single most common reason a "start" appears to work but the
# app is unreachable (you end up talking to a stale server from a previous run).
function Test-PortFree([int]$Port, [string]$Label) {
    $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
        $owner = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Write-Err "Port $Port ($Label) is already in use by '$owner' (PID $($inUse[0].OwningProcess))."
        Write-Host "    Stop it, or pass a different port. To stop it now:" -ForegroundColor DarkGray
        Write-Host "      Stop-Process -Id $($inUse[0].OwningProcess) -Force" -ForegroundColor DarkGray
        return $false
    }
    return $true
}

$portsOk = $true
if ($runBackend  -and -not (Test-PortFree $BackendPort  'backend'))  { $portsOk = $false }
if ($runFrontend -and -not (Test-PortFree $FrontendPort 'frontend')) { $portsOk = $false }
if (-not $portsOk) { exit 1 }

Write-Ok "Workspace looks good"

# --- Optional dependency install -------------------------------------------------------
if ($Install) {
    if ($runBackend) {
        Write-Step "Installing Python dependencies"
        & $VenvPython -m pip install -q -r (Join-Path $BackendDir 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { Write-Err "pip install failed."; exit 1 }
        Write-Ok "Python dependencies ready"
    }
    if ($runFrontend) {
        Write-Step "Installing npm dependencies"
        Push-Location $FrontendDir
        try {
            & cmd.exe /c "npm install --no-fund --no-audit"
            if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
        } finally { Pop-Location }
        Write-Ok "npm dependencies ready"
    }
}

# --- Process plumbing ------------------------------------------------------------------
$script:Procs      = @()
$script:LogQueue   = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$script:EventSubs  = @()

function Start-Service_(
    [string]$Label,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [hashtable]$EnvVars = @{}
) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = $FilePath
    $psi.WorkingDirectory       = $WorkingDirectory
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    foreach ($a in $ArgumentList) { $psi.ArgumentList.Add($a) }
    foreach ($k in $EnvVars.Keys) { $psi.Environment[$k] = $EnvVars[$k] }

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo           = $psi
    $proc.EnableRaisingEvents = $true

    # Output arrives on a background thread, so it is queued rather than written directly;
    # the main loop drains the queue. Writing to the host from an event handler interleaves
    # badly with the foreground prompt.
    $onData = {
        if ($null -ne $EventArgs.Data -and $EventArgs.Data -ne '') {
            $Event.MessageData.Q.Enqueue("$($Event.MessageData.Tag)|$($EventArgs.Data)")
        }
    }
    $md = @{ Q = $script:LogQueue; Tag = $Label }
    $script:EventSubs += Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $onData -MessageData $md
    $script:EventSubs += Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action $onData -MessageData $md

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    $script:Procs += [pscustomobject]@{ Label = $Label; Process = $proc }
    return $proc
}

function Stop-AllServices {
    foreach ($entry in $script:Procs) {
        $p = $entry.Process
        if ($null -ne $p -and -not $p.HasExited) {
            # /T kills the whole tree. Flask's reloader and npm both spawn a grandchild
            # that keeps the port bound if only the direct child is killed.
            & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
        }
    }
    foreach ($sub in $script:EventSubs) {
        Unregister-Event -SubscriptionId $sub.Id -ErrorAction SilentlyContinue
    }
    $script:Procs = @()
}

function Write-QueuedOutput {
    $line = ''
    while ($script:LogQueue.TryDequeue([ref]$line)) {
        $parts = $line.Split('|', 2)
        $tag   = $parts[0]
        $text  = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        $color = if ($tag -eq 'backend') { 'Magenta' } else { 'Blue' }
        Write-Host "[$tag] " -ForegroundColor $color -NoNewline
        Write-Host $text
    }
}

# Waits for a URL to answer at all. Any HTTP status counts: the frontend returns 307 on /
# (locale redirect) and that still means "the server is up", which is all this checks.
function Wait-ForUrl([string]$Url, [int]$TimeoutSec, [string]$Label) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Write-QueuedOutput
        foreach ($entry in $script:Procs) {
            if ($entry.Process.HasExited) {
                Write-Err "$($entry.Label) exited early (code $($entry.Process.ExitCode)) - see its output above."
                return $false
            }
        }
        try {
            Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop | Out-Null
            return $true
        } catch {
            # A redirect or 4xx/5xx still proves something is listening.
            if ($null -ne $_.Exception.Response) { return $true }
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Warn "$Label did not respond within ${TimeoutSec}s (it may still be compiling)."
    return $false
}

# --- Run -------------------------------------------------------------------------------
try {
    if ($runBackend) {
        Write-Step "Starting backend (Flask) on port $BackendPort"
        # `flask --app wsgi run` rather than `python wsgi.py`: it honours --port and gives
        # the reloader. wsgi.py calls load_dotenv() on import, so backend\.env is picked up.
        Start-Service_ -Label 'backend' -FilePath $VenvPython -WorkingDirectory $BackendDir `
            -ArgumentList @('-m', 'flask', '--app', 'wsgi', 'run', '--port', "$BackendPort") `
            -EnvVars @{ PYTHONUNBUFFERED = '1' } | Out-Null
    }

    if ($runFrontend) {
        Write-Step "Starting frontend (Next.js) on port $FrontendPort"
        # Routed through cmd.exe because npm on Windows is npm.cmd, which
        # ProcessStartInfo cannot execute directly with UseShellExecute = $false.
        Start-Service_ -Label 'frontend' -FilePath $env:ComSpec -WorkingDirectory $FrontendDir `
            -ArgumentList @('/c', "npm run dev -- --port $FrontendPort") | Out-Null
    }

    if ($runBackend) {
        if (Wait-ForUrl "http://127.0.0.1:$BackendPort/api/v1/health" 60 'backend') {
            Write-Ok "Backend healthy  -> http://localhost:$BackendPort/api/v1/health"
        }
    }
    if ($runFrontend) {
        # Next.js compiles the first route on demand, so the first response is slow.
        if (Wait-ForUrl "http://127.0.0.1:$FrontendPort/" 120 'frontend') {
            Write-Ok "Frontend ready   -> http://localhost:$FrontendPort"
            if ($Open) { Start-Process "http://localhost:$FrontendPort" }
        }
    }

    Write-Host ""
    Write-Host "  Ctrl+C stops everything." -ForegroundColor DarkGray
    Write-Host ""

    # Stream output until a service dies or the user interrupts.
    while ($true) {
        Write-QueuedOutput
        $dead = $script:Procs | Where-Object { $_.Process.HasExited }
        if ($dead) {
            foreach ($d in $dead) {
                Write-Err "$($d.Label) exited with code $($d.Process.ExitCode). Shutting down the rest."
            }
            break
        }
        Start-Sleep -Milliseconds 200
    }
} finally {
    # Runs on Ctrl+C too, which is the whole point: without it a stale Next/Flask keeps
    # the port bound and the next run fails the preflight check.
    Write-Host ""
    Write-Step "Stopping services"
    Write-QueuedOutput
    Stop-AllServices
    Write-Ok "Stopped"
}
