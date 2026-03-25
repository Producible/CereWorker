"""Qwen3 0.6B inference wrapper - binary yes/no verdicts only.

The Cerebellum is a watchdog, not a thinker. It answers simple yes/no
questions: "Should this task run?" and "Is this tool result OK?"
All complex reasoning stays in the Cerebrum (giant LLM).
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Low temperature for deterministic binary outputs
TEMPERATURE = 0.1
MAX_NEW_TOKENS = 3


class CerebellumInference:
    """Wraps a small LLM for binary yes/no verdicts."""

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

    def apply_adapter(self, adapter_path: str) -> None:
        """Load and merge a LoRA adapter into the current model."""
        if not self._loaded:
            logger.error("Cannot apply adapter: model not loaded")
            return

        from peft import PeftModel

        logger.info(f"Applying adapter from {adapter_path}")
        self.model = PeftModel.from_pretrained(self.model, adapter_path)
        self.model = self.model.merge_and_unload()
        logger.info("Adapter merged successfully")

    def reload(self, model_path: str) -> None:
        """Reload the model from a full checkpoint (for full fine-tune)."""
        logger.info(f"Reloading model from {model_path}")
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(
            model_path, trust_remote_code=True
        )
        self.model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype="auto",
            device_map="auto",
            trust_remote_code=True,
        )
        logger.info("Model reloaded successfully")

    def should_run_task(
        self,
        description: str,
        elapsed_seconds: int,
        schedule_hint: str,
        system_busy: bool,
    ) -> bool:
        """Ask the model: should this single task run now? Returns True/False.

        This is only called for ambiguous cases (0.8x-2.0x the expected
        interval). Clear-cut cases are handled by deterministic code in
        the HeartbeatEngine without touching the model.
        """
        if not self._loaded:
            logger.warning("Model not loaded, defaulting to skip")
            return False

        elapsed_str = _format_elapsed(elapsed_seconds)
        status = "busy" if system_busy else "idle"

        prompt = (
            f"Task: {description}. "
            f"Last run: {elapsed_str} ago. "
            f"Schedule: {schedule_hint}. "
            f"System: {status}. "
            f"Should this task run now? Answer yes or no."
        )

        response = self._generate(prompt)
        result = self._parse_yes_no(response)

        if result is None:
            logger.warning(f"Unparseable response '{response}', defaulting to no")
            return False

        return result

    def verify_checks(self, tool_name: str, check_summary: str, tool_args: str = "") -> bool:
        """Ask the model: given these check results, is everything OK?

        The programmatic checks have already run. This is a final binary
        sanity gate. If the model produces garbage, callers fall back to
        the programmatic check results alone.
        """
        if not self._loaded:
            logger.warning("Model not loaded, defaulting to pass")
            return True

        prompt = (
            f"Tool '{tool_name}' ran"
            f"{f' with args: {tool_args}' if tool_args else ''}. "
            f"Checks: {check_summary}. "
            f"Is everything OK? Answer yes or no."
        )

        response = self._generate(prompt)
        result = self._parse_yes_no(response)

        if result is None:
            logger.warning(f"Unparseable response '{response}', defaulting to pass")
            return True

        return result

    def _generate(self, prompt: str) -> str:
        """Run inference with minimal token generation."""
        try:
            messages = [
                {"role": "system", "content": "You are a binary watchdog. Answer every question with exactly one word: yes or no."},
                {"role": "user", "content": prompt},
            ]
            text = self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            inputs = self.tokenizer([text], return_tensors="pt").to(self.model.device)

            outputs = self.model.generate(
                **inputs,
                max_new_tokens=MAX_NEW_TOKENS,
                temperature=TEMPERATURE,
                do_sample=True,
            )

            generated = outputs[0][inputs["input_ids"].shape[-1] :]
            response = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
            logger.debug(f"Prompt: {prompt[:80]}... Response: {response}")
            return response
        except Exception as e:
            logger.error(f"Inference error: {e}")
            return ""

    @staticmethod
    def _parse_yes_no(response: str) -> bool | None:
        """Parse a yes/no response. Returns None if unparseable."""
        if not response:
            return None

        first_word = response.strip().split()[0].lower().rstrip(".,!?")

        if first_word in ("yes", "y"):
            return True
        if first_word in ("no", "n"):
            return False

        return None


def _format_elapsed(seconds: int) -> str:
    """Format elapsed seconds into human-readable string."""
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"
