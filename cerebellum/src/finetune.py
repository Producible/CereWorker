"""Fine-tuning engine for the Cerebellum's Instinct pillar.

Trains the small LLM on curated instruction/response pairs using LoRA, QLoRA,
or full fine-tuning. Runs in a background thread so the gRPC server stays
responsive for heartbeat, verification, and monitoring.
"""

import json
import inspect
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)

PENDING_FILE = "pending.jsonl"
DEFAULT_SFT_MAX_LENGTH = 512


def _callable_accepts_kwarg(target: object, kwarg: str) -> bool:
    """Return whether the given callable/class explicitly accepts a kwarg."""
    candidate = target.__init__ if inspect.isclass(target) else target
    try:
        signature = inspect.signature(candidate)
    except (TypeError, ValueError):
        return False
    return kwarg in signature.parameters


def _resolve_sft_sequence_length_kwargs(
    sft_config_cls: object,
    sft_trainer_cls: object,
    max_length: int = DEFAULT_SFT_MAX_LENGTH,
) -> tuple[dict[str, int], dict[str, int]]:
    """Choose TRL-compatible sequence-length kwargs for config and trainer."""
    if _callable_accepts_kwarg(sft_config_cls, "max_length"):
        return {"max_length": max_length}, {}
    if _callable_accepts_kwarg(sft_config_cls, "max_seq_length"):
        return {"max_seq_length": max_length}, {}
    if _callable_accepts_kwarg(sft_trainer_cls, "max_length"):
        return {}, {"max_length": max_length}
    if _callable_accepts_kwarg(sft_trainer_cls, "max_seq_length"):
        return {}, {"max_seq_length": max_length}
    logger.warning(
        "TRL SFT sequence-length kwarg not detected; using library defaults"
    )
    return {}, {}


def _resolve_sft_processing_kwargs(
    sft_trainer_cls: object,
    tokenizer: object,
) -> dict[str, object]:
    """Choose TRL-compatible tokenizer/processor kwargs for SFTTrainer."""
    if _callable_accepts_kwarg(sft_trainer_cls, "processing_class"):
        return {"processing_class": tokenizer}
    if _callable_accepts_kwarg(sft_trainer_cls, "tokenizer"):
        return {"tokenizer": tokenizer}
    logger.warning(
        "TRL SFTTrainer tokenizer kwarg not detected; proceeding without it"
    )
    return {}


@dataclass
class FineTuneJob:
    """Tracks a single fine-tune run."""

    job_id: str = ""
    status: str = "idle"  # idle, running, completed, failed
    progress: float = 0.0
    current_step: int = 0
    total_steps: int = 0
    current_loss: float = 0.0
    error: str = ""
    checkpoint_path: str = ""
    started_at: float = 0.0
    completed_at: float = 0.0
    method: str = ""


