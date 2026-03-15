#!/usr/bin/env bash
set -euo pipefail

# CereWorker one-line installer for Linux and macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Producible/CereWorker/main/install.sh | bash

NODE_MIN=20
PKG="@cereworker/cli"

# --- Colors ---

if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()  { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[x]${RESET} %s\n" "$*" >&2; exit 1; }

# --- OS detection ---

OS=""
DISTRO="unknown"
SUDO=""

detect_os() {
  case "$(uname -s)" in
    Linux)
      OS="linux"
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-}" in
          ubuntu|debian|pop|linuxmint|elementary|kali|raspbian) DISTRO="debian" ;;
          fedora|rhel|centos|rocky|alma|ol|amzn) DISTRO="fedora" ;;
          arch|manjaro|endeavouros) DISTRO="arch" ;;
          opensuse*|sles) DISTRO="suse" ;;
          *) DISTRO="unknown" ;;
        esac
      fi
      ;;
    Darwin)
      OS="macos"
      DISTRO="macos"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      fail "Windows detected. Use PowerShell instead:\n  irm https://raw.githubusercontent.com/Producible/CereWorker/main/install.ps1 | iex"
      ;;
    *)
      fail "Unsupported OS: $(uname -s)"
      ;;
  esac
}

setup_sudo() {
  if [ "$OS" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
      fail "This script requires sudo. Run as root or install sudo first."
    fi
    SUDO="sudo"
  fi
}

# --- Node.js ---

node_version() {
  if command -v node >/dev/null 2>&1; then
    node -v | sed 's/^v//' | cut -d. -f1
  else
    echo "0"
  fi
}

install_node_linux() {
  case "$DISTRO" in
    debian)
      info "Installing Node.js ${NODE_MIN}.x via NodeSource..."
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO apt-get install -y nodejs
      ;;
    fedora)
      info "Installing Node.js ${NODE_MIN}.x via NodeSource..."
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO dnf install -y nodejs
      ;;
    arch)
      info "Installing Node.js via pacman..."
      $SUDO pacman -S --noconfirm --needed nodejs npm
      ;;
    suse)
      info "Installing Node.js ${NODE_MIN}.x via NodeSource..."
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO zypper install -y nodejs
      ;;
    *)
      fail "Cannot auto-install Node.js on this Linux distro ($DISTRO).\nInstall Node.js ${NODE_MIN}+ manually: https://nodejs.org/en/download"
      ;;
  esac
}

install_node_macos() {
  if command -v brew >/dev/null 2>&1; then
    info "Installing Node.js via Homebrew..."
    brew install node
  else
    fail "Homebrew not found. Install Node.js manually:\n  https://nodejs.org/en/download\n\nOr install Homebrew first:\n  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  fi
}

ensure_node() {
  local ver
  ver=$(node_version)

  if [ "$ver" -ge "$NODE_MIN" ]; then
    ok "Node.js v$(node -v | sed 's/^v//') found"
    return
  fi

  if [ "$ver" -gt 0 ]; then
    warn "Node.js v$(node -v | sed 's/^v//') is too old (need >= ${NODE_MIN})"
  else
    info "Node.js not found"
  fi

  case "$OS" in
    linux) install_node_linux ;;
    macos) install_node_macos ;;
  esac

  # Verify
  ver=$(node_version)
  if [ "$ver" -lt "$NODE_MIN" ]; then
    fail "Node.js installation failed. Install Node.js ${NODE_MIN}+ manually: https://nodejs.org"
  fi
  ok "Node.js v$(node -v | sed 's/^v//') installed"
}

# --- CereWorker ---

install_cereworker() {
  if command -v cereworker >/dev/null 2>&1; then
    ok "CereWorker already installed ($(cereworker --version 2>/dev/null || echo 'unknown'))"
    info "Upgrading to latest..."
  else
    info "Installing CereWorker..."
  fi

  npm install -g "$PKG"
  ok "CereWorker installed"
}

# --- Optional: Docker & build tools ---

run_setup() {
  info "Setting up optional dependencies (Docker, build tools)..."
  cereworker setup --all || warn "Optional setup had issues — you can re-run with: cereworker setup"
}

# --- Main ---

main() {
  printf "\n${BOLD}CereWorker Installer${RESET}\n"
  printf "OS: %s  Distro: %s\n\n" "$OS" "$DISTRO"

  ensure_node
  install_cereworker
  run_setup

  printf "\n${GREEN}${BOLD}CereWorker is ready!${RESET}\n\n"
  printf "  Run ${CYAN}cereworker onboard${RESET} to configure your first setup.\n"
  printf "  Run ${CYAN}cereworker${RESET}         to start the TUI.\n"
  printf "  Run ${CYAN}cereworker serve${RESET}   to run headless (servers/systemd).\n\n"

  # Launch onboarding if interactive
  if [ -t 0 ] && [ -t 1 ]; then
    info "Launching onboarding wizard..."
    cereworker onboard
  fi
}

detect_os
setup_sudo
main
