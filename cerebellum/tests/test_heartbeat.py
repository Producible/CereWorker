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


if __name__ == "__main__":
    unittest.main()
