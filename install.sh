#!/usr/bin/env bash
set -euo pipefail

# CereWorker one-line installer for Linux and macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Producible/CereWorker/main/install.sh | bash

NODE_MIN=22
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

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  info "Installing git..."
  case "$OS" in
    linux)
      case "$DISTRO" in
        debian)  $SUDO apt-get install -y git ;;
        fedora)  $SUDO dnf install -y git ;;
        arch)    $SUDO pacman -S --noconfirm --needed git ;;
        suse)    $SUDO zypper install -y git ;;
        *)       warn "Install git manually — npm needs it for some packages." ;;
      esac
      ;;
    macos)
      # macOS ships with git via Xcode CLT; if missing, xcode-select triggers install
      xcode-select --install 2>/dev/null || true
      ;;
  esac
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

# --- Docker ---

install_docker_linux() {
  info "Installing Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh
  if [ -n "${SUDO_USER:-}" ]; then
    $SUDO usermod -aG docker "$SUDO_USER"
  elif [ "$(id -u)" -ne 0 ]; then
    $SUDO usermod -aG docker "$USER"
  fi
  warn "You may need to log out and back in for the docker group to take effect."
}

install_docker_macos() {
  if command -v brew >/dev/null 2>&1; then
    info "Installing Docker Desktop via Homebrew..."
    brew install --cask docker
    info "Open Docker Desktop from Applications to finish setup."
  else
    warn "Install Docker Desktop manually: https://docs.docker.com/desktop/install/mac-install/"
  fi
}

ensure_docker_group() {
  # Only relevant on Linux — macOS Docker Desktop handles permissions via its own socket
  [ "$OS" != "linux" ] && return
  command -v docker >/dev/null 2>&1 || return

  # Check if user is already in docker group
  local target_user="${SUDO_USER:-$USER}"
  if id -nG "$target_user" 2>/dev/null | grep -qw docker; then
    return
  fi

  info "Adding $target_user to docker group..."
  $SUDO usermod -aG docker "$target_user"
  ok "Added $target_user to docker group (log out and back in to take effect)"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    ok "Docker found"
  else
    info "Docker not found — installing for Cerebellum..."
    case "$OS" in
      linux) install_docker_linux ;;
      macos) install_docker_macos ;;
    esac

    if command -v docker >/dev/null 2>&1; then
      ok "Docker installed"
    else
      warn "Docker installation failed. Install manually: https://docs.docker.com/get-docker/"
      return
    fi
  fi

  ensure_docker_group
}

# --- Main ---

main() {
  printf "\n${BOLD}CereWorker Installer${RESET}\n"
  printf "OS: %s  Distro: %s\n\n" "$OS" "$DISTRO"

  ensure_git
  ensure_node
  install_cereworker
  ensure_docker

  printf "\n${GREEN}${BOLD}CereWorker is ready!${RESET}\n\n"
  printf "  Run ${CYAN}cereworker onboard${RESET} to configure your first setup.\n"
  printf "  Run ${CYAN}cereworker${RESET}         to start the TUI.\n"
  printf "  Run ${CYAN}cereworker serve${RESET}   to run headless (servers/systemd).\n\n"

  # Launch onboarding if interactive
  if [ -t 0 ] && [ -t 1 ]; then
    info "Launching onboarding wizard..."
    # If the user was just added to the docker group, activate it for this session
    if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
      if id -nG 2>/dev/null | grep -qw docker; then
        info "Activating docker group for this session..."
        sg docker -c "cereworker onboard"
      else
        cereworker onboard
      fi
    else
      cereworker onboard
    fi
  fi
}

detect_os
setup_sudo
main
