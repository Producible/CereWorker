# CereWorker one-line installer for Windows
# Usage: irm https://raw.githubusercontent.com/Producible/CereWorker/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$NodeMin = 22
$Pkg = "@producible/cereworker"

function Write-Info($msg)  { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

# --- Node.js ---

function Get-NodeVersion {
    try {
        $ver = (node -v 2>$null)
        if ($ver) {
            return [int]($ver -replace '^v' -split '\.' | Select-Object -First 1)
        }
    } catch {}
    return 0
}

function Install-Node {
    # Try winget first (Windows 11+ / App Installer)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js LTS via winget..."
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        return
    }

    # Try Chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Info "Installing Node.js LTS via Chocolatey..."
        choco install nodejs-lts -y
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        return
    }

    # Manual fallback
    Write-Fail "No package manager found (winget or choco).`nInstall Node.js manually: https://nodejs.org/en/download`nOr install winget: https://aka.ms/getwinget"
}

function Ensure-Node {
    $ver = Get-NodeVersion

    if ($ver -ge $NodeMin) {
        Write-Ok "Node.js v$(node -v) found"
        return
    }

    if ($ver -gt 0) {
        Write-Warn "Node.js v$(node -v) is too old (need >= $NodeMin)"
    } else {
        Write-Info "Node.js not found"
    }

    Install-Node

    # Verify
    $ver = Get-NodeVersion
    if ($ver -lt $NodeMin) {
        Write-Fail "Node.js installation failed. Install Node.js ${NodeMin}+ manually: https://nodejs.org"
    }
    Write-Ok "Node.js v$(node -v) installed"
}

# --- CereWorker ---

function Install-CereWorker {
    if (Get-Command cereworker -ErrorAction SilentlyContinue) {
        Write-Ok "CereWorker already installed"
        Write-Info "Upgrading to latest..."
    } else {
        Write-Info "Installing CereWorker..."
    }

    npm install -g $Pkg
    Write-Ok "CereWorker installed"
}

# --- Main ---

Write-Host ""
Write-Host "CereWorker Installer" -ForegroundColor White -BackgroundColor DarkCyan
Write-Host "Platform: Windows $([System.Environment]::OSVersion.Version)" -ForegroundColor Gray
Write-Host ""

Ensure-Node
Install-CereWorker

Write-Host ""
Write-Host "CereWorker is ready!" -ForegroundColor Green
Write-Host ""
Write-Host "  cereworker onboard  " -NoNewline -ForegroundColor Cyan; Write-Host "- Configure your first setup"
Write-Host "  cereworker          " -NoNewline -ForegroundColor Cyan; Write-Host "- Start the TUI"
Write-Host "  cereworker serve    " -NoNewline -ForegroundColor Cyan; Write-Host "- Run headless (background service)"
Write-Host ""
Write-Host "  Docker Desktop (optional): https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Gray
Write-Host ""

# Launch onboarding if interactive
if ([Environment]::UserInteractive) {
    Write-Info "Launching onboarding wizard..."
    cereworker onboard
}
