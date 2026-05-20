# syntax=docker/dockerfile:1

# Stage 1: Build — compile protos (build-essential not needed in runtime)
FROM python:3.12-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --default-timeout=1000 "grpcio-tools>=1.68.0"

COPY proto/ /app/proto/
RUN mkdir -p /app/src/proto && python -m grpc_tools.protoc \
    -I/app/proto \
    --python_out=/app/src/proto \
    --grpc_python_out=/app/src/proto \
    /app/proto/cerebellum.proto \
    && sed -i 's/^import cerebellum_pb2/from src.proto import cerebellum_pb2/' /app/src/proto/cerebellum_pb2_grpc.py \
    && touch /app/src/proto/__init__.py

# Stage 2: Runtime — CPU-only torch, no build tools
FROM python:3.12-slim
WORKDIR /app

ARG CEREWORKER_VERSION=dev
# Image tag is version-pinned by the CLI (see apps/cli/src/cerebellum-docker.ts).
# Both install (postinstall.mjs) and uninstall (uninstall.sh / .ps1) target
# producible/cereworker-cerebellum:<version>, not the floating :latest tag.
# Tag-time validation lives inside .github/workflows/publish.yml so the smoke
# never races the artifact it depends on (was a real issue in v26.520.3).
# Propagation poll is a single global retry loop bounded under the job timeout.
LABEL org.opencontainers.image.version=$CEREWORKER_VERSION
LABEL org.opencontainers.image.title="CereWorker Cerebellum"
LABEL org.opencontainers.image.source="https://github.com/Producible/CereWorker"
LABEL org.opencontainers.image.ref.name="producible/cereworker-cerebellum"

COPY cerebellum/pyproject.toml ./pyproject.toml

# Install CPU-only torch first, then the rest of the deps.
# The explicit --index-url ensures pip doesn't pull the ~2 GB CUDA variant.
RUN pip install --no-cache-dir --default-timeout=1000 torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir --default-timeout=1000 ".[finetune]"

COPY --from=builder /app/src/proto /app/src/proto
COPY cerebellum/src/ /app/src/

RUN mkdir -p /checkpoints /data

EXPOSE 50051

ENV MODEL_PATH=Qwen/Qwen3-0.6B
ENV HEARTBEAT_INTERVAL=30
ENV CEREBELLUM_PORT=50051

CMD ["python", "-m", "src.server"]
