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
                "schedule": t.schedule,
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
            if action.get("scheduled_for"):
                ta.scheduled_for = action["scheduled_for"]
            if action.get("slot_key"):
                ta.slot_key = action["slot_key"]
        return response

    async def RegisterTask(self, request, context):
        task_id = self.heartbeat.register_task(
            request.description,
            request.schedule_hint,
            dict(request.metadata) if request.metadata else None,
            {
                "interval": request.schedule.interval if request.schedule.HasField("interval") else None,
                "dailyAt": request.schedule.daily_at if request.schedule.HasField("daily_at") else None,
                "oneShot": request.schedule.one_shot if request.schedule.HasField("one_shot") else None,
            } if request.HasField("schedule") else None,
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
            schedule = t.get("schedule")
            if schedule:
                if schedule.get("type") == "interval":
                    ts.schedule.interval.every = schedule.get("every", 0)
                    ts.schedule.interval.unit = schedule.get("unit", "")
                elif schedule.get("type") == "daily_at":
                    ts.schedule.daily_at.time = schedule.get("time", "")
                    ts.schedule.daily_at.timezone = schedule.get("timezone", "")
                    ts.schedule.daily_at.catch_up_policy = schedule.get("catch_up_policy", "")
                elif schedule.get("type") == "one_shot":
                    ts.schedule.one_shot.due_at = schedule.get("due_at", "")
                    ts.schedule.one_shot.timezone = schedule.get("timezone", "")
                    ts.schedule.one_shot.catch_up_policy = schedule.get("catch_up_policy", "")
        return response

    async def SyncManagedTasks(self, request, context):
        synced = self.heartbeat.sync_managed_tasks(
            [
                {
                    "task_id": task.task_id,
                    "description": task.description,
                    "enabled": task.enabled,
                    "kind": task.kind,
                    "schedule_hint": task.schedule_hint,
                    "schedule": {
                        "interval": task.schedule.interval if task.schedule.HasField("interval") else None,
                        "dailyAt": task.schedule.daily_at if task.schedule.HasField("daily_at") else None,
                        "oneShot": task.schedule.one_shot if task.schedule.HasField("one_shot") else None,
                    } if task.HasField("schedule") else None,
                    "status": task.status,
                    "created_at": task.created_at,
                    "last_run_at": task.last_run_at,
                    "last_scheduled_slot": task.last_scheduled_slot,
                    "scheduler_status": task.scheduler_status,
                    "last_summary": task.last_summary,
                    "metadata": dict(task.metadata) if task.metadata else {},
                }
                for task in request.tasks
            ],
            request.timezone or "UTC",
        )
        return cerebellum_pb2.SyncManagedTasksResponse(synced_count=synced)

    async def ReportSupervisorState(self, request, context):
        actions = self.heartbeat.evaluate_supervisor(
            {
                "timestamp": request.timestamp or int(time.time()),
                "timezone": request.timezone or "UTC",
                "active_task_ids": list(request.active_task_ids),
                "browser_available": request.browser_available,
                "channels_available": request.channels_available,
                "cerebrum_busy": request.cerebrum_busy,
                "fine_tune_running": request.fine_tune_running,
                "tasks": [
                    {
                        "task_id": task.task_id,
                        "description": task.description,
                        "enabled": task.enabled,
                        "kind": task.kind,
                        "schedule_hint": task.schedule_hint,
                        "schedule": {
                            "interval": task.schedule.interval if task.schedule.HasField("interval") else None,
                            "dailyAt": task.schedule.daily_at if task.schedule.HasField("daily_at") else None,
                            "oneShot": task.schedule.one_shot if task.schedule.HasField("one_shot") else None,
                        } if task.HasField("schedule") else None,
                        "status": task.status,
                        "created_at": task.created_at,
                        "last_run_at": task.last_run_at,
                        "last_scheduled_slot": task.last_scheduled_slot,
                        "scheduler_status": task.scheduler_status,
                        "last_summary": task.last_summary,
                        "metadata": dict(task.metadata) if task.metadata else {},
                    }
                    for task in request.tasks
                ],
            }
        )
        response = cerebellum_pb2.SupervisorStateResponse()
        for action in actions:
            ta = response.actions.add()
            ta.task_id = action["task_id"]
            ta.action = action["action"]
            ta.reason = action["reason"]
            if action.get("scheduled_for"):
                ta.scheduled_for = action["scheduled_for"]
            if action.get("slot_key"):
                ta.slot_key = action["slot_key"]
        return response

    async def GetStatus(self, request, context):
        uptime = int(time.time() - self.start_time)
        return cerebellum_pb2.StatusResponse(
            healthy=self.inference.is_loaded(),
            model_name=self.inference.model_path,
            uptime_seconds=uptime,
            tasks_registered=len(self.heartbeat.tasks) + len(self.heartbeat.managed_tasks),
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

    def _truncate(self, text, max_chars=300):
        text = (text or "").strip()
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 1].rstrip() + "…"

    def _derive_completed_steps(self, request):
        completed = []
        seen = set()

        for boundary in request.recent_boundaries:
            if boundary.kind in ("tool", "checkpoint", "completion") and boundary.summary and boundary.summary not in seen:
                completed.append(boundary.summary)
                seen.add(boundary.summary)

        for checkpoint in request.task_checkpoints:
            if checkpoint.status == "done" and checkpoint.summary and checkpoint.summary not in seen:
                completed.append(checkpoint.summary)
                seen.add(checkpoint.summary)

        for entry in request.progress_entries:
            if entry.source == "tool" and entry.state_changing and not entry.is_error and entry.summary and entry.summary not in seen:
                completed.append(entry.summary)
                seen.add(entry.summary)

        return completed[-10:]

    def _looks_repetitive(self, request):
        if list(request.repetition_signals):
            return True

        recent_actions = [entry.action for entry in request.progress_entries if entry.source == "tool"][-6:]
        recent_summaries = [entry.summary for entry in request.progress_entries if entry.source == "tool"][-6:]
        if len(recent_actions) >= 4 and len(set(recent_actions)) <= 2:
            return True
        if len(recent_summaries) >= 4 and len(set(recent_summaries)) <= 2:
            return True
        boundary_summaries = [boundary.summary for boundary in request.recent_boundaries if boundary.kind == "tool"][-6:]
        if len(boundary_summaries) >= 4 and len(set(boundary_summaries)) <= 2:
            return True
        return False

    def _derive_next_step(self, request, completed_steps):
        latest_boundary = getattr(request, "latest_boundary", None)
        latest_boundary_summary = getattr(latest_boundary, "summary", "").strip() if latest_boundary else ""
        latest_boundary_kind = getattr(latest_boundary, "kind", "").strip() if latest_boundary else ""
        current_url = request.browser_state.current_url
        if latest_boundary_kind == "completion" and latest_boundary_summary:
            return "Use the recorded completion state to write the final answer or stop only if the current page contradicts the verified result."
        if latest_boundary_kind == "checkpoint" and latest_boundary_summary:
            return f"Continue after this verified checkpoint: {latest_boundary_summary}"
        if latest_boundary_kind == "tool" and latest_boundary_summary:
            return f"Continue after this verified browser action: {latest_boundary_summary}"
        if current_url and "x.com/home" in current_url:
            return "Stay on the current home timeline and continue from the next unfinished engagement or publishing step without reopening already verified pages."
        if current_url and "x.com/" in current_url and current_url.rstrip("/").split("/")[-1]:
            return f"Continue from the current page ({current_url}) and move to the next unfinished step without restarting the browser workflow."
        if completed_steps:
            return "Continue from the next unfinished step using the verified progress below; do not repeat completed navigation or scans."
        return "Use the current browser state and recent verified actions to continue from the next unfinished step."

    def _build_model_message(self, request, diagnosis, next_step, completed_steps):
        lines = [
            "[Cerebellum recovery guidance]",
            diagnosis,
            "The failed attempt tool history has been removed. Treat the verified state below as authoritative.",
        ]

        if getattr(request, "turn_outcome", ""):
            lines.append(f"Turn outcome: {request.turn_outcome}")
        if getattr(request, "finish_reason", ""):
            lines.append(f"Finish reason: {request.finish_reason}")
        if getattr(request, "last_content_kind", ""):
            lines.append(f"Last content kind: {request.last_content_kind}")

        if completed_steps:
            lines.append("")
            lines.append("Completed steps:")
            for step in completed_steps:
                lines.append(f"- {step}")

        latest_boundary = getattr(request, "latest_boundary", None)
        latest_boundary_summary = getattr(latest_boundary, "summary", "").strip() if latest_boundary else ""
        if latest_boundary_summary:
            lines.append("")
            lines.append(f"Latest verified boundary: {latest_boundary_summary}")

        if list(request.repetition_signals):
            lines.append("")
            lines.append("Repetition warnings:")
            for signal in list(request.repetition_signals)[:5]:
                lines.append(f"- {signal}")

        if request.browser_state.current_url or request.browser_state.active_tab_id or request.browser_state.tabs:
            lines.append("")
            lines.append("Last known browser state:")
            if request.browser_state.current_url:
                lines.append(f"- Current URL: {request.browser_state.current_url}")
            if request.browser_state.active_tab_id:
                lines.append(f"- Active tab: {request.browser_state.active_tab_id}")
            for tab in list(request.browser_state.tabs)[:6]:
                title = f" ({tab.title})" if tab.title else ""
                active = " [active]" if tab.active else ""
                lines.append(f"- Tab {tab.id}{active}: {tab.url}{title}")

        if request.partial_content:
            lines.extend([
                "",
                "Partial assistant text from the previous attempt:",
                self._truncate(request.partial_content, 600),
            ])

        lines.extend([
            "",
            f"Next step: {next_step}",
            "Do not repeat completed work unless the current page state clearly contradicts it.",
            "End your final answer by calling task_complete or task_blocked.",
        ])
        return "\n".join(lines)

    async def AssessTurnRecovery(self, request, context):
        """Assess whether a stalled or incomplete turn should wait, retry, or stop."""
        completed_steps = self._derive_completed_steps(request)
        repetitive = self._looks_repetitive(request)
        cause = request.cause or "completion"
        phase = request.phase or "idle"
        wait_seconds = 0

        if cause == "stall":
            if phase == "waiting_model" and request.stall_retry_count == 0 and request.elapsed_seconds <= 90:
                action = "wait"
                wait_seconds = max(45, min(90, request.elapsed_seconds + 15))
                diagnosis = f"The model is stalled in {phase}, but this still looks salvageable without restarting."
            elif repetitive:
                action = "stop"
                diagnosis = "The run is repeating the same browser navigation pattern without advancing the task."
            else:
                action = "retry"
                diagnosis = f"The stalled turn should be retried from the last verified state instead of continuing to wait in {phase}."
        else:
            if request.turn_outcome == "completion_signal_missing" and request.completion_retry_count >= 1 and repetitive:
                action = "stop"
                diagnosis = "The turn keeps repeating verified browser work without producing the required completion signal."
            elif repetitive and request.completion_retry_count >= 1:
                action = "stop"
                diagnosis = "The turn is repeating the same verified browser steps without producing a final answer."
            else:
                action = "retry"
                finish_reason = request.finish_reason or "tool-calls"
                diagnosis = (
                    f"The turn ended with outcome {request.turn_outcome or 'unknown'}"
                    f" ({finish_reason}) and no valid final answer, so it should resume from the verified state instead of restarting."
                )

        next_step = self._derive_next_step(request, completed_steps)
        if action == "wait":
            operator_message = f"[Cerebellum] Waiting {wait_seconds}s longer before interrupting; the turn still looks salvageable."
        elif action == "stop":
            operator_message = f"[Cerebellum] Stop retrying: {diagnosis}"
        else:
            operator_message = f"[Cerebellum] Retry from the last verified state. Next step: {next_step}"

        model_message = self._build_model_message(request, diagnosis, next_step, completed_steps)

        return cerebellum_pb2.AssessTurnRecoveryResponse(
            action=action,
            operator_message=operator_message,
            model_message=model_message,
            diagnosis=diagnosis,
            next_step=next_step,
            completed_steps=completed_steps,
            wait_seconds=wait_seconds,
        )


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
                "progress_note": agent.progress_note,
                "progress_percent": agent.progress_percent,
                "last_progress_at": agent.last_progress_at,
                "deadline_at": agent.deadline_at,
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
            tasks_registered=len(self.heartbeat.tasks) + len(self.heartbeat.managed_tasks),
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
