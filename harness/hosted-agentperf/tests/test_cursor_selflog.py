"""Synthetic step logs recover a known prefill slope, decode slope, and cache gap."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hosted_agentperf.cursor_selflog import analyze_steps, model_turns
from hosted_agentperf.schema import CURSOR_MODELS

L0 = 40.0
A = 0.025  # ms per new token
B = 8.0  # ms per output token


def _line(run, model, cell, step, t_before, t_after, read_bytes, write_bytes):
    return {
        "run_id": run,
        "model_pinned": model,
        "cell": cell,
        "step": step,
        "t_before": f"{t_before:.9f}",
        "t_after": f"{t_after:.9f}",
        "read_bytes": read_bytes,
        "read_tokens_est": read_bytes // 4,
        "write_bytes": write_bytes,
        "write_tokens_est": write_bytes // 4,
    }


def synthetic_steps() -> list[dict]:
    """Turn 1 reads the whole context. Turn 2 adds 80 tokens. Same output class."""
    steps = []
    contexts = (2000, 8000, 32000)
    outputs = {"short": 20, "long": 400}
    clock = 1_700_000_000.0
    for model in CURSOR_MODELS:
        for context in contexts:
            for name, output_tokens in outputs.items():
                cell = f"ctx{context // 1000}k_{name}"
                run = f"{model}-{cell}"
                # step 0: start mark, no gap yet
                steps.append(_line(run, model, cell, 0, clock, clock, 0, 0))
                # turn 1: cold context
                gap1 = (L0 + A * context + B * output_tokens) / 1000.0
                t1 = clock + gap1
                steps.append(_line(run, model, cell, 1, t1, t1 + 0.01, context * 4, output_tokens * 4))
                # turn 2: same context label, only 80 new tokens
                gap2 = (L0 + A * 80 + B * output_tokens) / 1000.0
                t2 = t1 + 0.01 + gap2
                steps.append(_line(run, model, cell, 2, t2, t2 + 0.01, 80 * 4, output_tokens * 4))
                clock = t2 + 1.0
    return steps


class SelfLogTest(unittest.TestCase):
    def test_recovers_slopes_and_cache_gap(self) -> None:
        report = analyze_steps(synthetic_steps())
        self.assertIn("agent-side wall clocks", report["label"])
        self.assertIn("bytes/4", report["label"])
        for model in CURSOR_MODELS:
            fit = report["by_model"][model]
            self.assertAlmostEqual(fit["L0_ms"], L0, delta=0.01)
            self.assertAlmostEqual(fit["a_ms_per_new_token"], A, places=5)
            self.assertAlmostEqual(fit["b_ms_per_output_token"], B, places=5)
            self.assertAlmostEqual(fit["prefill_tok_s_est"], 1000.0 / A, delta=0.01)
            self.assertAlmostEqual(fit["decode_tok_s_est"], 1000.0 / B, delta=0.01)
        effects = report["cache_effect"]
        self.assertEqual(len(effects), 2 * 3 * 2)
        for row in effects:
            self.assertLess(row["later_minus_turn1_ms"], 0)
            self.assertEqual(row["n_turn1"], 1)
            self.assertEqual(row["n_later"], 1)

    def test_gap_uses_end_then_start(self) -> None:
        steps = [
            _line("r", "composer-2.5", "ctx2k_short", 0, 10.0, 10.0, 0, 0),
            _line("r", "composer-2.5", "ctx2k_short", 1, 10.5, 11.0, 8000, 80),
        ]
        turns = model_turns(steps)
        self.assertEqual(len(turns), 1)
        self.assertAlmostEqual(turns[0]["turn_time_ms"], 500.0)
        self.assertEqual(turns[0]["new_tokens"], 2000)
        self.assertEqual(turns[0]["output_tokens"], 20)
        self.assertEqual(turns[0]["turn_index"], 1)
        self.assertEqual(turns[0]["context_tokens"], 2000)

    def test_round_trip_file(self) -> None:
        steps = synthetic_steps()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "steps.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in steps), encoding="utf-8")
            from hosted_agentperf.cursor_selflog import load_steps

            report = analyze_steps(load_steps(path))
        self.assertAlmostEqual(report["by_model"]["grok-4.7"]["a_ms_per_new_token"], A, places=6)


if __name__ == "__main__":
    unittest.main()
