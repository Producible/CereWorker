"""Heartbeat engine - natural task scheduling via small LLM."""

import asyncio
import logging
import time
import uuid
from typing import Any, Callable

from .inference import CerebellumInference

logger = logging.getLogger(__name__)


class HeartbeatEngine:
    """Manages task registration and heartbeat evaluation loop."""

    def __init__(self, inference: CerebellumInference, interval: int = 30):
        self.inference = inference
        self.interval = interval
        self.tasks: dict[str, dict[str, Any]] = {}
        self.subscribers: list[Callable] = []
        self._running = False

    def register_task(
        self,
        description: str,
        schedule_hint: str,
        metadata: dict[str, str] | None = None,
    ) -> str:
        """Register a new task for heartbeat management."""
        task_id = str(uuid.uuid4())[:8]
        self.tasks[task_id] = {
            "task_id": task_id,
            "description": description,
            "status": "pending",
            "last_run": 0,
            "schedule_hint": schedule_hint,
            "metadata": metadata or {},
        }
        logger.info(f"Registered task {task_id}: {description}")
        return task_id

    def unregister_task(self, task_id: str) -> None:
        """Remove a registered task."""
        if task_id in self.tasks:
            del self.tasks[task_id]
            logger.info(f"Unregistered task {task_id}")

    def list_tasks(self) -> list[dict[str, Any]]:
        """Return all registered tasks."""
        return list(self.tasks.values())

    def add_subscriber(self, callback: Callable) -> None:
        """Add a heartbeat event subscriber."""
        self.subscribers.append(callback)

    def remove_subscriber(self, callback: Callable) -> None:
        """Remove a heartbeat event subscriber."""
        self.subscribers = [s for s in self.subscribers if s is not callback]

    async def run(self) -> None:
        """Run the heartbeat loop."""
        self._running = True
        logger.info(f"Heartbeat engine started (interval: {self.interval}s)")

        while self._running:
            try:
                await self._tick()
            except Exception as e:
                logger.error(f"Heartbeat tick error: {e}")

            await asyncio.sleep(self.interval)

    async def _tick(self) -> None:
        """Execute one heartbeat tick."""
        if not self.tasks:
            return

        timestamp = int(time.time())
        task_list = list(self.tasks.values())

        # Run inference in a thread to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        actions = await loop.run_in_executor(
            None,
            self.inference.evaluate_tasks,
            task_list,
            self._get_system_summary(),
            timestamp,
        )

        # Update task states based on actions
        for action in actions:
            task_id = action["task_id"]
            if task_id in self.tasks and action["action"] == "invoke":
                self.tasks[task_id]["last_run"] = timestamp
                self.tasks[task_id]["status"] = "running"

        # Notify subscribers
        event = {"timestamp": timestamp, "actions": actions}
        for subscriber in self.subscribers:
            try:
                await subscriber(event)
            except Exception as e:
                logger.error(f"Subscriber notification error: {e}")

        logger.debug(f"Heartbeat tick: {len(actions)} actions for {len(task_list)} tasks")

    def _get_system_summary(self) -> str:
        """Build a brief system state summary."""
        total = len(self.tasks)
        pending = sum(1 for t in self.tasks.values() if t["status"] == "pending")
        running = sum(1 for t in self.tasks.values() if t["status"] == "running")
        return f"{total} tasks registered ({pending} pending, {running} running)"

    def stop(self) -> None:
        """Stop the heartbeat loop."""
        self._running = False
        logger.info("Heartbeat engine stopped")
