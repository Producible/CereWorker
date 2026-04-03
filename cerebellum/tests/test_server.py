import os
import sys
import unittest
from types import ModuleType
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

grpc_module = ModuleType("grpc")
grpc_aio_module = ModuleType("grpc.aio")
grpc_module.aio = grpc_aio_module
sys.modules.setdefault("grpc", grpc_module)
sys.modules.setdefault("grpc.aio", grpc_aio_module)

for module_name, class_name in [
    ("src.inference", "CerebellumInference"),
    ("src.heartbeat", "HeartbeatEngine"),
    ("src.verification", "ToolVerifier"),
    ("src.agent_monitor", "AgentMonitor"),
    ("src.finetune", "FineTuneEngine"),
]:
    module = ModuleType(module_name)
    setattr(module, class_name, type(class_name, (), {}))
    sys.modules.setdefault(module_name, module)

proto_pkg = ModuleType("src.proto")
proto_pb2 = ModuleType("src.proto.cerebellum_pb2")
proto_pb2_grpc = ModuleType("src.proto.cerebellum_pb2_grpc")
proto_pb2_grpc.CerebellumServicer = type("GrpcCerebellumServicer", (), {})
sys.modules.setdefault("src.proto", proto_pkg)
sys.modules.setdefault("src.proto.cerebellum_pb2", proto_pb2)
sys.modules.setdefault("src.proto.cerebellum_pb2_grpc", proto_pb2_grpc)

from src.server import CerebellumServicer


def _browser_state(current_url="", active_tab_id="", tabs=None):
    return SimpleNamespace(
        current_url=current_url,
        active_tab_id=active_tab_id,
        tabs=tabs or [],
    )


def _boundary(summary, kind="tool", action="navigate"):
    return SimpleNamespace(
        id="b-1",
        kind=kind,
        action=action,
        summary=summary,
        created_at=1,
        state_changing=True,
        browser_state=_browser_state(),
        url="",
        tab_id="",
        evidence="",
        checkpoint_status="",
    )


def _request(**overrides):
    base = SimpleNamespace(
        recent_boundaries=[],
        task_checkpoints=[],
        progress_entries=[],
        repetition_signals=[],
        browser_state=_browser_state(),
        phase="idle",
        cause="completion",
        stall_retry_count=0,
        completion_retry_count=0,
        elapsed_seconds=0,
        turn_outcome="ended_on_tool_calls",
        finish_reason="tool-calls",
        partial_content="",
        latest_boundary=SimpleNamespace(summary="", kind=""),
        last_content_kind="tool-call",
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


class RecoveryHeuristicTests(unittest.TestCase):
    def setUp(self):
        self.servicer = CerebellumServicer.__new__(CerebellumServicer)

    def test_prefers_latest_boundary_for_next_step(self):
        request = _request(
            latest_boundary=_boundary(
                "Reviewed the CereWorkerX profile for continuity.",
                kind="checkpoint",
                action="task_checkpoint",
            ),
        )
        next_step = self.servicer._derive_next_step(request, [])
        self.assertIn("Reviewed the CereWorkerX profile for continuity.", next_step)

    def test_repetition_signals_force_repetitive_classification(self):
        request = _request(repetition_signals=["Repeated verified action x2: Returned to the X home timeline."])
        self.assertTrue(self.servicer._looks_repetitive(request))

    def test_build_model_message_includes_outcome_boundary_and_repetition(self):
        request = _request(
            repetition_signals=["Repeated verified action x2: Returned to the X home timeline."],
            latest_boundary=_boundary("Returned to the X home timeline."),
            browser_state=_browser_state(current_url="https://x.com/home"),
        )
        message = self.servicer._build_model_message(
            request,
            "The turn ended without a final answer.",
            "Continue from the next unfinished engagement step.",
            ["Connected to Chrome via extension."],
        )
        self.assertIn("Turn outcome: ended_on_tool_calls", message)
        self.assertIn("Latest verified boundary: Returned to the X home timeline.", message)
        self.assertIn("Repetition warnings:", message)
        self.assertIn("Current URL: https://x.com/home", message)


if __name__ == "__main__":
    unittest.main()
