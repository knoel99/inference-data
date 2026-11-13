# Correspondence with AA-AgentPerf-Local

`docs/schemas` in [aa-agentperf-local](https://github.com/ArtificialAnalysis/aa-agentperf-local) does not define `turns.jsonl`. FORMATS.md lists recipe, telemetry, runtime-qualification, and submission schemas. The per-turn record is `TurnReport` in `agentperf_local/reports/reporting.py` (read from the main branch on 2026-10-29).

## TurnReport fields we line up with

| AA field | Our column | Note |
| --- | --- | --- |
| `task_id` | `cell` | A calibration cell, or a SWE-bench task id in a later phase. |
| `conversation_idx` | `turn_index` | |
| `tokens.server_prompt_tokens` | `prompt_tokens` | `input_tokens + cache_creation_tokens + cache_read_tokens`. |
| `tokens.server_cached_prompt_tokens` | `cache_read_tokens` | |
| `tokens.server_uncached_prompt_tokens` | `new_tokens` | `input_tokens + cache_creation_tokens`. AA has no separate cache-write count; creation stays with the uncached side for a comparison. |
| `tokens.server_output_tokens` | `output_tokens` | Includes thinking when the server counts it there. |
| `timing.time_to_first_token_ms` | `ttft_ms` | `t_first_delta - t_send`. First content delta, thinking included. |
| `timing.generation_ms` | `decode_window_ms` | `t_last_delta - t_first_delta`. |
| `turn_decode_tokens_per_second` | `decode_tps` | `(output_tokens - 1) / window_seconds`. Empty when output tokens are below 2 or the window is missing. |
| `finish_reason` | `stop_reason` | |
| `success` / `error` | `failure_class` | AA's boolean is not the E1–E6 taxonomy. |
| `normalization.*` | not stored | AA scales the decode window to a recorded target. This harness does not normalize. |

`summary.json` in the local tool has `output_tokens_per_second` from `run_output_tokens_per_second`, which pools `(output_tokens - 1) / generation_seconds` over streamed turns, and `end_to_end_output_tokens_per_second`, which divides output tokens by full request duration.

## Published per-result speeds

The laptop and workstation leaderboard (page data on 2026-10-29) stores, on each run object:

- `prefillTokensPerSecond`
- `outputTokensPerSecond`

The page's own tooltip text, from the leaderboard bundle fetched the same day:

- Prefill speed: new input tokens per second. Each turn resends the conversation, the runtime reuses its cache, and only the tokens a turn adds to the previous prompt are counted. That total is divided by the total time to first token.
- Decode speed: tokens generated per second after each turn's first token, counting reasoning tokens. Total tokens are divided by total generation time, so longer turns count for more.

Those are run-level ratios of sums. They are not the regression in section 5.7.

| Quantity | What it includes that the other does not |
| --- | --- |
| AA `prefillTokensPerSecond` | Numerator is new tokens only. Denominator is the sum of TTFT, so queue wait and cache-read time are inside the prefill rate. |
| `1000 / alpha` from this harness | Slope of the tau=0.10 fit of TTFT on new tokens, with cache-read tokens and a block indicator in the same fit. Positive wait sits in the residual above that quantile instead of in alpha. |
| AA `outputTokensPerSecond` | One pooled rate for the run. Longer turns weigh more. The tooltip does not mention subtracting one token. |
| `decode_tps` here | Per request, `(output_tokens - 1) / window`, then median, p10, and p90. The minus one matches the local reporter's per-turn function. |
| `pooled_decode_tok_s` in the analysis JSON | The same minus-one pool, labeled as the closest single number to AA's `outputTokensPerSecond`. |

The analysis JSON writes `aa_style_prefill_tok_s` next to `prefill_tok_s_from_alpha` so the two definitions stay visible. They are not substitutes.
