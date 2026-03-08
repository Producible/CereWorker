"""gRPC server for the Cerebellum service."""

import asyncio
import logging
import os
import sys
import time
from concurrent import futures

import grpc
from grpc import aio

# Add parent directory to path for proto imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.inference import CerebellumInference
from src.heartbeat import HeartbeatEngine

# These will be generated from proto/cerebellum.proto
# For now, use grpc reflection or dynamic loading
from src.proto import cerebellum_pb2, cerebellum_pb2_grpc

logger = logging.getLogger(__name__)


class CerebellumServicer(cerebellum_pb2_grpc.CerebellumServicer):
    """gRPC service implementation for the Cerebellum."""

    def __init__(self, heartbeat: HeartbeatEngine, start_time: float):
        self.heartbeat = heartbeat
        self.start_time = start_time
        self.inference = heartbeat.inference

    async def Heartbeat(self, request, context):
        """Manual heartbeat trigger with provided task states."""
        tasks = [
            {
                "task_id": t.task_id,
                "description": t.description,
                "status": t.status,
                "last_run": t.last_run,
                "schedule_hint": t.schedule_hint,
                "metadata": dict(t.metadata),
            }
            for t in request.tasks
        ]

        actions = self.inference.evaluate_tasks(
            tasks, request.system_summary, request.timestamp
        )

        response = cerebellum_pb2.HeartbeatResponse()
        for action in actions:
            ta = response.actions.add()
            ta.task_id = action["task_id"]
            ta.action = action["action"]
            ta.reason = action["reason"]
        return response

    async def RegisterTask(self, request, context):
        task_id = self.heartbeat.register_task(
            request.description,
            request.schedule_hint,
            dict(request.metadata) if request.metadata else None,
        )
        return cerebellum_pb2.RegisterTaskResponse(task_id=task_id)

    async def UnregisterTask(self, request, context):
        self.heartbeat.unregister_task(request.task_id)
        return cerebellum_pb2.UnregisterTaskResponse()

    async def ListTasks(self, request, context):
        tasks = self.heartbeat.list_tasks()
        response = cerebellum_pb2.ListTasksResponse()
        for t in tasks:
            ts = response.tasks.add()
            ts.task_id = t["task_id"]
            ts.description = t["description"]
            ts.status = t["status"]
            ts.last_run = t.get("last_run", 0)
            ts.schedule_hint = t.get("schedule_hint", "")
            for k, v in t.get("metadata", {}).items():
                ts.metadata[k] = v
        return response

    async def GetStatus(self, request, context):
        uptime = int(time.time() - self.start_time)
        return cerebellum_pb2.StatusResponse(
            healthy=self.inference.is_loaded(),
            model_name=self.inference.model_path,
            uptime_seconds=uptime,
            tasks_registered=len(self.heartbeat.tasks),
        )

    async def SubscribeHeartbeat(self, request, context):
        """Stream heartbeat events to the client."""
        interval = request.interval_seconds or 30
        queue: asyncio.Queue = asyncio.Queue()

        async def on_event(event):
            await queue.put(event)

        self.heartbeat.add_subscriber(on_event)

        try:
            while context.is_active():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=interval + 5)
                    hb_event = cerebellum_pb2.HeartbeatEvent(timestamp=event["timestamp"])
                    for action in event["actions"]:
                        ta = hb_event.actions.add()
                        ta.task_id = action["task_id"]
                        ta.action = action["action"]
                        ta.reason = action["reason"]
                    yield hb_event
                except asyncio.TimeoutError:
                    continue
        finally:
            self.heartbeat.remove_subscriber(on_event)


async def serve(
    port: int = 50051,
    model_path: str = "Qwen/Qwen3-0.6B",
    heartbeat_interval: int = 30,
):
    """Start the Cerebellum gRPC server."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    logger.info(f"Initializing Cerebellum with model: {model_path}")

    inference = CerebellumInference(model_path)
    inference.load()

    heartbeat = HeartbeatEngine(inference, heartbeat_interval)
    start_time = time.time()

    server = aio.server(futures.ThreadPoolExecutor(max_workers=4))
    servicer = CerebellumServicer(heartbeat, start_time)
    cerebellum_pb2_grpc.add_CerebellumServicer_to_server(servicer, server)

    listen_addr = f"[::]:{port}"
    server.add_insecure_port(listen_addr)

    logger.info(f"Starting gRPC server on {listen_addr}")
    await server.start()

    # Start heartbeat loop in background
    heartbeat_task = asyncio.create_task(heartbeat.run())

    logger.info("Cerebellum service is ready")

    try:
        await server.wait_for_termination()
    finally:
        heartbeat.stop()
        heartbeat_task.cancel()


def main():
    port = int(os.environ.get("CEREBELLUM_PORT", "50051"))
    model_path = os.environ.get("MODEL_PATH", "Qwen/Qwen3-0.6B")
    heartbeat_interval = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))

    asyncio.run(serve(port, model_path, heartbeat_interval))


if __name__ == "__main__":
    main()
