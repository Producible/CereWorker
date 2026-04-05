import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.heartbeat import HeartbeatEngine


class FakeInference:
    def should_run_task(self, description, elapsed_seconds, schedule_hint, system_busy):
        return True


class HeartbeatScheduleTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_at_invokes_once_per_slot(self):
        engine = HeartbeatEngine(FakeInference(), interval=30)
        task_id = engine.register_task(
            "Nightly update",
            "daily at 22:00",
            {"lastScheduledSlot": ""},
            {"dailyAt": {"time": "22:00", "timezone": "UTC", "catchUpPolicy": "once"}},
        )
        engine.tasks[task_id]["last_slot"] = "2026-04-03T22:00:00Z"
        decision = engine._evaluate_task(
            engine.tasks[task_id],
            int(datetime(2026, 4, 4, 22, 10, tzinfo=timezone.utc).timestamp()),
            False,
        )
        self.assertEqual(decision["action"], "invoke")
        self.assertIn("slot_key", decision)

    async def test_one_shot_only_invokes_once(self):
        engine = HeartbeatEngine(FakeInference(), interval=30)
        task_id = engine.register_task(
            "Migration",
            "once at 2026-04-05T05:00:00Z",
            {},
            {"oneShot": {"dueAt": "2026-04-05T05:00:00Z", "timezone": "UTC", "catchUpPolicy": "once"}},
        )
        first = engine._evaluate_task(
            engine.tasks[task_id],
            int(datetime(2026, 4, 5, 5, 5, tzinfo=timezone.utc).timestamp()),
            False,
        )
        self.assertEqual(first["action"], "invoke")
        engine.tasks[task_id]["last_slot"] = first["slot_key"]
        second = engine._evaluate_task(
            engine.tasks[task_id],
            int(datetime(2026, 4, 5, 6, 5, tzinfo=timezone.utc).timestamp()),
            False,
        )
        self.assertEqual(second["action"], "skip")

    async def test_new_daily_task_waits_for_first_slot(self):
        engine = HeartbeatEngine(FakeInference(), interval=30)
        task_id = engine.register_task(
            "Nightly post",
            "daily at 22:00",
            {"createdAt": "2026-04-04T18:00:00Z"},
            {"dailyAt": {"time": "22:00", "timezone": "UTC", "catchUpPolicy": "once"}},
        )
        decision = engine._evaluate_task(
            engine.tasks[task_id],
            int(datetime(2026, 4, 4, 18, 5, tzinfo=timezone.utc).timestamp()),
            False,
        )
        self.assertEqual(decision["action"], "skip")

    async def test_supervisor_invokes_daily_task_on_first_tick_after_slot(self):
        engine = HeartbeatEngine(FakeInference(), interval=60)
        engine.sync_managed_tasks(
            [
                {
                    "task_id": "x-daily",
                    "description": "Daily X update",
                    "enabled": True,
                    "kind": "recurring",
                    "schedule_hint": "daily at 10:00",
                    "schedule": {
                        "dailyAt": {"time": "10:00", "timezone": "UTC", "catchUpPolicy": "once"}
                    },
                    "status": "pending",
                    "created_at": "2026-04-04T08:00:00Z",
                    "last_run_at": "",
                    "last_scheduled_slot": "",
                    "scheduler_status": "registered",
                    "last_summary": "",
                    "metadata": {},
                }
            ],
            "UTC",
        )

        actions = engine.evaluate_supervisor(
            {
                "timestamp": int(datetime(2026, 4, 4, 10, 0, 30, tzinfo=timezone.utc).timestamp()),
                "timezone": "UTC",
                "browser_available": True,
                "channels_available": True,
                "cerebrum_busy": False,
                "fine_tune_running": False,
                "active_task_ids": [],
                "tasks": [],
            }
        )

        invoke = next(action for action in actions if action["task_id"] == "x-daily")
        self.assertEqual(invoke["action"], "invoke_task")
        self.assertEqual(invoke["reason"], "scheduled_time")
        self.assertIn("slot_key", invoke)

    async def test_supervisor_reports_browser_issue_when_due_task_needs_browser(self):
        engine = HeartbeatEngine(FakeInference(), interval=60)
        engine.sync_managed_tasks(
            [
                {
                    "task_id": "x-browser",
                    "description": "Post on X using the browser timeline",
                    "enabled": True,
                    "kind": "recurring",
                    "schedule_hint": "every 3 hours",
                    "schedule": {"interval": {"every": 3, "unit": "hours"}},
                    "status": "pending",
                    "created_at": "2026-04-04T00:00:00Z",
                    "last_run_at": "2026-04-04T00:00:00Z",
                    "last_scheduled_slot": "",
                    "scheduler_status": "registered",
                    "last_summary": "",
                    "metadata": {"requiresBrowser": "true"},
                }
            ],
            "UTC",
        )

        actions = engine.evaluate_supervisor(
            {
                "timestamp": int(datetime(2026, 4, 4, 3, 1, tzinfo=timezone.utc).timestamp()),
                "timezone": "UTC",
                "browser_available": False,
                "channels_available": True,
                "cerebrum_busy": False,
                "fine_tune_running": False,
                "active_task_ids": [],
                "tasks": [],
            }
        )

        issue = next(action for action in actions if action["task_id"] == "x-browser")
        self.assertEqual(issue["action"], "report_issue")
        self.assertEqual(issue["reason"], "browser_unavailable")
        self.assertIn("slot_key", issue)


if __name__ == "__main__":
    unittest.main()
