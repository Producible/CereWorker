"""Tool verification (Muscle+Skeleton pillar).

Two-layer verification:
1. Programmatic checks (no LLM) - deterministic assertions about tool effects
2. Model verdict (binary) - final yes/no sanity gate

The programmatic checks do 95% of the work. The model is only consulted
when all programmatic checks pass, as a final sanity gate. If any
programmatic check fails, the result is immediately failed without
asking the model.
"""

import logging
import os
import time
from dataclasses import dataclass, field

from .inference import CerebellumInference

logger = logging.getLogger(__name__)


@dataclass
class Check:
    name: str
    passed: bool
    description: str


@dataclass
class VerificationResult:
    passed: bool
    checks: list[Check] = field(default_factory=list)
    model_verdict: bool = True


class ToolVerifier:
    """Verifies tool execution results via programmatic checks + model verdict."""

    def __init__(
        self,
        inference: CerebellumInference,
        workspace_dir: str = "/workspace",
        memory_dir: str = "/memory",
    ):
        self.inference = inference
        self.workspace_dir = workspace_dir
        self.memory_dir = memory_dir

    def verify(
        self,
        tool_name: str,
        tool_args: dict[str, str],
        tool_output: str,
        claimed_success: bool,
    ) -> VerificationResult:
        """Run programmatic checks, then ask model for verdict."""
        checks = self._run_checks(tool_name, tool_args, tool_output, claimed_success)

        all_passed = all(c.passed for c in checks)

        if not all_passed:
            # Programmatic check failed - no need for model
            return VerificationResult(passed=False, checks=checks, model_verdict=False)

        # All programmatic checks pass - ask model as final gate
        summary = self._summarize_checks(checks)
        args_str = ", ".join(f"{k}={v}" for k, v in tool_args.items())[:200]
        model_verdict = self.inference.verify_checks(tool_name, summary, args_str)

        return VerificationResult(
            passed=model_verdict, checks=checks, model_verdict=model_verdict
        )

    def _run_checks(
        self,
        tool_name: str,
        tool_args: dict[str, str],
        tool_output: str,
        claimed_success: bool,
    ) -> list[Check]:
        checks: list[Check] = []

        # Universal checks (all tools)
        checks.append(
            Check("claimed_success", claimed_success, "Tool claimed success")
        )
        checks.append(
            Check("has_output", bool(tool_output.strip()), "Tool produced output")
        )

        # Tool-specific checks
        if tool_name == "writeFile":
            self._check_write_file(checks, tool_args)
        elif tool_name == "shell":
            self._check_shell(checks, tool_output)
        elif tool_name == "readFile":
            self._check_read_file(checks, tool_args, tool_output)
        elif tool_name in ("memory_write", "memory_log"):
            self._check_memory(checks)

        return checks

    def _check_write_file(self, checks: list[Check], tool_args: dict[str, str]) -> None:
        path = tool_args.get("path", "")
        resolved = self._resolve_path(path)

        exists = os.path.exists(resolved)
        checks.append(Check("file_exists", exists, f"File {path} exists"))

        if exists:
            stat = os.stat(resolved)
            recent = (time.time() - stat.st_mtime) < 30
            checks.append(
                Check("recently_modified", recent, "File was recently modified")
            )
            checks.append(
                Check("non_empty", stat.st_size > 0, "File is non-empty")
            )

    def _check_shell(self, checks: list[Check], tool_output: str) -> None:
        output_lower = tool_output.lower()
        checks.append(
            Check(
                "not_timeout",
                "timed out" not in output_lower,
                "Command did not timeout",
            )
        )
        checks.append(
            Check(
                "not_denied",
                "permission denied" not in output_lower,
                "Command was not denied",
            )
        )

    def _check_read_file(
        self, checks: list[Check], tool_args: dict[str, str], tool_output: str
    ) -> None:
        path = tool_args.get("path", "")
        resolved = self._resolve_path(path)
        checks.append(
            Check("file_exists", os.path.exists(resolved), f"File {path} exists")
        )
        checks.append(
            Check(
                "non_trivial_output",
                len(tool_output) > 10,
                "Output is non-trivial",
            )
        )

    def _check_memory(self, checks: list[Check]) -> None:
        if not os.path.exists(self.memory_dir):
            checks.append(
                Check("memory_dir_exists", False, "Memory directory exists")
            )
            return

        files = [
            f
            for f in os.listdir(self.memory_dir)
            if os.path.isfile(os.path.join(self.memory_dir, f))
        ]
        if files:
            latest_mtime = max(
                os.path.getmtime(os.path.join(self.memory_dir, f)) for f in files
            )
            recent = (time.time() - latest_mtime) < 30
            checks.append(
                Check("memory_updated", recent, "Memory was recently updated")
            )
        else:
            checks.append(
                Check("memory_has_files", False, "Memory directory has files")
            )

    def _resolve_path(self, path: str) -> str:
        """Map a host-side path to the container-mounted workspace."""
        if path.startswith("/") and self.workspace_dir != "/":
            return os.path.join(self.workspace_dir, path.lstrip("/"))
        return os.path.join(self.workspace_dir, path)

    @staticmethod
    def _summarize_checks(checks: list[Check]) -> str:
        passed = [c for c in checks if c.passed]
        failed = [c for c in checks if not c.passed]
        parts = [f"{len(passed)} of {len(checks)} checks passed"]
        if passed:
            parts.append(": " + ", ".join(c.description for c in passed))
        if failed:
            parts.append(". FAILED: " + ", ".join(c.description for c in failed))
        return "".join(parts)
