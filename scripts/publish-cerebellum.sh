#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="cereworker/cerebellum"

echo "Building CPU image ($IMAGE:latest)..."
docker build \
  -t "$IMAGE:latest" \
  -f cerebellum/Dockerfile \
  --build-context proto=./proto \
  ./cerebellum

echo "Building GPU image ($IMAGE:gpu)..."
docker build \
  -t "$IMAGE:gpu" \
  -f cerebellum/Dockerfile.gpu \
  --build-context proto=./proto \
  ./cerebellum

echo ""
echo "Images built:"
docker images "$IMAGE" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"

read -p "Push to Docker Hub? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  docker push "$IMAGE:latest"
  docker push "$IMAGE:gpu"
  echo "Pushed $IMAGE:latest and $IMAGE:gpu"
else
  echo "Skipped push. Run manually:"
  echo "  docker push $IMAGE:latest"
  echo "  docker push $IMAGE:gpu"
fi