class FineTuneEngine:
    """Manages training data ingestion and background fine-tuning."""

    def __init__(
        self,
        model_path: str,
        checkpoint_dir: str = "/checkpoints",
        data_dir: str = "/data",
    ):
        self.model_path = model_path
        self.checkpoint_dir = checkpoint_dir
        self.data_dir = data_dir
        self._current_job = FineTuneJob()
        self._lock = threading.Lock()

        os.makedirs(data_dir, exist_ok=True)
        os.makedirs(checkpoint_dir, exist_ok=True)

    def ingest(self, pairs: list[dict]) -> int:
        """Append training pairs to pending data file. Returns total pending count."""
        path = os.path.join(self.data_dir, PENDING_FILE)
        with open(path, "a") as f:
            for pair in pairs:
                f.write(json.dumps(pair) + "\n")

        return self._count_pending()

    def start(
        self,
        method: str = "auto",
        epochs: int = 3,
        lr: float = 2e-4,
        batch_size: int = 4,
        on_complete: Callable[[str, str], None] | None = None,
    ) -> FineTuneJob:
        """Start fine-tuning in a background thread. Non-blocking."""
        with self._lock:
            if self._current_job.status == "running":
                job = FineTuneJob(
                    job_id=self._current_job.job_id,
                    status="running",
                    error="Fine-tuning already in progress",
                )
                return job

            pending = self._count_pending()
            if pending == 0:
                return FineTuneJob(error="No training data pending")

            if method == "auto":
                method = self._detect_method()

            job_id = f"ft-{int(time.time())}"
            self._current_job = FineTuneJob(
                job_id=job_id,
                status="running",
                started_at=time.time(),
                method=method,
            )

        logger.info(
            f"Starting fine-tune job {job_id}",
            extra={"method": method, "epochs": epochs, "pending": pending},
        )

        thread = threading.Thread(
            target=self._train,
            args=(job_id, method, epochs, lr, batch_size, on_complete),
            daemon=True,
        )
        thread.start()

        return FineTuneJob(job_id=job_id, status="running", method=method)

    def get_status(self) -> FineTuneJob:
        """Return current job status."""
        return self._current_job

    def _count_pending(self) -> int:
        path = os.path.join(self.data_dir, PENDING_FILE)
        if not os.path.exists(path):
            return 0
        with open(path) as f:
            return sum(1 for line in f if line.strip())

    @staticmethod
    def _detect_method() -> str:
        """Auto-detect best training method based on available hardware."""
        try:
            import torch

            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                vram_gb = total / (1024**3)
                if vram_gb >= 4:
                    logger.info(f"Auto-detected LoRA (GPU VRAM: {vram_gb:.1f} GB)")
                    return "lora"
                if vram_gb >= 2:
                    logger.info(f"Auto-detected QLoRA (GPU VRAM: {vram_gb:.1f} GB)")
                    return "qlora"
        except Exception:
            pass

        logger.info("Auto-detected full fine-tune (CPU mode)")
        return "full"

    def _train(
        self,
        job_id: str,
        method: str,
        epochs: int,
        lr: float,
        batch_size: int,
        on_complete: Callable[[str, str], None] | None,
    ) -> None:
        """Run fine-tuning in background thread."""
        try:
            self._run_training(job_id, method, epochs, lr, batch_size)

            checkpoint_path = os.path.join(self.checkpoint_dir, job_id)
            with self._lock:
                self._current_job.status = "completed"
                self._current_job.progress = 1.0
                self._current_job.checkpoint_path = checkpoint_path
                self._current_job.completed_at = time.time()

            # Clear consumed training data
            pending_path = os.path.join(self.data_dir, PENDING_FILE)
            if os.path.exists(pending_path):
                open(pending_path, "w").close()

            logger.info(f"Fine-tune job {job_id} completed: {checkpoint_path}")

            if on_complete:
                on_complete(checkpoint_path, method)

        except Exception as e:
            logger.error(f"Fine-tune job {job_id} failed: {e}")
            with self._lock:
                self._current_job.status = "failed"
                self._current_job.error = str(e)
                self._current_job.completed_at = time.time()

    def _run_training(
        self,
        job_id: str,
        method: str,
        epochs: int,
        lr: float,
        batch_size: int,
    ) -> None:
        """Core training logic — loads data, configures trainer, runs."""
        import torch
        from datasets import Dataset
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            TrainingArguments,
            TrainerCallback,
        )
        from trl import SFTTrainer, SFTConfig

        # 1. Load training data
        pending_path = os.path.join(self.data_dir, PENDING_FILE)
        pairs = []
        with open(pending_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    pairs.append(json.loads(line))

        if not pairs:
            raise ValueError("No training pairs found")

        logger.info(f"Loaded {len(pairs)} training pairs")

        # Format as chat conversations for SFTTrainer
        def format_pair(pair: dict) -> dict:
            return {
                "messages": [
                    {"role": "user", "content": pair["instruction"]},
                    {"role": "assistant", "content": pair["response"]},
                ]
            }

        dataset = Dataset.from_list([format_pair(p) for p in pairs])

        # 2. Load model
        tokenizer = AutoTokenizer.from_pretrained(
            self.model_path, trust_remote_code=True
        )
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        model_kwargs = {
            "trust_remote_code": True,
            "torch_dtype": "auto",
        }

        if method == "qlora":
            from transformers import BitsAndBytesConfig

            model_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
            )
            model_kwargs["device_map"] = "auto"
        elif method == "lora":
            model_kwargs["device_map"] = "auto"
        else:
            # Full fine-tune — CPU or single GPU
            model_kwargs["device_map"] = "auto"

        model = AutoModelForCausalLM.from_pretrained(self.model_path, **model_kwargs)

        # 3. Apply LoRA/QLoRA if needed
        if method in ("lora", "qlora"):
            from peft import LoraConfig, get_peft_model, TaskType

            lora_config = LoraConfig(
                r=16,
                lora_alpha=32,
                target_modules=["q_proj", "v_proj"],
                lora_dropout=0.05,
                bias="none",
                task_type=TaskType.CAUSAL_LM,
            )
            model = get_peft_model(model, lora_config)
            trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
            total = sum(p.numel() for p in model.parameters())
            logger.info(
                f"LoRA applied: {trainable:,} trainable / {total:,} total params"
            )

        # 4. Progress callback
        engine = self

        class ProgressCallback(TrainerCallback):
            def on_step_end(self, args, state, control, **kwargs):
                with engine._lock:
                    engine._current_job.current_step = state.global_step
                    engine._current_job.total_steps = state.max_steps
                    engine._current_job.progress = (
                        state.global_step / state.max_steps
                        if state.max_steps > 0
                        else 0
                    )
                    if state.log_history:
                        last = state.log_history[-1]
                        if "loss" in last:
                            engine._current_job.current_loss = last["loss"]

        # 5. Training arguments
        checkpoint_path = os.path.join(self.checkpoint_dir, job_id)
        os.makedirs(checkpoint_path, exist_ok=True)

        sft_config_seq_kwargs, trainer_seq_kwargs = _resolve_sft_sequence_length_kwargs(
            SFTConfig,
            SFTTrainer,
        )

        training_args = SFTConfig(
            output_dir=checkpoint_path,
            num_train_epochs=epochs,
            per_device_train_batch_size=batch_size,
            learning_rate=lr,
            logging_steps=1,
            save_strategy="no",  # we save manually at the end
            report_to="none",
            fp16=torch.cuda.is_available(),
            gradient_accumulation_steps=max(1, 4 // batch_size),
            warmup_ratio=0.1,
            **sft_config_seq_kwargs,
        )

        # 6. Train
        trainer = SFTTrainer(
            model=model,
            args=training_args,
            train_dataset=dataset,
            callbacks=[ProgressCallback()],
            **_resolve_sft_processing_kwargs(SFTTrainer, tokenizer),
            **trainer_seq_kwargs,
        )

        trainer.train()

        # 7. Save
        if method in ("lora", "qlora"):
            # Save only the adapter weights
            model.save_pretrained(checkpoint_path)
            logger.info(f"LoRA adapter saved to {checkpoint_path}")
        else:
            # Save full model
            model.save_pretrained(checkpoint_path)
            tokenizer.save_pretrained(checkpoint_path)
            logger.info(f"Full model saved to {checkpoint_path}")
