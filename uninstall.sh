#!/usr/bin/env bash
set -euo pipefail

# CereWorker uninstaller for Linux and macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Producible/CereWorker/main/uninstall.sh | bash
#   or:  bash uninstall.sh [--yes] [--purge] [--keep-config]

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

# --- Flags ---

YES=false
PURGE=false
KEEP_CONFIG=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y)       YES=true ;;
    --purge)        PURGE=true ;;
    --keep-config)  KEEP_CONFIG=true ;;
    --help|-h)
      printf "Usage: %s [--yes] [--purge] [--keep-config]\n\n" "$0"
      printf "  --yes, -y      Skip confirmation prompts\n"
      printf "  --purge        Also remove Docker image, volumes (model weights, checkpoints)\n"
      printf "  --keep-config  Keep ~/.cereworker/ (preserve config, conversations, memory)\n"
      exit 0
      ;;
    *) warn "Unknown flag: $arg" ;;
  esac
done

# --- Helpers ---

confirm() {
  if $YES; then return 0; fi
  local prompt="$1 [y/N] "
  printf "%b" "$prompt"
  read -r reply
  case "$reply" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

DOCKER=""

find_docker() {
  if command -v docker >/dev/null 2>&1; then
    DOCKER="docker"
  else
    for candidate in /usr/bin/docker /usr/local/bin/docker /snap/bin/docker; do
      if [ -x "$candidate" ]; then
        DOCKER="$candidate"
        break
      fi
    done
  fi

  # Check if we need sudo
  if [ -n "$DOCKER" ]; then
    if ! $DOCKER info >/dev/null 2>&1; then
      if sudo -n $DOCKER info >/dev/null 2>&1; then
        DOCKER="sudo $DOCKER"
      else
        warn "Docker found but cannot connect (daemon not running or permission denied)"
        DOCKER=""
      fi
    fi
  fi
}

REMOVED=()

# --- Docker cleanup ---

remove_docker_container() {
  find_docker
  if [ -z "$DOCKER" ]; then
    info "Docker not available — skipping container cleanup"
    return
  fi

  # Check if container exists
  local cid
  cid=$($DOCKER ps -aq -f name=cereworker-cerebellum 2>/dev/null || true)
  if [ -z "$cid" ]; then
    info "No cereworker-cerebellum container found"
    return
  fi

  info "Stopping and removing cereworker-cerebellum container..."
  $DOCKER stop cereworker-cerebellum >/dev/null 2>&1 || true
  $DOCKER rm cereworker-cerebellum >/dev/null 2>&1 || true
  ok "Removed container cereworker-cerebellum"
  REMOVED+=("Docker container: cereworker-cerebellum")
}

remove_docker_image() {
  if [ -z "$DOCKER" ]; then return; fi

  local iid
  iid=$($DOCKER images -q producible/cereworker-cerebellum 2>/dev/null || true)
  if [ -z "$iid" ]; then
    info "No producible/cereworker-cerebellum image found"
    return
  fi

  info "Removing producible/cereworker-cerebellum Docker image..."
  $DOCKER rmi producible/cereworker-cerebellum:latest >/dev/null 2>&1 || true
  ok "Removed image producible/cereworker-cerebellum"
  REMOVED+=("Docker image: producible/cereworker-cerebellum")
}

remove_docker_volumes() {
  if [ -z "$DOCKER" ]; then return; fi

  local volumes=("cerebellum-models" "cerebellum-checkpoints" "cerebellum-data")
  for vol in "${volumes[@]}"; do
    if $DOCKER volume inspect "$vol" >/dev/null 2>&1; then
      info "Removing Docker volume $vol..."
      $DOCKER volume rm "$vol" >/dev/null 2>&1 || true
      ok "Removed volume $vol"
      REMOVED+=("Docker volume: $vol")
    fi
  done
}

# --- Systemd cleanup ---

remove_systemd_services() {
  # Only on Linux with systemd
  if ! command -v systemctl >/dev/null 2>&1; then return; fi

  local services=("cereworker-gateway" "cereworker-node")
  for svc in "${services[@]}"; do
    # Check user-level services
    local unit_file="$HOME/.config/systemd/user/${svc}.service"
    if [ -f "$unit_file" ]; then
      info "Stopping and disabling ${svc}.service..."
      systemctl --user stop "$svc" 2>/dev/null || true
      systemctl --user disable "$svc" 2>/dev/null || true
      rm -f "$unit_file"
      ok "Removed ${svc}.service"
      REMOVED+=("Systemd service: ${svc}")
    fi

    # Check system-level services
    local sys_unit="/etc/systemd/system/${svc}.service"
    if [ -f "$sys_unit" ]; then
      info "Stopping and disabling system ${svc}.service..."
      sudo -n systemctl stop "$svc" 2>/dev/null || true
      sudo -n systemctl disable "$svc" 2>/dev/null || true
      sudo -n rm -f "$sys_unit" 2>/dev/null || warn "Cannot remove $sys_unit (needs sudo)"
      ok "Removed system ${svc}.service"
      REMOVED+=("Systemd service (system): ${svc}")
    fi
  done

  # Reload if anything was removed
  systemctl --user daemon-reload 2>/dev/null || true
}

# --- Config directory ---

remove_config_dir() {
  local config_dir="$HOME/.cereworker"
  if [ ! -d "$config_dir" ]; then
    info "No ~/.cereworker directory found"
    return
  fi

  if $KEEP_CONFIG; then
    info "Keeping ~/.cereworker/ (--keep-config)"
    return
  fi

  info "Removing ~/.cereworker/ (config, conversations, memory, tokens)..."
  rm -rf "$config_dir"
  ok "Removed ~/.cereworker/"
  REMOVED+=("Config directory: ~/.cereworker/")
}

# --- npm package ---

remove_npm_package() {
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found — cannot uninstall @producible/cereworker"
    return
  fi

  if ! command -v cereworker >/dev/null 2>&1; then
    info "cereworker CLI not found in PATH"
    return
  fi

  info "Uninstalling @producible/cereworker..."
  npm uninstall -g @producible/cereworker 2>/dev/null || true
  ok "Uninstalled @producible/cereworker"
  REMOVED+=("npm package: @producible/cereworker")
}

# --- Main ---

main() {
  printf "\n${BOLD}CereWorker Uninstaller${RESET}\n\n"

  if ! confirm "This will uninstall CereWorker from your system. Continue?"; then
    info "Cancelled."
    exit 0
  fi

  printf "\n"

  # 1. Docker container (always)
  remove_docker_container

  # 2. Docker image + volumes (only with --purge)
  if $PURGE; then
    remove_docker_image
    remove_docker_volumes
  else
    info "Keeping Docker image and volumes (use --purge to remove model weights and checkpoints)"
  fi

  # 3. Systemd services
  remove_systemd_services

  # 4. Config directory
  remove_config_dir

  # 5. npm package
  remove_npm_package

  # Summary
  printf "\n${BOLD}Done.${RESET}\n"
  if [ ${#REMOVED[@]} -eq 0 ]; then
    info "Nothing was removed."
  else
    printf "\nRemoved:\n"
    for item in "${REMOVED[@]}"; do
      printf "  ${GREEN}✓${RESET} %s\n" "$item"
    done
  fi

  if ! $PURGE; then
    printf "\n${YELLOW}Note:${RESET} Docker image and volumes were kept. To remove them:\n"
    printf "  docker rmi producible/cereworker-cerebellum:latest\n"
    printf "  docker volume rm cerebellum-models cerebellum-checkpoints cerebellum-data\n"
    printf "  Or re-run: %s --purge\n" "$0"
  fi

  if $KEEP_CONFIG; then
    printf "\n${YELLOW}Note:${RESET} Config directory ~/.cereworker/ was kept.\n"
  fi

  printf "\n"
}

main
