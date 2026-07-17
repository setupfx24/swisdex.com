# Stop all native SwisDex dev processes + infra containers.
# Kills processes listening on the dev ports, then stops the DB/redis containers.

$ports = 8000, 8001, 3000, 3001
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -in @("python", "node")) {
            Write-Host "Stopping $($p.ProcessName) (pid $($p.Id)) on port $port"
            Stop-Process -Id $p.Id -Force -Confirm:$false
        }
    }
}

# Engines (market-data, b-book, risk) have no ports — kill leftover venv pythons
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape("swisdesk\backend\.venv") } |
    ForEach-Object {
        Write-Host "Stopping backend python (pid $($_.ProcessId))"
        Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
    }

$root = Split-Path -Parent $PSScriptRoot
docker compose -f "$root\docker-compose.yml" -f "$root\docker-compose.local-infra.yml" stop postgres timescaledb redis
Write-Host "Done."
