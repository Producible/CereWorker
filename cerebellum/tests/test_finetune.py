import unittest

from src.finetune import (
    _callable_accepts_kwarg,
    _resolve_sft_processing_kwargs,
    _resolve_sft_sequence_length_kwargs,
)


class ModernSFTConfig:
    def __init__(self, output_dir=None, max_length=None):
        self.output_dir = output_dir
        self.max_length = max_length


class LegacySFTConfig:
    def __init__(self, output_dir=None, max_seq_length=None):
        self.output_dir = output_dir
        self.max_seq_length = max_seq_length


class ModernSFTTrainer:
    def __init__(self, model=None, args=None, processing_class=None, max_length=None):
        self.model = model
        self.args = args
        self.processing_class = processing_class
        self.max_length = max_length


class LegacySFTTrainer:
    def __init__(self, model=None, args=None, tokenizer=None, max_seq_length=None):
        self.model = model
        self.args = args
        self.tokenizer = tokenizer
        self.max_seq_length = max_seq_length


class MinimalSFTTrainer:
    def __init__(self, model=None, args=None):
        self.model = model
        self.args = args


class FineTuneCompatTests(unittest.TestCase):
    def test_detects_explicit_kwargs(self):
        self.assertTrue(_callable_accepts_kwarg(ModernSFTConfig, "max_length"))
        self.assertFalse(_callable_accepts_kwarg(ModernSFTConfig, "max_seq_length"))

    def test_prefers_modern_sft_config_max_length(self):
        config_kwargs, trainer_kwargs = _resolve_sft_sequence_length_kwargs(
            ModernSFTConfig,
            ModernSFTTrainer,
            max_length=768,
        )
        self.assertEqual(config_kwargs, {"max_length": 768})
        self.assertEqual(trainer_kwargs, {})

    def test_falls_back_to_legacy_sft_config_max_seq_length(self):
        config_kwargs, trainer_kwargs = _resolve_sft_sequence_length_kwargs(
            LegacySFTConfig,
            ModernSFTTrainer,
            max_length=384,
        )
        self.assertEqual(config_kwargs, {"max_seq_length": 384})
        self.assertEqual(trainer_kwargs, {})

    def test_falls_back_to_trainer_when_config_has_no_length_kwarg(self):
        config_kwargs, trainer_kwargs = _resolve_sft_sequence_length_kwargs(
            object,
            LegacySFTTrainer,
            max_length=256,
        )
        self.assertEqual(config_kwargs, {})
        self.assertEqual(trainer_kwargs, {"max_seq_length": 256})

    def test_prefers_processing_class_for_modern_trl(self):
        tokenizer = object()
        kwargs = _resolve_sft_processing_kwargs(ModernSFTTrainer, tokenizer)
        self.assertEqual(kwargs, {"processing_class": tokenizer})

    def test_falls_back_to_tokenizer_for_legacy_trl(self):
        tokenizer = object()
        kwargs = _resolve_sft_processing_kwargs(LegacySFTTrainer, tokenizer)
        self.assertEqual(kwargs, {"tokenizer": tokenizer})

    def test_returns_empty_processing_kwargs_when_trainer_has_no_hook(self):
        kwargs = _resolve_sft_processing_kwargs(MinimalSFTTrainer, object())
        self.assertEqual(kwargs, {})


if __name__ == "__main__":
    unittest.main()
