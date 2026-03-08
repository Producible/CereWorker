#!/bin/bash
# Generate Python protobuf files from proto/cerebellum.proto
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROTO_DIR="$(dirname "$ROOT_DIR")/proto"
OUT_DIR="$ROOT_DIR/src/proto"

mkdir -p "$OUT_DIR"

python -m grpc_tools.protoc \
    -I"$PROTO_DIR" \
    --python_out="$OUT_DIR" \
    --grpc_python_out="$OUT_DIR" \
    "$PROTO_DIR/cerebellum.proto"

# Fix import paths in generated grpc file
sed -i 's/import cerebellum_pb2/from . import cerebellum_pb2/' "$OUT_DIR/cerebellum_pb2_grpc.py"

echo "Proto files generated in $OUT_DIR"
