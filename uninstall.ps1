# CereWorker uninstaller for Windows
# Usage: irm https://raw.githubusercontent.com/Producible/CereWorker/main/uninstall.ps1 | iex
#   or:  .\uninstall.ps1 [-Yes] [-Purge] [-KeepConfig]

param(
    [switch]$Yes,
    [switch]$Purge,
    [switch]$KeepConfig
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg)  { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

$Removed = @()

function Confirm-Action($prompt) {
    if ($Yes) { return $true }
    $reply = Read-Host "$prompt [y/N]"
    return $reply -match '^[Yy]'
}

function Test-DockerAvailable {
    try {
        docker info 2>$null | Out-Null
        return $true
    } catch {
        return $false
    }
}

# --- Docker cleanup ---

function Remove-DockerContainer {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Info "Docker not found - skipping container cleanup"
        return
    }
    if (-not (Test-DockerAvailable)) {
        Write-Warn "Docker not running - skipping container cleanup"
        return
    }

    $cid = docker ps -aq -f name=cereworker-cerebellum 2>$null
    if (-not $cid) {
        Write-Info "No cereworker-cerebellum container found"
        return
    }

    Write-Info "Stopping and removing cereworker-cerebellum container..."
    docker stop cereworker-cerebellum 2>$null | Out-Null
    docker rm cereworker-cerebellum 2>$null | Out-Null
    Write-Ok "Removed container cereworker-cerebellum"
    $script:Removed += "Docker container: cereworker-cerebellum"
}

function Remove-DockerImage {
    if (-not (Test-DockerAvailable)) { return }

    $iid = docker images -q producible/cereworker-cerebellum 2>$null
    if (-not $iid) {
        Write-Info "No producible/cereworker-cerebellum image found"
        return
    }

    Write-Info "Removing producible/cereworker-cerebellum Docker image..."
    docker rmi producible/cereworker-cerebellum:latest 2>$null | Out-Null
    Write-Ok "Removed image producible/cereworker-cerebellum"
    $script:Removed += "Docker image: producible/cereworker-cerebellum"
}

function Remove-DockerVolumes {
    if (-not (Test-DockerAvailable)) { return }

    $volumes = @("cerebellum-models", "cerebellum-checkpoints", "cerebellum-data")
    foreach ($vol in $volumes) {
        $exists = docker volume inspect $vol 2>$null
        if ($exists) {
            Write-Info "Removing Docker volume $vol..."
            docker volume rm $vol 2>$null | Out-Null
            Write-Ok "Removed volume $vol"
            $script:Removed += "Docker volume: $vol"
        }
    }
}

# --- Config directory ---

function Remove-ConfigDir {
    $configDir = Join-Path $HOME ".cereworker"

    if (-not (Test-Path $configDir)) {
        Write-Info "No ~/.cereworker directory found"
        return
    }

    if ($KeepConfig) {
        Write-Info "Keeping ~/.cereworker/ (-KeepConfig)"
        return
    }

    Write-Info "Removing ~/.cereworker/ (config, conversations, memory, tokens)..."
    Remove-Item -Recurse -Force $configDir
    Write-Ok "Removed ~/.cereworker/"
    $script:Removed += "Config directory: ~/.cereworker/"
}

# --- npm package ---

function Remove-NpmPackage {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warn "npm not found - cannot uninstall @producible/cereworker"
        return
    }

    if (-not (Get-Command cereworker -ErrorAction SilentlyContinue)) {
        Write-Info "cereworker CLI not found in PATH"
        return
    }

    Write-Info "Uninstalling @producible/cereworker..."
    npm uninstall -g @producible/cereworker 2>$null
    Write-Ok "Uninstalled @producible/cereworker"
    $script:Removed += "npm package: @producible/cereworker"
}

# --- Main ---

Write-Host ""
Write-Host "CereWorker Uninstaller" -ForegroundColor White -BackgroundColor DarkCyan
Write-Host ""

if (-not (Confirm-Action "This will uninstall CereWorker from your system. Continue?")) {
    Write-Info "Cancelled."
    exit 0
}

Write-Host ""

# 1. Docker container (always)
Remove-DockerContainer

# 2. Docker image + volumes (only with -Purge)
if ($Purge) {
    Remove-DockerImage
    Remove-DockerVolumes
} else {
    Write-Info "Keeping Docker image and volumes (use -Purge to remove model weights and checkpoints)"
}

# 3. Config directory
Remove-ConfigDir

# 4. npm package
Remove-NpmPackage

# Summary
Write-Host ""
Write-Host "Done." -ForegroundColor Green -NoNewline
Write-Host ""

if ($Removed.Count -eq 0) {
    Write-Info "Nothing was removed."
} else {
    Write-Host ""
    Write-Host "Removed:"
    foreach ($item in $Removed) {
        Write-Host "  + $item" -ForegroundColor Green
    }
}

if (-not $Purge) {
    Write-Host ""
    Write-Warn "Docker image and volumes were kept. To remove them:"
    Write-Host "  docker rmi producible/cereworker-cerebellum:latest"
    Write-Host "  docker volume rm cerebellum-models cerebellum-checkpoints cerebellum-data"
    Write-Host "  Or re-run: .\uninstall.ps1 -Purge"
}

if ($KeepConfig) {
    Write-Host ""
    Write-Warn "Config directory ~/.cereworker/ was kept."
}

Write-Host ""
