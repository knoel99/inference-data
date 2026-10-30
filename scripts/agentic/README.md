# Sonnet concurrency sweep

Two scripts behind `data/agentic/sonnet_concurrency_calls.csv` and `sonnet_concurrency_tiers.csv` and the site's Agentic > Concurrency sub-tab. The runner is billed; nothing here runs without `ANTHROPIC_API_KEY` except `--dry-run`.

## Run

```sh
# corpus for the essay workload (Project Gutenberg #2701, public domain), kept out of git
curl -L https://www.gutenberg.org/ebooks/2701.txt.utf-8 -o scripts/agentic/mobydick.txt

# build and check every request offline: no key, no network, no CSV
python scripts/agentic/sonnet_concurrency_sweep.py --dry-run --workload agentic --tiers 2 --turns 3 --start-tok 100000 --turn-tok 2000

# count_tokens only (free endpoint): tokens of the fixed prefix and chars per token of one chunk, to set --chars-per-tok
python scripts/agentic/sonnet_concurrency_sweep.py --calibrate --workload agentic

# billed run, then aggregate and validate
python scripts/agentic/sonnet_concurrency_sweep.py --tiers 32,64 --turns 30 --start-tok 100000 --turn-tok 2000 --max-tokens 4000 --cap-usd 130 --out run2.csv
python scripts/agentic/sonnet_concurrency_aggregate.py run1.csv run2.csv data/agentic
python scripts/validate.py
```

The aggregator accepts runner CSVs and already published calls CSVs alike, so a new run is appended by listing the published file first. Columns a run did not record stay blank.

## Workloads

- `essay` (the published sweep): Moby-Dick excerpts, one ~500-word essay per turn. Output is prose, ~1k tokens, always `end_turn`.
- `agentic`: the local Python standard library served as a fake repository through `next_file`, `write_file` and `run_tests` tools under a short coding-agent system prompt. The model's output is code inside `tool_use` JSON and every turn after the first is a `tool_result`, which is the shape of a coding agent's traffic. Chunks are sized in characters with `--chars-per-tok` (default 3.0; measure it with `--calibrate`). Same `--start-tok` and `--turn-tok` means the same prompt tokens per turn, so the two workloads cost the same except for the ~1k-token system prompt and the output length the model chooses.

## What each call records

Timestamps: send, response headers, `message_start`, first `content_block_start`, first content delta, first text delta, last delta, done. Derived: `ttfb_ms`, `ttft_block_ms`, `ttft_ms` (first delta, the published definition), `ttft_text_ms`, `inst_gen_tps` (all output tokens over the delta window) and `inst_gen_text_tps` (visible text tokens over the text window). Sonnet 5.5 did not stream a thinking delta in any of the 310 published calls, so `ttft_ms` includes the thinking time and `inst_gen_tps` counts thinking tokens that were generated before the window; `inst_gen_text_tps` does not. Rate-limit headers: requests remaining, input and output token limits, remaining and reset, `retry-after`. `block_types` lists the content blocks in stream order.

## Tier metrics

InferenceX formulas over the tier window (first request sent to last response finished): gen/session, new prefill/session (uncached input + cache writes), ingest/session (all prompt tokens), each divided by the window and by N. Plus `gen_per_session_span_tps` (each session over its own span, mean over sessions) and `inflight_mean` (time-weighted requests in flight): when `inflight_mean` is well under N the window formula is diluted by the ragged tier end, which is why the published N=16 tier shows 64 tok/s while every session ran at ~71 tok/s. `http_429` is the key's rate limit; `http_529` is API-side overload; `http_other_errors` is everything else, including dropped connections.

## Guard rails

- Budget: every call reserves its worst case (new tokens at the cache-write price, the previous prompt at the cache-read price, `--max-tokens` at the output price, times 1.1) before sending and settles the actual cost after. A session idle for more than 4 minutes reserves its whole prompt at the write price because the 5-minute cache may have expired. `--max-tokens` is the lever: at 16000 each in-flight call reserves ~0.18 USD of output, so N=64 needs ~12 USD of headroom just to be admitted; 4000 is ample for ~1k-token replies with adaptive thinking.
- Failures: a session that fails after retries stops itself; the tier stops when more than `--max-failed-frac` (default 0.25) of its sessions failed, or on `budget_cap`.
- Client load: each tier logs the event-loop lag (p99 and max) and the process CPU share. Lag p99 above 50 ms or CPU above 70% of wall means the client, not the API, is shaping the numbers. The connection pool is sized to the largest tier so every stream has its own kept-alive HTTP/1.1 connection.

## Planned N=32 and N=64 run, cost model

30 turns, 100k start, +2k per turn, ~1k output per turn. Per session: turn 0 writes ~102k tokens (0.26 USD), turns 1 to 29 write ~3.06k each (new chunk + previous reply, 0.22 USD), reads total ~4.2M tokens (0.42 USD), output 30k tokens (0.30 USD): about 1.20 USD per session, so 38 USD for N=32 and 77 USD for N=64. Expected cache rate 0.956, mean context 146k, final prompt ~191k at exactly 1k output per turn. The margin to the 200k limit is ~9k tokens, i.e. 29 replies averaging 1.3k instead of 1k would overflow the last turns; `--start-tok 95000` or `--turns 28` buys margin.
