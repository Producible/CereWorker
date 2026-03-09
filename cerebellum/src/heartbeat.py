"""Heartbeat engine - deterministic task scheduling with LLM tiebreaker.

Scheduling logic:
- elapsed < 0.8 * interval → skip (clearly too early, no model needed)
- elapsed > 2.0 * interval → invoke (way overdue, no model needed)
- ambiguous zone (0.8x-2.0x) → ask model: "should this run? yes/no"

The model is only a tiebreaker. 90% of decisions are deterministic.
"""

import asyncio
import logging
import re
import time
import uuid
from typing import Any, Callable

from .inference import CerebellumInference

logger = logging.getLogger(__name__)

# Keyword-to-seconds mapping for schedule hints
_SCHEDULE_PATTERNS: list[tuple[re.Pattern, int]] = [
    (re.compile(r"every\s+(\d+)\s*s(?:ec(?:ond)?s?)?", re.I), 0),  # placeholder, uses group
    (re.compile(r"every\s+(\d+)\s*m(?:in(?:ute)?s?)?", re.I), 0),
    (re.compile(r"every\s+(\d+)\s*h(?:our)?s?", re.I), 0),
    (re.compile(r"every\s+(\d+)\s*d(?:ay)?s?", re.I), 0),
]

_SCHEDULE_KEYWORDS: dict[str, int] = {
    "when idle": 60,
    "idle": 60,
    "frequently": 120,
    "every minute": 60,
    "every few minutes": 180,
    "every 5 minutes": 300,
    "every 10 minutes": 600,
    "every 15 minutes": 900,
    "every 30 minutes": 1800,
    "hourly": 3600,
    "every hour": 3600,
    "every few hours": 10800,
    "daily": 86400,
    "every day": 86400,
    "weekly": 604800,
    "every week": 604800,
}


def parse_schedule_hint(hint: str, default_interval: int = 30) -> int:
    """Convert a natural language schedule hint to seconds. Deterministic, no LLM."""
    hint_lower = hint.strip().lower()

    # Check exact keyword matches first
    for keyword, seconds in _SCHEDULE_KEYWORDS.items():
        if keyword in hint_lower:
            return seconds

    # Try regex patterns: "every N seconds/minutes/hours/days"
    m = re.search(r"every\s+(\d+)\s*s(?:ec(?:ond)?s?)?", hint_lower)
    if m:
        return int(m.group(1))

    m = re.search(r"every\s+(\d+)\s*m(?:in(?:ute)?s?)?", hint_lower)
    if m:
        return int(m.group(1)) * 60

    m = re.search(r"every\s+(\d+)\s*h(?:our)?s?", hint_lower)
    if m:
        return int(m.group(1)) * 3600

    m = re.search(r"every\s+(\d+)\s*d(?:ay)?s?", hint_lower)
    if m:
        return int(m.group(1)) * 86400

    logger.debug(f"Unparseable schedule hint '{hint}', using default {default_interval}s")
    return default_interval


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

    def _is_system_busy(self) -> bool:
        """Check if any task is currently running."""
        return any(t["status"] == "running" for t in self.tasks.values())

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
        """Execute one heartbeat tick with deterministic scheduling."""
        if not self.tasks:
            return

        timestamp = int(time.time())
        system_busy = self._is_system_busy()
        actions: list[dict[str, str]] = []

        for task in self.tasks.values():
            elapsed = timestamp - task["last_run"]
            interval = parse_schedule_hint(task["schedule_hint"], self.interval)

            if task["last_run"] == 0:
                # Never run before — invoke on first tick
                action = "invoke"
                reason = "first_run"
            elif elapsed < interval * 0.8:
                # Clearly too early — skip without model
                action = "skip"
                reason = "timer"
            elif elapsed > interval * 2.0:
                # Way overdue — invoke without model
                action = "invoke"
                reason = "overdue"
            else:
                # Ambiguous zone — ask model as tiebreaker
                loop = asyncio.get_event_loop()
                should_run = await loop.run_in_executor(
                    None,
                    self.inference.should_run_task,
                    task["description"],
                    elapsed,
                    task["schedule_hint"],
                    system_busy,
                )
                action = "invoke" if should_run else "skip"
                reason = "model"

            actions.append({
                "task_id": task["task_id"],
                "action": action,
                "reason": reason,
            })

        # Update task states
        for action_item in actions:
            task_id = action_item["task_id"]
            if task_id in self.tasks and action_item["action"] == "invoke":
                self.tasks[task_id]["last_run"] = timestamp
                self.tasks[task_id]["status"] = "running"

        # Notify subscribers
        event = {"timestamp": timestamp, "actions": actions}
        for subscriber in self.subscribers:
            try:
                await subscriber(event)
            except Exception as e:
                logger.error(f"Subscriber notification error: {e}")

        logger.debug(
            f"Heartbeat tick: {len(actions)} actions for {len(self.tasks)} tasks"
        )

    def stop(self) -> None:
        """Stop the heartbeat loop."""
        self._running = False
        logger.info("Heartbeat engine stopped")
