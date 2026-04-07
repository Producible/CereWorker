#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="cereworker/cerebellum"
VERSION="$(node -p "require('./apps/cli/package.json').version")"

echo "Building CPU image ($IMAGE:$VERSION and $IMAGE:latest)..."
docker build \
  --build-arg "CEREWORKER_VERSION=$VERSION" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  -f cerebellum/Dockerfile \
  .

echo "Building GPU image ($IMAGE:${VERSION}-gpu and $IMAGE:gpu)..."
docker build \
  --build-arg "CEREWORKER_VERSION=$VERSION" \
  -t "$IMAGE:${VERSION}-gpu" \
  -t "$IMAGE:gpu" \
  -f cerebellum/Dockerfile.gpu \
  .

echo ""
echo "Images built:"
docker images "$IMAGE" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"

read -p "Push to Docker Hub? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  docker push "$IMAGE:${VERSION}-gpu"
  docker push "$IMAGE:gpu"
  echo "Pushed $IMAGE:$VERSION, $IMAGE:latest, $IMAGE:${VERSION}-gpu, and $IMAGE:gpu"
else
  echo "Skipped push. Run manually:"
  echo "  docker push $IMAGE:$VERSION"
  echo "  docker push $IMAGE:latest"
  echo "  docker push $IMAGE:${VERSION}-gpu"
  echo "  docker push $IMAGE:gpu"
fi
