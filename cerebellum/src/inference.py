"""Qwen3 0.6B inference wrapper for cerebellum task evaluation."""

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


HEARTBEAT_PROMPT_TEMPLATE = """You are a task scheduler for CereWorker. Given the current tasks and system state, decide which tasks should run now.

Current time: {timestamp}
System state: {system_summary}

Tasks:
{tasks_text}

For each task, respond with a JSON array. Each element must have:
- "task_id": the task ID
- "action": one of "invoke", "skip", "defer", "cancel"
- "reason": brief explanation

Respond ONLY with the JSON array, nothing else."""


class CerebellumInference:
    """Wraps Qwen3-0.6B for structured task evaluation."""

    def __init__(self, model_path: str = "Qwen/Qwen3-0.6B"):
        self.model_path = model_path
        self.model = None
        self.tokenizer = None
        self._loaded = False

    def load(self) -> None:
        """Load the model and tokenizer."""
        if self._loaded:
            return

        logger.info(f"Loading model: {self.model_path}")
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer

            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_path, trust_remote_code=True
            )
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_path,
                torch_dtype="auto",
                device_map="auto",
                trust_remote_code=True,
            )
            self._loaded = True
            logger.info("Model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

    def is_loaded(self) -> bool:
        return self._loaded

    def evaluate_tasks(
        self,
        tasks: list[dict[str, Any]],
        system_summary: str,
        timestamp: int,
    ) -> list[dict[str, str]]:
        """Evaluate tasks and return actions."""
        if not self._loaded:
            logger.warning("Model not loaded, returning skip for all tasks")
            return [
                {"task_id": t["task_id"], "action": "skip", "reason": "model not loaded"}
                for t in tasks
            ]

        if not tasks:
            return []

        tasks_text = "\n".join(
            f"- ID: {t['task_id']} | Description: {t['description']} | "
            f"Status: {t['status']} | Last run: {t.get('last_run', 'never')} | "
            f"Schedule: {t.get('schedule_hint', 'unspecified')}"
            for t in tasks
        )

        prompt = HEARTBEAT_PROMPT_TEMPLATE.format(
            timestamp=timestamp,
            system_summary=system_summary or "Normal operation",
            tasks_text=tasks_text,
        )

        try:
            messages = [{"role": "user", "content": prompt}]
            text = self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            inputs = self.tokenizer([text], return_tensors="pt").to(self.model.device)

            outputs = self.model.generate(
                **inputs,
                max_new_tokens=512,
                temperature=0.3,
                do_sample=True,
            )

            generated = outputs[0][inputs["input_ids"].shape[-1]:]
            response = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
            logger.debug(f"Model response: {response}")

            return self._parse_actions(response, tasks)
        except Exception as e:
            logger.error(f"Inference error: {e}")
            return [
                {"task_id": t["task_id"], "action": "skip", "reason": f"inference error: {e}"}
                for t in tasks
            ]

    def _parse_actions(
        self, response: str, tasks: list[dict[str, Any]]
    ) -> list[dict[str, str]]:
        """Parse JSON response from the model."""
        # Try to extract JSON array from response
        try:
            # Handle cases where model wraps in markdown code blocks
            text = response.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
                if text.endswith("```"):
                    text = text[:-3]
                text = text.strip()

            actions = json.loads(text)
            if isinstance(actions, list):
                valid_actions = {"invoke", "skip", "defer", "cancel"}
                return [
                    {
                        "task_id": str(a.get("task_id", "")),
                        "action": a.get("action", "skip")
                        if a.get("action") in valid_actions
                        else "skip",
                        "reason": str(a.get("reason", "no reason")),
                    }
                    for a in actions
                    if isinstance(a, dict)
                ]
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.warning(f"Failed to parse model response: {e}")

        # Fallback: skip all tasks
        return [
            {"task_id": t["task_id"], "action": "skip", "reason": "failed to parse model response"}
            for t in tasks
        ]
