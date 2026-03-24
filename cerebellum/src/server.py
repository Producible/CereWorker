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
from src.verification import ToolVerifier
from src.agent_monitor import AgentMonitor
from src.finetune import FineTuneEngine

# These will be generated from proto/cerebellum.proto
from src.proto import cerebellum_pb2, cerebellum_pb2_grpc

logger = logging.getLogger(__name__)


class CerebellumServicer(cerebellum_pb2_grpc.CerebellumServicer):
    """gRPC service implementation for the Cerebellum."""

    def __init__(
        self,
        heartbeat: HeartbeatEngine,
        verifier: ToolVerifier,
        agent_monitor: AgentMonitor,
        finetune: FineTuneEngine,
        start_time: float,
    ):
        self.heartbeat = heartbeat
        self.verifier = verifier
        self.agent_monitor = agent_monitor
        self.finetune = finetune
        self.start_time = start_time
        self.inference = heartbeat.inference
        self._last_agent_actions = []

    async def Heartbeat(self, request, context):
        """Manual heartbeat trigger — evaluates tasks with binary yes/no."""
        timestamp = request.timestamp or int(time.time())

        # Use the heartbeat engine's own tick logic for consistency
        # but we can also do a simple pass here for manual triggers
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

        # For manual heartbeat, register temporary tasks and evaluate
        actions = []
        system_busy = any(t["status"] == "running" for t in tasks)
        for task in tasks:
            elapsed = timestamp - task.get("last_run", 0)
            should_run = self.inference.should_run_task(
                description=task["description"],
                elapsed_seconds=elapsed,
                schedule_hint=task.get("schedule_hint", ""),
                system_busy=system_busy,
            )
            actions.append({
                "task_id": task["task_id"],
                "action": "invoke" if should_run else "skip",
                "reason": "model",
            })

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
            while True:
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
        except asyncio.CancelledError:
            pass
        finally:
            self.heartbeat.remove_subscriber(on_event)

    async def VerifyToolResult(self, request, context):
        """Verify a tool execution result via programmatic checks + model verdict."""
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            self.verifier.verify,
            request.tool_name,
            dict(request.tool_args),
            request.tool_output,
            request.claimed_success,
        )

        response = cerebellum_pb2.VerifyResponse(
            passed=result.passed,
            model_verdict=result.model_verdict,
        )
        for check in result.checks:
            vc = response.checks.add()
            vc.name = check.name
            vc.passed = check.passed
            vc.description = check.description
        return response


    async def ReportAgentStates(self, request, context):
        """Evaluate sub-agent health and return recommended actions."""
        actions = []
        for agent in request.agents:
            agent_state = {
                "id": agent.id,
                "task": agent.task,
                "status": agent.status,
                "spawned_at": agent.spawned_at,
                "last_activity_at": agent.last_activity_at,
                "timeout_ms": agent.timeout_ms,
                "messages_count": agent.messages_count,
                "tool_calls_count": agent.tool_calls_count,
                "retry_count": agent.retry_count,
            }
            health_action = self.agent_monitor.evaluate_agent(agent_state)
            actions.append(health_action)

        self._last_agent_actions = actions

        response = cerebellum_pb2.AgentStatesResponse()
        for action in actions:
            ha = response.actions.add()
            ha.agent_id = action.agent_id
            ha.action = action.action
            ha.reason = action.reason
        return response

    async def GetSystemStatus(self, request, context):
        """Return combined system status: model health + heartbeat tasks + sub-agents."""
        uptime = int(time.time() - self.start_time)

        # Count agent states from last report
        agents_total = len(self._last_agent_actions)
        agents_running = sum(1 for a in self._last_agent_actions if a.action == "ok" and "active" in a.reason)
        agents_completed = 0
        agents_failed = 0
        for a in self._last_agent_actions:
            if "completed" in a.reason:
                agents_completed += 1
            elif a.action in ("timeout", "retry", "cancel"):
                agents_failed += 1

        response = cerebellum_pb2.SystemStatusResponse(
            healthy=self.inference.is_loaded(),
            model_name=self.inference.model_path,
            uptime_seconds=uptime,
            tasks_registered=len(self.heartbeat.tasks),
            agents_total=agents_total,
            agents_running=agents_running,
            agents_completed=agents_completed,
            agents_failed=agents_failed,
        )

        for action in self._last_agent_actions:
            if action.action != "ok":
                pa = response.pending_actions.add()
                pa.agent_id = action.agent_id
                pa.action = action.action
                pa.reason = action.reason

        return response

    async def IngestTrainingData(self, request, context):
        """Receive training pairs for fine-tuning."""
        pairs = [
            {
                "instruction": p.instruction,
                "response": p.response,
                "source": p.source,
                "created_at": p.created_at,
            }
            for p in request.pairs
        ]
        total = self.finetune.ingest(pairs)
        logger.info(f"Ingested {len(pairs)} training pairs, {total} total pending")
        return cerebellum_pb2.IngestResponse(total_pending=total)

    async def StartFineTune(self, request, context):
        """Start a fine-tuning job in the background."""
        inference = self.inference

        def on_complete(checkpoint_path: str, method: str):
            if method == "full":
                inference.reload(checkpoint_path)
            else:
                inference.apply_adapter(checkpoint_path)

        job = self.finetune.start(
            method=request.method or "auto",
            epochs=request.epochs or 3,
            lr=request.learning_rate or 2e-4,
            batch_size=request.batch_size or 4,
            on_complete=on_complete,
        )
        return cerebellum_pb2.FineTuneResponse(
            job_id=job.job_id,
            started=job.status == "running",
            error=job.error,
        )

    async def GetFineTuneStatus(self, request, context):
        """Return current fine-tune job status."""
        job = self.finetune.get_status()
        return cerebellum_pb2.FineTuneStatusResponse(
            status=job.status,
            job_id=job.job_id,
            progress=job.progress,
            current_step=job.current_step,
            total_steps=job.total_steps,
            current_loss=job.current_loss,
            error=job.error,
            checkpoint_path=job.checkpoint_path,
            started_at=int(job.started_at),
            completed_at=int(job.completed_at),
        )


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

    workspace_dir = os.environ.get("WORKSPACE_DIR", "/workspace")
    memory_dir = os.environ.get("MEMORY_DIR", "/memory")
    verifier = ToolVerifier(inference, workspace_dir, memory_dir)

    stall_threshold = int(os.environ.get("AGENT_STALL_THRESHOLD", "120"))
    agent_monitor = AgentMonitor(inference, stall_threshold)

    data_dir = os.environ.get("DATA_DIR", "/data")
    checkpoint_dir = os.environ.get("CHECKPOINT_DIR", "/checkpoints")
    finetune_engine = FineTuneEngine(model_path, checkpoint_dir, data_dir)

    start_time = time.time()

    server = aio.server(futures.ThreadPoolExecutor(max_workers=4))
    servicer = CerebellumServicer(
        heartbeat, verifier, agent_monitor, finetune_engine, start_time
    )
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
