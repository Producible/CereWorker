"""Heartbeat engine - deterministic task scheduling with limited model tiebreaking."""

import asyncio
import logging
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from .inference import CerebellumInference

logger = logging.getLogger(__name__)

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

_INTERVAL_MULTIPLIERS = {
    "seconds": 1,
    "minutes": 60,
    "hours": 3600,
    "days": 86400,
    "weeks": 604800,
}


def parse_schedule_hint(hint: str, default_interval: int = 30) -> int:
    """Convert a natural language schedule hint to seconds."""
    hint_lower = hint.strip().lower()
    for keyword, seconds in _SCHEDULE_KEYWORDS.items():
        if keyword in hint_lower:
            return seconds

    patterns = [
        (r"every\s+(\d+)\s*s(?:ec(?:ond)?s?)?", 1),
        (r"every\s+(\d+)\s*m(?:in(?:ute)?s?)?", 60),
        (r"every\s+(\d+)\s*h(?:our)?s?", 3600),
        (r"every\s+(\d+)\s*d(?:ay)?s?", 86400),
        (r"every\s+(\d+)\s*w(?:eek)?s?", 604800),
    ]
    for pattern, multiplier in patterns:
        match = re.search(pattern, hint_lower)
        if match:
            return int(match.group(1)) * multiplier

    logger.debug("Unparseable schedule hint '%s', using default %ss", hint, default_interval)
    return default_interval


def _parse_iso_timestamp(value: str | None) -> int:
    if not value:
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())
    except Exception:
        return 0


def _parse_task_schedule(schedule: dict[str, Any] | None) -> dict[str, Any] | None:
    if not schedule:
        return None
    if schedule.get("interval"):
        interval = schedule["interval"]
        return {
            "type": "interval",
            "every": int(interval.get("every", 0) or 0),
            "unit": str(interval.get("unit", "")),
        }
    if schedule.get("dailyAt"):
        daily_at = schedule["dailyAt"]
        return {
            "type": "daily_at",
            "time": str(daily_at.get("time", "")),
            "timezone": str(daily_at.get("timezone", "") or "UTC"),
            "catch_up_policy": str(daily_at.get("catchUpPolicy", "") or "once"),
        }
    if schedule.get("oneShot"):
        one_shot = schedule["oneShot"]
        return {
            "type": "one_shot",
            "due_at": str(one_shot.get("dueAt", "")),
            "timezone": str(one_shot.get("timezone", "") or "UTC"),
            "catch_up_policy": str(one_shot.get("catchUpPolicy", "") or "once"),
        }
    return None


