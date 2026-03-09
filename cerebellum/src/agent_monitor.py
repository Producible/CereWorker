"""Sub-agent health monitoring with deterministic checks + binary model gate.

The AgentMonitor runs deterministic health checks on sub-agent states and
only uses the small LLM for ambiguous stall decisions (binary yes/no).
"""

import logging
import time
from dataclasses import dataclass

from src.inference import CerebellumInference

logger = logging.getLogger(__name__)


@dataclass
class AgentHealthCheck:
    agent_id: str
    is_alive: bool
    is_stalled: bool
    is_timed_out: bool
    seconds_since_activity: int
    status: str


@dataclass
class AgentHealthAction:
    agent_id: str
    action: str  # "ok", "ping", "retry", "cancel", "timeout"
    reason: str


class AgentMonitor:
    """Deterministic sub-agent health checks + binary model gate."""

    def __init__(self, inference: CerebellumInference, stall_threshold: int = 120):
        self.inference = inference
        self.stall_threshold = stall_threshold

    def check_agent(self, agent_state: dict) -> AgentHealthCheck:
        """Run deterministic health checks on a sub-agent."""
        now = int(time.time() * 1000)  # milliseconds to match TypeScript timestamps
        last_activity = agent_state.get("last_activity_at", 0)
        spawned_at = agent_state.get("spawned_at", 0)
        timeout_ms = agent_state.get("timeout_ms", 300_000)
        status = agent_state.get("status", "unknown")

        elapsed_since_activity = (now - last_activity) // 1000 if last_activity > 0 else (now - spawned_at) // 1000
        elapsed_since_spawn = (now - spawned_at) // 1000

        is_alive = status in ("running", "pending")
        is_timed_out = is_alive and (elapsed_since_spawn * 1000 > timeout_ms)
        is_stalled = is_alive and not is_timed_out and (elapsed_since_activity > self.stall_threshold)

        return AgentHealthCheck(
            agent_id=agent_state["id"],
            is_alive=is_alive,
            is_stalled=is_stalled,
            is_timed_out=is_timed_out,
            seconds_since_activity=max(0, elapsed_since_activity),
            status=status,
        )

    def evaluate_agent(self, agent_state: dict) -> AgentHealthAction:
        """Evaluate a sub-agent and return the recommended action."""
        check = self.check_agent(agent_state)

        # Not alive — no action needed
        if not check.is_alive:
            return AgentHealthAction(
                agent_id=check.agent_id,
                action="ok",
                reason=f"agent is {check.status}",
            )

        # Timed out — report timeout
        if check.is_timed_out:
            return AgentHealthAction(
                agent_id=check.agent_id,
                action="timeout",
                reason=f"exceeded timeout after {check.seconds_since_activity}s",
            )

        # Not stalled — everything is fine
        if not check.is_stalled:
            return AgentHealthAction(
                agent_id=check.agent_id,
                action="ok",
                reason="active",
            )

        # Way too stalled (3x threshold) — retry without asking model
        if check.seconds_since_activity > self.stall_threshold * 3:
            return AgentHealthAction(
                agent_id=check.agent_id,
                action="retry",
                reason=f"stalled for {check.seconds_since_activity}s (>{self.stall_threshold * 3}s), auto-retry",
            )

        # Moderately stalled — try a ping first, or ask model if repeated
        task_desc = agent_state.get("task", "unknown task")[:80]
        should_retry = self.inference.verify_checks(
            f"sub-agent-{check.agent_id}",
            f"Agent working on '{task_desc}' stalled for {check.seconds_since_activity}s, "
            f"threshold is {self.stall_threshold}s",
        )

        if should_retry:
            return AgentHealthAction(
                agent_id=check.agent_id,
                action="ping",
                reason=f"stalled for {check.seconds_since_activity}s, model suggests action",
            )

        return AgentHealthAction(
            agent_id=check.agent_id,
            action="ok",
            reason=f"stalled for {check.seconds_since_activity}s but model says wait",
        )
