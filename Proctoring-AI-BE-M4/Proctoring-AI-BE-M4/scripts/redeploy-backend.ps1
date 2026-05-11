# Rebuild the proctoringai-backend image and recreate the proctoring-backend
# container, preserving its env, network, mounts, and the live data volumes
# attached to its sibling containers (proctoring-db, proctoring-storage,
# proctoring-redis, proctoring-adminer). Volumes are NEVER touched by this
# script.
#
# Use this when:
#   - Dockerfile changed (e.g. gunicorn flags, system packages)
#   - requirements.txt changed
#   - Environment variables on the container need to change
#
# For a pure Python-source edit, use scripts/reload-backend.ps1 instead — it
# is ~10x faster and has zero rebuild cost.
#
# Usage:
#   ./scripts/redeploy-backend.ps1                       # defaults
#   ./scripts/redeploy-backend.ps1 -WarmupSeconds 60     # slow machine
#   ./scripts/redeploy-backend.ps1 -ContainerName foo    # different container
[CmdletBinding()]
param(
    [string]$ContainerName = 'proctoring-backend',
    [string]$ImageName     = 'proctoringai-backend',
    [string]$NetworkName   = 'proctoringai_default',
    [string]$NetworkAlias  = 'backend',
    [int]   $HostPort      = 8080,
    [int]   $ContainerPort = 8000,
    [string]$LogsVolume    = 'proctoringai_logs_data',
    [int]   $WarmupSeconds = 30
)

$ErrorActionPreference = 'Stop'

# scripts/ lives one level under the project root; resolve robustly regardless
# of where the user invokes the script from.
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "== Redeploy backend ==" -ForegroundColor Green
Write-Host "Project root : $ProjectRoot" -ForegroundColor Gray
Write-Host "Container    : $ContainerName" -ForegroundColor Gray
Write-Host "Image        : $ImageName" -ForegroundColor Gray
Write-Host ""

# 0. Sanity check Docker is reachable. Without this the failure later in the
#    pipeline is much harder to read.
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker daemon is not reachable. Start Docker Desktop and retry." -ForegroundColor Red
    exit 1
}

# 1. Capture env from the existing container (minus WEB_CONCURRENCY which we
#    pin to 1 ourselves to match the new gunicorn config). Skipped on a true
#    first-time deploy where no container exists yet — the user is then
#    responsible for the env (e.g. via .env file).
$existing = (docker ps -a --filter "name=^${ContainerName}$" --format '{{.Names}}') -as [string]
$envSavePath = $null
if ($existing -eq $ContainerName) {
    $envSavePath = Join-Path $env:TEMP "${ContainerName}.env"
    Write-Host "[1/5] Saving env from $ContainerName -> $envSavePath" -ForegroundColor Cyan
    docker inspect $ContainerName --format '{{range .Config.Env}}{{println .}}{{end}}' |
        Where-Object { $_ -and $_ -notmatch '^WEB_CONCURRENCY=' } |
        Set-Content -Path $envSavePath -Encoding ascii
} else {
    Write-Host "[1/5] No existing $ContainerName found - first-time deploy." -ForegroundColor Yellow
    Write-Host "      You must provide env via .env or shell exports yourself." -ForegroundColor Yellow
}

# 2. Build first. If the build fails we deliberately do NOT touch the running
#    container, so the user is never left without a backend.
Write-Host "[2/5] Building $ImageName from $ProjectRoot ..." -ForegroundColor Cyan
docker build -t $ImageName $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUILD FAILED - the running container is untouched. Aborting." -ForegroundColor Red
    exit 1
}

# 3. Stop + remove the old container only after a successful build.
if ($existing -eq $ContainerName) {
    Write-Host "[3/5] Stopping + removing old $ContainerName ..." -ForegroundColor Cyan
    docker stop -t 5 $ContainerName | Out-Null
    docker rm $ContainerName        | Out-Null
} else {
    Write-Host "[3/5] (skipped - no existing container to remove)" -ForegroundColor DarkGray
}

# 4. Run the new container. We assemble the docker run argv as a list so
#    paths with spaces (very common on Windows) survive untouched.
Write-Host "[4/5] Starting new $ContainerName ..." -ForegroundColor Cyan
$runArgs = @(
    'run', '-d',
    '--name',          $ContainerName,
    '--hostname',      $ContainerName,
    '--restart',       'unless-stopped',
    '--network',       $NetworkName,
    '--network-alias', $NetworkAlias,
    '-p',              "${HostPort}:${ContainerPort}",
    '-v',              "${ProjectRoot}:/app",
    '-v',              "${LogsVolume}:/app/logs"
)
if ($envSavePath -and (Test-Path $envSavePath)) {
    $runArgs += @('--env-file', $envSavePath)
}
$runArgs += @('-e', 'WEB_CONCURRENCY=1')
$runArgs += $ImageName

docker @runArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "RUN FAILED - inspect the build output above. The container does NOT exist." -ForegroundColor Red
    exit 1
}

# 5. Wait for warmup (model loading + uvicorn startup) and report.
Write-Host "[5/5] Waiting ${WarmupSeconds}s for warmup ..." -ForegroundColor Cyan
Start-Sleep -Seconds $WarmupSeconds

Write-Host ""
Write-Host "== Status ==" -ForegroundColor Green
docker ps --filter "name=^${ContainerName}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'

Write-Host ""
Write-Host "== Last 10 log lines ==" -ForegroundColor Green
docker logs --tail 10 $ContainerName

Write-Host ""
Write-Host "Done. Test: http://localhost:${HostPort}/" -ForegroundColor Green