def _format_slot_key(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class HeartbeatEngine:
    """Manages task registration and heartbeat evaluation loop."""

    def __init__(self, inference: CerebellumInference, interval: int = 30):
        self.inference = inference
        self.interval = interval
        self.tasks: dict[str, dict[str, Any]] = {}
        self.managed_tasks: dict[str, dict[str, Any]] = {}
        self.subscribers: list[Callable] = []
        self._running = False

    def register_task(
        self,
        description: str,
        schedule_hint: str,
        metadata: dict[str, str] | None = None,
        schedule: dict[str, Any] | None = None,
    ) -> str:
        """Register a new task for heartbeat management."""
        task_id = str(uuid.uuid4())[:8]
        metadata = metadata or {}
        self.tasks[task_id] = {
            "task_id": task_id,
            "description": description,
            "status": "pending",
            "last_run": _parse_iso_timestamp(metadata.get("lastRunAt")),
            "last_slot": metadata.get("lastScheduledSlot", ""),
            "created_at": _parse_iso_timestamp(metadata.get("createdAt")),
            "schedule_hint": schedule_hint,
            "schedule": _parse_task_schedule(schedule),
            "metadata": metadata,
        }
        logger.info("Registered task %s: %s", task_id, description)
        return task_id

    def unregister_task(self, task_id: str) -> None:
        if task_id in self.tasks:
            del self.tasks[task_id]
            logger.info("Unregistered task %s", task_id)

    def list_tasks(self) -> list[dict[str, Any]]:
        return list(self.tasks.values()) + list(self.managed_tasks.values())

    def _build_managed_task(self, task: dict[str, Any]) -> dict[str, Any]:
        metadata = dict(task.get("metadata") or {})
        return {
            "task_id": task["task_id"],
            "description": task["description"],
            "enabled": bool(task.get("enabled", True)),
            "kind": str(task.get("kind", "recurring")),
            "status": str(task.get("status", "pending") or "pending"),
            "last_run": _parse_iso_timestamp(task.get("last_run_at")),
            "last_slot": str(task.get("last_scheduled_slot", "") or ""),
            "created_at": _parse_iso_timestamp(task.get("created_at")),
            "schedule_hint": str(task.get("schedule_hint", "")),
            "schedule": _parse_task_schedule(task.get("schedule")),
            "scheduler_status": str(task.get("scheduler_status", "") or ""),
            "last_summary": str(task.get("last_summary", "") or ""),
            "metadata": metadata,
        }

    def sync_managed_tasks(
        self,
        tasks: list[dict[str, Any]],
        timezone_name: str | None = None,
    ) -> int:
        next_tasks: dict[str, dict[str, Any]] = {}
        for task in tasks:
            entry = self._build_managed_task(task)
            if not entry["schedule"] and entry["schedule_hint"]:
                entry["schedule"] = _parse_task_schedule(task.get("schedule"))
            if timezone_name and entry["schedule"] and entry["schedule"]["type"] == "daily_at":
                entry["schedule"]["timezone"] = entry["schedule"].get("timezone") or timezone_name
            next_tasks[entry["task_id"]] = entry
        self.managed_tasks = next_tasks
        logger.info("Synced %s managed tasks", len(self.managed_tasks))
        return len(self.managed_tasks)

    def add_subscriber(self, callback: Callable) -> None:
        self.subscribers.append(callback)

    def remove_subscriber(self, callback: Callable) -> None:
        self.subscribers = [s for s in self.subscribers if s is not callback]

    def _is_system_busy(self) -> bool:
        return any(t["status"] == "running" for t in self.tasks.values())

    def _evaluate_interval_task(
        self, task: dict[str, Any], timestamp: int, system_busy: bool
    ) -> dict[str, str]:
        if task["status"] == "running":
            return {"task_id": task["task_id"], "action": "skip", "reason": "running"}

        schedule = task.get("schedule")
        if schedule and schedule.get("type") == "interval":
            every = max(int(schedule.get("every", 0) or 0), 1)
            unit = str(schedule.get("unit", "minutes"))
            interval = every * _INTERVAL_MULTIPLIERS.get(unit, self.interval)
        else:
            interval = parse_schedule_hint(task["schedule_hint"], self.interval)
        elapsed = timestamp - task["last_run"]

        if task["last_run"] == 0:
            action = "invoke"
            reason = "first_run"
        elif elapsed < interval * 0.8:
            action = "skip"
            reason = "timer"
        elif elapsed > interval * 2.0:
            action = "invoke"
            reason = "overdue"
        else:
            should_run = self.inference.should_run_task(
                description=task["description"],
                elapsed_seconds=elapsed,
                schedule_hint=task["schedule_hint"],
                system_busy=system_busy,
            )
            action = "invoke" if should_run else "skip"
            reason = "model"

        return {
            "task_id": task["task_id"],
            "action": action,
            "reason": reason,
        }

    def _evaluate_daily_at_task(self, task: dict[str, Any], now: datetime) -> dict[str, str]:
        schedule = task["schedule"]
        if task["status"] == "running":
            return {"task_id": task["task_id"], "action": "skip", "reason": "running"}

        timezone_name = schedule.get("timezone") or "UTC"
        catch_up_policy = schedule.get("catch_up_policy") or "once"
        try:
            zone = ZoneInfo(timezone_name)
        except Exception:
            zone = timezone.utc

        local_now = now.astimezone(zone)
        hour, minute = map(int, schedule.get("time", "00:00").split(":"))
        today_slot = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        due_slot = today_slot if local_now >= today_slot else today_slot - timedelta(days=1)
        slot_key = _format_slot_key(due_slot)
        if (
            not task.get("last_slot")
            and task.get("created_at", 0) > int(due_slot.timestamp())
            and local_now < today_slot
        ):
            return {"task_id": task["task_id"], "action": "skip", "reason": "not_due_yet"}

        if local_now < today_slot and catch_up_policy != "once":
            return {"task_id": task["task_id"], "action": "skip", "reason": "timer"}
        if task.get("last_slot") == slot_key:
            return {"task_id": task["task_id"], "action": "skip", "reason": "already_ran"}

        if local_now >= today_slot:
            return {
                "task_id": task["task_id"],
                "action": "invoke",
                "reason": "scheduled_time",
                "scheduled_for": due_slot.isoformat(),
                "slot_key": slot_key,
            }

        if catch_up_policy == "once":
            return {
                "task_id": task["task_id"],
                "action": "invoke",
                "reason": "catch_up",
                "scheduled_for": due_slot.isoformat(),
                "slot_key": slot_key,
            }

        return {"task_id": task["task_id"], "action": "skip", "reason": "timer"}

    def _evaluate_one_shot_task(self, task: dict[str, Any], now: datetime) -> dict[str, str]:
        schedule = task["schedule"]
        if task["status"] == "running":
            return {"task_id": task["task_id"], "action": "skip", "reason": "running"}

        due_at_raw = schedule.get("due_at")
        due_at = datetime.fromisoformat(due_at_raw.replace("Z", "+00:00"))
        if due_at.tzinfo is None:
            due_at = due_at.replace(tzinfo=timezone.utc)
        slot_key = _format_slot_key(due_at)

        if task.get("last_slot") == slot_key:
            return {"task_id": task["task_id"], "action": "skip", "reason": "already_ran"}
        if now < due_at.astimezone(timezone.utc):
            return {"task_id": task["task_id"], "action": "skip", "reason": "timer"}
        return {
            "task_id": task["task_id"],
            "action": "invoke",
            "reason": "due",
            "scheduled_for": due_at.isoformat(),
            "slot_key": slot_key,
        }

    def _evaluate_task(
        self, task: dict[str, Any], timestamp: int, system_busy: bool
    ) -> dict[str, str]:
        schedule = task.get("schedule")
        if not schedule:
            return self._evaluate_interval_task(task, timestamp, system_busy)

        now = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        if schedule["type"] == "interval":
            return self._evaluate_interval_task(task, timestamp, system_busy)
        if schedule["type"] == "daily_at":
            return self._evaluate_daily_at_task(task, now)
        return self._evaluate_one_shot_task(task, now)

    def _requires_browser(self, task: dict[str, Any]) -> bool:
        metadata = task.get("metadata", {})
        if metadata.get("requiresBrowser") == "true":
            return True
        description = str(task.get("description", "")).lower()
        return any(
            token in description
            for token in [
                "browser",
                "chrome",
                "timeline",
                "x account",
                "post on x",
                "x update",
                "like 3-5 relevant",
            ]
        )

    def evaluate_supervisor(self, state: dict[str, Any]) -> list[dict[str, str]]:
        timestamp = int(state.get("timestamp") or time.time())
        browser_available = bool(state.get("browser_available", False))
        active_task_ids = set(state.get("active_task_ids") or [])
        system_busy = bool(state.get("cerebrum_busy", False) or active_task_ids)
        actions: list[dict[str, str]] = []

        for incoming in state.get("tasks") or []:
            task_id = incoming.get("task_id")
            if task_id in self.managed_tasks:
                current = self.managed_tasks[task_id]
                current["enabled"] = bool(incoming.get("enabled", current.get("enabled", True)))
                current["status"] = str(incoming.get("status", current.get("status", "pending")) or "pending")
                current["last_run"] = _parse_iso_timestamp(incoming.get("last_run_at")) or current.get("last_run", 0)
                current["last_slot"] = str(incoming.get("last_scheduled_slot", current.get("last_slot", "")) or "")
                current["scheduler_status"] = str(incoming.get("scheduler_status", current.get("scheduler_status", "")) or "")
                current["last_summary"] = str(incoming.get("last_summary", current.get("last_summary", "")) or "")
                current["metadata"] = dict(incoming.get("metadata") or current.get("metadata") or {})

        for task in self.managed_tasks.values():
            if not task.get("enabled", True):
                actions.append({
                    "task_id": task["task_id"],
                    "action": "noop",
                    "reason": "disabled",
                })
                continue

            if task.get("kind") == "one_shot" and task.get("status") == "success":
                actions.append({
                    "task_id": task["task_id"],
                    "action": "noop",
                    "reason": "completed",
                })
                continue

            if task["task_id"] in active_task_ids:
                actions.append({
                    "task_id": task["task_id"],
                    "action": "noop",
                    "reason": "active",
                })
                continue

            if task.get("status") == "running":
                actions.append({
                    "task_id": task["task_id"],
                    "action": "continue_task",
                    "reason": "resume_running_task",
                })
                continue

            decision = self._evaluate_task(task, timestamp, system_busy)
            if decision["action"] != "invoke":
                actions.append({
                    "task_id": task["task_id"],
                    "action": "noop",
                    "reason": decision["reason"],
                    **({"slot_key": decision["slot_key"]} if decision.get("slot_key") else {}),
                })
                continue

            action = "invoke_task"
            reason = decision["reason"]
            if self._requires_browser(task) and not browser_available:
                action = "report_issue"
                reason = "browser_unavailable"

            actions.append({
                "task_id": task["task_id"],
                "action": action,
                "reason": reason,
                "scheduled_for": decision.get("scheduled_for") or datetime.fromtimestamp(
                    timestamp, tz=timezone.utc
                ).isoformat(),
                "slot_key": decision.get("slot_key") or _format_slot_key(
                    datetime.fromtimestamp(timestamp, tz=timezone.utc)
                ),
            })

        return actions

    async def run(self) -> None:
        self._running = True
        logger.info("Heartbeat engine started (interval: %ss)", self.interval)

        while self._running:
            try:
                await self._tick()
            except Exception as exc:
                logger.error("Heartbeat tick error: %s", exc)
            await asyncio.sleep(self.interval)

    async def _tick(self) -> None:
        if not self.tasks:
            return

        timestamp = int(time.time())
        system_busy = self._is_system_busy()
        actions: list[dict[str, str]] = []

        for task in self.tasks.values():
            actions.append(self._evaluate_task(task, timestamp, system_busy))

        for action_item in actions:
            task_id = action_item["task_id"]
            if task_id in self.tasks and action_item["action"] == "invoke":
                self.tasks[task_id]["last_run"] = timestamp
                self.tasks[task_id]["status"] = "running"
                if action_item.get("slot_key"):
                    self.tasks[task_id]["last_slot"] = action_item["slot_key"]

        event = {"timestamp": timestamp, "actions": actions}
        for subscriber in self.subscribers:
            try:
                await subscriber(event)
            except Exception as exc:
                logger.error("Subscriber notification error: %s", exc)

        logger.debug("Heartbeat tick: %s actions for %s tasks", len(actions), len(self.tasks))

    def stop(self) -> None:
        self._running = False
        logger.info("Heartbeat engine stopped")
