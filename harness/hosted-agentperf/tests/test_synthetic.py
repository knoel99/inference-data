"""Joiner plus quantile regression recover a known line under skewed wait."""

from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hosted_agentperf.analysis import analyze
from hosted_agentperf.join import join_records
from hosted_agentperf.pilot import build_plan, claude_argv, format_plan
from hosted_agentperf.schema import MODEL_PINNED
from hosted_agentperf.sse import SseAssembler

L0 = 100.0
ALPHA = 0.05
BETA = 0.001
GAMMA = 30.0


def _wait(rng: random.Random) -> float:
    if rng.random() < 0.85:
        return 0.0
    return rng.expovariate(1.0 / 400.0)


def _rows():
    rng = random.Random(7)
    proxy = []
    spans = []
    clock = 10_000_000.0
    specs = []
    for size in (2000, 8000, 32000):
        for _rep in range(8):
            specs.append(("C0", size, 0, "b0" if _rep < 4 else "b1"))
            specs.append(("C1", size, 0, "b0" if _rep < 4 else "b1"))
        specs.append(("C2", 100, size, "b0"))
        specs.append(("C2", 100, size, "b1"))
    for new in (1000, 4000, 16000):
        for block in ("b0", "b1"):
            for _rep in range(4):
                specs.append(("C3", new, 32000, block))
    for index, (kind, new, cached, block) in enumerate(specs):
        gamma = GAMMA if block == "b1" else 0.0
        ttft = L0 + ALPHA * new + BETA * cached + gamma + _wait(rng)
        if kind == "C1":
            input_tokens, creation = 0, new
        else:
            input_tokens, creation = new, 0
        request_id = f"req_{index}"
        send = clock
        proxy.append(
            {
                "request_id": request_id,
                "cell": f"{kind}_{new}_{cached}",
                "phase": "A",
                "block": block,
                "rep": index,
                "session_id": "s",
                "turn_index": 0,
                "http_status": 200,
                "model": MODEL_PINNED,
                "t_send_mono_ms": send,
                "t_first_delta_mono_ms": send + ttft,
                "t_last_delta_mono_ms": send + ttft + 100,
                "t_message_stop_mono_ms": send + ttft + 110,
                "input_tokens": input_tokens,
                "cache_creation_tokens": creation,
                "cache_read_tokens": cached,
                "output_tokens": 8,
                "stop_reason": "end_turn",
                "saw_message_stop": True,
                "streaming": True,
                "n_tool_calls": 0,
            }
        )
        spans.append(
            {
                "record_kind": "span",
                "span_name": "claude_code.llm_request",
                "request_id": request_id,
                "query_source": "repl_main_thread",
                "first_content_ms": ttft - 5,
                "ttft_ms": ttft - 3,
                "model": MODEL_PINNED,
                "effort": "low",
            }
        )
        clock += 1000
    proxy.append(
        {
            "request_id": "req_off",
            "cell": "C3_999_0",
            "phase": "A",
            "block": "b0",
            "rep": 0,
            "http_status": 200,
            "model": MODEL_PINNED,
            "t_send_mono_ms": clock,
            "t_first_delta_mono_ms": clock + 50_000,
            "input_tokens": 32000,
            "cache_creation_tokens": 0,
            "cache_read_tokens": 0,
            "output_tokens": 4,
            "stop_reason": "end_turn",
            "saw_message_stop": True,
            "streaming": True,
            "n_tool_calls": 0,
        }
    )
    spans.append(
        {
            "request_id": "req_off",
            "query_source": "compact",
            "model": MODEL_PINNED,
            "first_content_ms": 50_000,
        }
    )
    return proxy, spans


class SyntheticTest(unittest.TestCase):
    def test_join_and_quantile_recover_line(self) -> None:
        proxy, spans = _rows()
        joined = join_records(proxy, spans, meta={"model_pinned": MODEL_PINNED, "effort": "low"})
        off = [row for row in joined if row["request_id"] == "req_off"]
        self.assertEqual(off[0]["off_thread"], 1)
        self.assertEqual(off[0]["failure_class"], "E6")
        main = [row for row in joined if row["request_id"] == "req_0"]
        self.assertEqual(main[0]["off_thread"], 0)
        self.assertAlmostEqual(float(main[0]["proxy_offset_ms"]), 5.0, places=6)
        self.assertEqual(main[0]["new_tokens"], main[0]["input_tokens"] + main[0]["cache_creation_tokens"])
        report = analyze(joined, n_boot=40, seed=1)
        coef = report["quantile_regression"]["coefficients_ms"]
        self.assertAlmostEqual(coef["alpha"], ALPHA, delta=0.01)
        self.assertAlmostEqual(coef["beta"], BETA, delta=0.0004)
        self.assertAlmostEqual(coef["L0"], L0, delta=15)
        self.assertNotEqual(report["placeholder_not_used"]["se_alpha_ms_per_token"], coef["alpha"])
        ratio = report["quantile_regression"]["beta_over_alpha_estimated"]
        self.assertAlmostEqual(ratio, BETA / ALPHA, delta=0.01)
        self.assertNotAlmostEqual(ratio, 0.01, places=3)
        se = report["quantile_regression"]["se_formula_ms"]["alpha"]
        self.assertIsNotNone(se)
        self.assertGreater(se, 0)
        self.assertNotAlmostEqual(se, 0.0012, places=5)

    def test_plan_requires_confirm_and_pins_model(self) -> None:
        plan = build_plan()
        self.assertEqual(plan["request_count"], 26)
        text = format_plan(plan)
        self.assertIn("No request is sent unless you pass --confirm.", text)
        self.assertGreater(
            plan["worst_case_new_tokens_if_every_request_misses"],
            plan["expected_new_tokens_if_warm_hits"],
        )
        argv = claude_argv("claude", Path("settings.json"), "hello")
        self.assertIn("--restricted", argv)
        self.assertIn(MODEL_PINNED, argv)
        self.assertIn("low", argv)
        self.assertNotIn("--bare", argv)
        self.assertNotIn("ultracode", argv)

    def test_sse_timestamps_follow_the_chunk_that_completes_the_event(self) -> None:
        body = (
            'event: message_start\n'
            'data: {"type":"message_start","message":{"model":"claude-sonnet-5-5",'
            '"usage":{"input_tokens":3,"output_tokens":1,'
            '"cache_creation":{"ephemeral_1h_input_tokens":3,"ephemeral_5m_input_tokens":0}}}}\n\n'
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}\n\n'
            'event: content_block_delta\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n'
            'event: message_delta\n'
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n'
            'event: message_stop\n'
            'data: {"type":"message_stop"}\n\n'
        ).encode()
        parser = SseAssembler()
        offset = 0
        stamp = 0.0
        while offset < len(body):
            piece = body[offset : offset + 17]
            stamp += 10
            parser.feed(piece, stamp)
            offset += 17
        parser.finish(stamp)
        self.assertLess(parser.t_first_delta, parser.t_first_text)
        self.assertLess(parser.t_first_text, parser.t_message_stop)
        self.assertEqual(parser.model, "claude-sonnet-5-5")
        self.assertEqual(parser.stop_reason, "end_turn")
        usage = parser.merged_usage()
        self.assertEqual(usage["output_tokens"], 4)
        self.assertEqual(usage["cache_creation_1h"], 3)


if __name__ == "__main__":
    unittest.main()
