#!/usr/bin/env bash
set -euo pipefail

# If triggered by a tag push (e.g. v26.329.13), install that exact version
if [[ -n "${CEREWORKER_TAG_VERSION:-}" ]]; then
  TAG_VER="${CEREWORKER_TAG_VERSION#v}"  # strip leading v
  PACKAGE_SPEC="@producible/cereworker@${TAG_VER}"
else
  PACKAGE_SPEC="${CEREWORKER_PACKAGE_SPEC:-@producible/cereworker@latest}"
fi
TMP_DIR="$(mktemp -d)"
PREFIX_DIR="$TMP_DIR/prefix"
HOME_DIR="$TMP_DIR/home"
CONFIG_DIR="$HOME_DIR/.cereworker"
LOG_DIR="$TMP_DIR/logs"
if [[ -n "${CEREWORKER_SMOKE_PORT:-}" ]]; then
  PORT="$CEREWORKER_SMOKE_PORT"
else
  PORT="$(node --input-type=module -e "
    import { createServer } from 'node:net';
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') process.exit(1);
      console.log(address.port);
      server.close(() => process.exit(0));
    });
  ")"
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

mkdir -p "$PREFIX_DIR" "$CONFIG_DIR" "$LOG_DIR"

echo "Installing $PACKAGE_SPEC into $PREFIX_DIR"
npm install --prefix "$PREFIX_DIR" "$PACKAGE_SPEC" >/dev/null

CLI_BIN="$PREFIX_DIR/node_modules/.bin/cereworker"
if [[ ! -x "$CLI_BIN" ]]; then
  echo "Failed to find installed cereworker binary at $CLI_BIN" >&2
  exit 1
fi

VERSION_OUTPUT="$("$CLI_BIN" -v)"
echo "$VERSION_OUTPUT"
if ! grep -Eq '^[0-9]{2}\.[0-9]{3,4}\.[0-9]+$' <<<"$(head -n1 <<<"$VERSION_OUTPUT")"; then
  echo "Unexpected version output" >&2
  exit 1
fi

cat >"$CONFIG_DIR/config.yaml" <<EOF
cerebrum:
  defaultProvider: local
  defaultModel: llama3.3
  providers:
    local:
      baseUrl: http://127.0.0.1:11434
      model: llama3.3
cerebellum:
  enabled: false
tools:
  shell:
    enabled: false
  fileOps:
    enabled: false
  http:
    enabled: false
  web:
    enabled: false
  browser:
    enabled: false
hippocampus:
  enabled: false
proactive:
  enabled: false
subAgents:
  enabled: false
gateway:
  mode: standalone
  port: $PORT
EOF

echo "Starting headless service smoke"
HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PATH="$PREFIX_DIR/node_modules/.bin:$PATH" "$CLI_BIN" serve \
  >"$LOG_DIR/serve.stdout.log" 2>"$LOG_DIR/serve.stderr.log" &
SERVER_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >"$LOG_DIR/health.json"; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [[ ! -s "$LOG_DIR/health.json" ]]; then
  echo "Health check never became ready" >&2
  cat "$LOG_DIR/serve.stderr.log" >&2 || true
  exit 1
fi

if ! grep -q '"healthy":true' "$LOG_DIR/health.json"; then
  echo "Unexpected health payload" >&2
  cat "$LOG_DIR/health.json" >&2
  exit 1
fi

kill -TERM "$SERVER_PID"
wait "$SERVER_PID"
unset SERVER_PID

echo "Install smoke passed"
