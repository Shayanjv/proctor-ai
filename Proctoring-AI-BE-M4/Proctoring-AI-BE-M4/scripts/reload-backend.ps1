# Hot-reload Python source edits without rebuilding the image. Sends SIGHUP
# to the gunicorn master process inside the container, which gracefully
# replaces all workers. The bind-mounted /app picks up the new code on the
# next worker import.
#
# IMPORTANT: This only works if the image was built WITHOUT --preload.
# Under --preload, the master imports the app once at boot and forks
# workers from that frozen memory; SIGHUP will re-fork workers but the new
# workers inherit the stale code. The current Dockerfile (no --preload) is
# correctly configured. If you ever switch back to --preload you'll need
# scripts/redeploy-backend.ps1 for any code change.
#
# Usage:
#   ./scripts/reload-backend.ps1
#   ./scripts/reload-backend.ps1 -ContainerName proctoring-ai-web-1
[CmdletBinding()]
param(
    [string]$ContainerName = 'proctoring-backend',
    [int]   $WaitSeconds   = 8
)

$ErrorActionPreference = 'Stop'

Write-Host "Hot-reloading $ContainerName ..." -ForegroundColor Cyan

# Locate the gunicorn master.
#
# The container's process tree looks like:
#   PID 1   /bin/sh -c "gunicorn -w ${WEB_CONCURRENCY:-1} --timeout 0 ..."
#   PID 7     gunicorn master (ppid=1)
#   PID 8       gunicorn worker (ppid=7)
#
# A naive `pgrep -f gunicorn | head -1` matches PID 1 too (its argv contains
# the literal string "gunicorn") and SIGHUP to PID 1 is silently dropped —
# the symptom is "reload says it worked but workers never restart".
#
# Filtering by parent PID = 1 returns exactly the master:
#   - PID 1   ppid=0  → excluded
#   - master  ppid=1  → MATCH
#   - worker  ppid=7  → excluded
$masterPid = (docker exec $ContainerName sh -c "pgrep -P 1 -f gunicorn | head -n 1").Trim()
if (-not $masterPid -or -not ($masterPid -match '^\d+$')) {
    Write-Host "Could not locate gunicorn master inside $ContainerName (got: '$masterPid')." -ForegroundColor Red
    Write-Host "Is the container running?  docker ps --filter name=$ContainerName" -ForegroundColor Yellow
    exit 1
}

Write-Host "Sending SIGHUP to gunicorn master PID $masterPid ..." -ForegroundColor Cyan
docker exec $ContainerName kill -HUP $masterPid
if ($LASTEXITCODE -ne 0) {
    Write-Host "SIGHUP failed." -ForegroundColor Red
    exit 1
}

Write-Host "Waiting ${WaitSeconds}s for new workers to come up ..." -ForegroundColor Cyan
Start-Sleep -Seconds $WaitSeconds

Write-Host ""
Write-Host "== Last 8 log lines ==" -ForegroundColor Green
docker logs --tail 8 $ContainerName

Write-Host ""
Write-Host "Done. Hard-refresh your browser (Ctrl+Shift+R) to drop any stale FE state." -ForegroundColor Green
