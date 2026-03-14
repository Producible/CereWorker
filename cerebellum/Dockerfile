FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir .

# Generate proto files
COPY --from=proto / /app/proto/
RUN mkdir -p /app/src/proto && python -m grpc_tools.protoc \
    -I/app/proto \
    --python_out=/app/src/proto \
    --grpc_python_out=/app/src/proto \
    /app/proto/cerebellum.proto \
    && sed -i 's/^import cerebellum_pb2/from src.proto import cerebellum_pb2/' /app/src/proto/cerebellum_pb2_grpc.py \
    && touch /app/src/proto/__init__.py

COPY src/ /app/src/

RUN mkdir -p /checkpoints /data

EXPOSE 50051

ENV MODEL_PATH=Qwen/Qwen3-0.6B
ENV HEARTBEAT_INTERVAL=30
ENV CEREBELLUM_PORT=50051

CMD ["python", "-m", "src.server"]
