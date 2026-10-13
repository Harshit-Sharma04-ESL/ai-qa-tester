#!/usr/bin/env bash
# One-command start: checks Docker, detects hardware, picks a model, starts app + Ollama + browser.
#   ./start.sh             start (uses .env if present, otherwise creates it from hardware detection)
#   ./start.sh --redetect  re-run hardware detection and overwrite the model settings in .env
#   ./start.sh --down      stop everything
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- docker
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it with:  curl -fsSL https://get.docker.com | sh"
docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running (try: sudo systemctl start docker)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)"

compose_files=(-f docker-compose.yml)
if [ "${1:-}" = "--down" ]; then docker compose "${compose_files[@]}" -f docker-compose.gpu.yml down; exit 0; fi

# ---------------------------------------------------------------- hardware -> model
eval "$(bash scripts/detect-hardware.sh)"
say "Hardware: $HW_SUMMARY"
if [ ! -f .env ] || [ "${1:-}" = "--redetect" ]; then
  base=.env; [ -f .env ] || base=.env.example
  # Keep the user's other settings, replace only the detected ones.
  grep -vE '^(HW_SUMMARY|USE_GPU|OLLAMA_MODEL|VISION_MODEL|MODEL_REASON)=' "$base" > .env.tmp 2>/dev/null || true
  printf 'HW_SUMMARY="%s"\nUSE_GPU="%s"\nOLLAMA_MODEL="%s"\nVISION_MODEL="%s"\nMODEL_REASON="%s"\n' \
    "$HW_SUMMARY" "$USE_GPU" "$OLLAMA_MODEL" "$VISION_MODEL" "$MODEL_REASON" >> .env.tmp
  mv .env.tmp .env
  say "Wrote model choice to .env"
fi
set -a; . ./.env; set +a
say "Model: ${OLLAMA_MODEL}  (${MODEL_REASON})"
[ "${USE_GPU:-false}" = "true" ] && compose_files+=(-f docker-compose.gpu.yml) && say "Using NVIDIA GPU for Ollama"

# ---------------------------------------------------------------- existing standalone Ollama
# A container started with `docker run --name ollama -p 11434:11434 ollama/ollama` would hold the port.
# Compose runs its own Ollama on the same "ollama" volume, so already-downloaded models are reused.
if docker ps --format '{{.Names}}' | grep -qx ollama; then
  if [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ollama)" = "" ]; then
    say "Stopping standalone 'ollama' container (compose will run Ollama with the same model volume)"
    docker stop ollama >/dev/null
  fi
fi

# ---------------------------------------------------------------- start
say "Building and starting containers…"
docker compose "${compose_files[@]}" up -d --build

say "Making sure ${OLLAMA_MODEL} is downloaded (first time can take a few minutes)…"
docker compose "${compose_files[@]}" exec -T ollama ollama pull "${OLLAMA_MODEL}"
[ -n "${VISION_MODEL:-}" ] && [ "${VISION_MODEL}" != "${OLLAMA_MODEL}" ] && docker compose "${compose_files[@]}" exec -T ollama ollama pull "${VISION_MODEL}"

port="${APP_PORT:-8080}"
say "Waiting for the dashboard…"
for _ in $(seq 1 60); do
  curl -fs "http://localhost:${port}/api/settings" >/dev/null 2>&1 && break
  sleep 2
done
curl -fs "http://localhost:${port}/api/settings" >/dev/null 2>&1 || die "App did not come up. Check: docker compose logs app"
say "Ready → http://localhost:${port}"
