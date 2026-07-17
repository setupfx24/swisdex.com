# SwisDex native local dev — everything hot-reloads, no Docker rebuilds.
# Infra (postgres/timescaledb/redis) runs in Docker with host ports
# 5434/5435/6381 (see docker-compose.local-infra.yml + backend/.env).
# All app code runs natively in separate PowerShell windows.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\dev-native.ps1
# Stop:   close the windows (or scripts\dev-native-stop.ps1), then
#         docker compose stop postgres timescaledb redis
#
# URLs:   trader http://localhost:3000 | admin http://localhost:3001
#         gateway http://localhost:8000/docs | admin-api http://localhost:8001/docs

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot          # swisdesk/
$backend = Join-Path $root "backend"
$py      = Join-Path $backend ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "backend\.venv missing - create it first (see backend venv setup)."
}

Write-Host "[1/3] Starting infra containers (postgres 5434, timescale 5435, redis 6381)..."
docker compose -f "$root\docker-compose.yml" -f "$root\docker-compose.local-infra.yml" up -d postgres timescaledb redis

function Start-Svc([string]$title, [string]$workdir, [string]$cmd, [hashtable]$extraEnv = @{}) {
    $envLines = ($extraEnv.GetEnumerator() | ForEach-Object { "`$env:$($_.Key)='$($_.Value)';" }) -join " "
    $inner = "`$host.UI.RawUI.WindowTitle='$title'; Set-Location '$workdir'; $envLines $cmd"
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $inner
}

Write-Host "[2/3] Starting backend services (uvicorn --reload / python -m)..."
$pyEnv = @{ PYTHONPATH = $backend; PYTHONUNBUFFERED = "1" }

Start-Svc "gateway :8000" $backend `
    "& '$py' -m uvicorn services.gateway.src.main:app --host 0.0.0.0 --port 8000 --reload" $pyEnv

# admin-api must use redis db 1 (gateway uses db 0) — same override as docker-compose.yml
$adminEnv = $pyEnv.Clone(); $adminEnv.REDIS_URL = "redis://localhost:6381/1"
Start-Svc "admin-api :8001" $backend `
    "& '$py' -m uvicorn main:app --app-dir services/admin --host 0.0.0.0 --port 8001 --reload" $adminEnv

Start-Svc "market-data" $backend "& '$py' -m services.market_data.src.main" $pyEnv
Start-Svc "b-book-engine" $backend "& '$py' -m services.b_book_engine.src.main" $pyEnv
Start-Svc "risk-engine" $backend "& '$py' -m services.risk_engine.src.main" $pyEnv

Write-Host "[3/3] Starting frontend dev servers (next dev --turbo)..."
Start-Svc "trader-frontend :3000" (Join-Path $root "frontend\trader") "npm run dev"
Start-Svc "admin-frontend :3001" (Join-Path $root "frontend\admin") "npm run dev"

Write-Host ""
Write-Host "All services launching in separate windows:"
Write-Host "  Trader app   http://localhost:3000"
Write-Host "  Admin app    http://localhost:3001"
Write-Host "  Gateway API  http://localhost:8000/docs"
Write-Host "  Admin API    http://localhost:8001/docs"
