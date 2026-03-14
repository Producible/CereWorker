#!/usr/bin/env bash
set -euo pipefail

# CereWorker setup script
# Detects OS and installs Docker and/or build tools.
# Usage: setup.sh [--docker] [--build-tools] [--all]

INSTALL_DOCKER=false
INSTALL_BUILD=false

parse_args() {
  if [ $# -eq 0 ]; then
    INSTALL_DOCKER=true
    INSTALL_BUILD=true
    return
  fi
  for arg in "$@"; do
    case "$arg" in
      --docker) INSTALL_DOCKER=true ;;
      --build-tools) INSTALL_BUILD=true ;;
      --all) INSTALL_DOCKER=true; INSTALL_BUILD=true ;;
      -h|--help)
        echo "Usage: setup.sh [--docker] [--build-tools] [--all]"
        echo "  --docker       Install Docker"
        echo "  --build-tools  Install native build tools (build-essential, etc.)"
        echo "  --all          Install everything (default if no flags given)"
        exit 0
        ;;
      *) echo "Unknown flag: $arg"; exit 1 ;;
    esac
  done
}

# --- OS detection ---

OS=""
DISTRO="unknown"

detect_os() {
  case "$(uname -s)" in
    Linux)
      OS="linux"
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "$ID" in
          ubuntu|debian|pop|linuxmint|elementary) DISTRO="debian" ;;
          fedora|rhel|centos|rocky|alma|ol) DISTRO="fedora" ;;
          arch|manjaro|endeavouros) DISTRO="arch" ;;
          *) DISTRO="unknown" ;;
        esac
      fi
      ;;
    Darwin)
      OS="macos"
      DISTRO="macos"
      ;;
    *)
      echo "Unsupported OS: $(uname -s)"
      exit 1
      ;;
  esac
}

# --- Presence checks ---

has_docker() {
  command -v docker >/dev/null 2>&1
}

has_build_tools() {
  case "$OS" in
    linux)
      case "$DISTRO" in
        debian)  dpkg -s build-essential >/dev/null 2>&1 ;;
        fedora)  rpm -q gcc make >/dev/null 2>&1 ;;
        arch)    pacman -Qi base-devel >/dev/null 2>&1 ;;
        *)       command -v gcc >/dev/null 2>&1 && command -v make >/dev/null 2>&1 ;;
      esac
      ;;
    macos)
      xcode-select -p >/dev/null 2>&1
      ;;
  esac
}

# --- Helpers ---

need_sudo() {
  if [ "$OS" = "linux" ] && [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Error: This script requires sudo but it is not installed."
      echo "Run as root or install sudo first."
      exit 1
    fi
    SUDO="sudo"
  else
    SUDO=""
  fi
}

# --- Install functions ---

install_docker_linux() {
  echo "Installing Docker via get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh
  # Add current user to docker group
  if [ -n "${SUDO_USER:-}" ]; then
    $SUDO usermod -aG docker "$SUDO_USER"
  elif [ "$(id -u)" -ne 0 ]; then
    $SUDO usermod -aG docker "$USER"
  fi
  echo ""
  echo "NOTE: You may need to log out and back in for the docker group to take effect."
}

install_docker_macos() {
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Docker Desktop via Homebrew..."
    brew install --cask docker
    echo "Open Docker Desktop from Applications to finish setup."
  else
    echo "Homebrew not found. Install Docker Desktop manually:"
    echo "  https://docs.docker.com/desktop/install/mac-install/"
    return 1
  fi
}

install_build_tools_linux() {
  case "$DISTRO" in
    debian)
      echo "Installing build-essential..."
      $SUDO apt-get update -qq
      $SUDO apt-get install -y build-essential python3
      ;;
    fedora)
      echo "Installing Development Tools..."
      $SUDO dnf groupinstall -y "Development Tools"
      $SUDO dnf install -y python3
      ;;
    arch)
      echo "Installing base-devel..."
      $SUDO pacman -S --noconfirm --needed base-devel python
      ;;
    *)
      echo "Unknown Linux distro. Install gcc, g++, make, and python3 manually."
      return 1
      ;;
  esac
}

install_build_tools_macos() {
  echo "Installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "If a dialog appeared, follow the prompts to complete installation."
}

# --- Main ---

main() {
  parse_args "$@"
  detect_os
  need_sudo

  echo "CereWorker Setup"
  echo "OS: $OS  Distro: $DISTRO"
  echo ""

  installed=()
  skipped=()

  # Docker
  if [ "$INSTALL_DOCKER" = true ]; then
    if has_docker; then
      skipped+=("Docker (already installed)")
    else
      case "$OS" in
        linux) install_docker_linux ;;
        macos) install_docker_macos ;;
      esac
      installed+=("Docker")
    fi
  fi

  # Build tools
  if [ "$INSTALL_BUILD" = true ]; then
    if has_build_tools; then
      skipped+=("Build tools (already installed)")
    else
      case "$OS" in
        linux) install_build_tools_linux ;;
        macos) install_build_tools_macos ;;
      esac
      installed+=("Build tools")
    fi
  fi

  # Summary
  echo ""
  echo "--- Summary ---"
  if [ ${#installed[@]} -gt 0 ]; then
    echo "Installed: ${installed[*]}"
  fi
  if [ ${#skipped[@]} -gt 0 ]; then
    echo "Skipped:   ${skipped[*]}"
  fi
  if [ ${#installed[@]} -eq 0 ] && [ ${#skipped[@]} -eq 0 ]; then
    echo "Nothing to do."
  fi
}

main "$@"
