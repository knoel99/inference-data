"""Orchestrator wall clock plus a role/text transcript. No service split."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hosted_agentperf.cursor_ingest import ingest


class IngestTest(unittest.TestCase):
    def test_three_line_transcript(self) -> None:
        log = [
            {
                "type": "launch",
                "t": "2026-10-29T12:00:00Z",
                "agent_id": "bc-1",
                "model_pinned": "composer-2.5",
                "cell": "ctx2k_short",
                "phase": "A",
                "block": "pilot",
                "rep": 1,
            },
            {"type": "status", "t": "2026-10-29T12:00:00.200Z", "agent_id": "bc-1", "status": "CREATING"},
            {"type": "status", "t": "2026-10-29T12:00:00.800Z", "agent_id": "bc-1", "status": "RUNNING"},
            {"type": "finish", "t": "2026-10-29T12:00:06Z", "agent_id": "bc-1", "status": "FINISHED"},
        ]
        transcript = {
            "bc-1": [
                {"role": "user", "text": "hello"},
                {"role": "assistant", "thinking": "hmm"},
                {"role": "assistant", "text": "OK"},
            ]
        }
        rows, steps, report = ingest(log, transcript)
        self.assertEqual(steps, [])
        row = rows[0]
        self.assertEqual(row["model_pinned"], "composer-2.5")
        self.assertEqual(row["model_served"], "")
        self.assertEqual(row["measurement"], "user_experienced_wall_clock")
        self.assertAlmostEqual(row["start_wait_ms"], 800, delta=2)
        self.assertAlmostEqual(row["durationMs"], 6000, delta=2)
        self.assertEqual(row["n_user_messages"], 1)
        self.assertEqual(row["n_thinking"], 1)
        self.assertEqual(row["user_chars"], 5)
        self.assertEqual(row["assistant_text_chars"], 2)
        self.assertEqual(row["thinking_chars"], 3)
        for column in ("inputTokens", "ttft_ms", "decode_tps_est", "cache_ratio", "t_first_delta"):
            self.assertEqual(row[column], "")
        self.assertIn("not prefill", report["not_decomposable"])


if __name__ == "__main__":
    unittest.main()
