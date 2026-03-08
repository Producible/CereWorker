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
COPY proto/ /app/proto/
RUN python -m grpc_tools.protoc \
    -I/app/proto \
    --python_out=/app/src/proto \
    --grpc_python_out=/app/src/proto \
    /app/proto/cerebellum.proto

COPY src/ /app/src/

EXPOSE 50051

ENV MODEL_PATH=Qwen/Qwen3-0.6B
ENV HEARTBEAT_INTERVAL=30
ENV CEREBELLUM_PORT=50051

CMD ["python", "-m", "src.server"]
