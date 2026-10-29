# Agents

This repository is a sourced table of LLM inference measurements. CSV is the source of truth. `datapackage.json` is the machine-readable contract.

## Tables

- `data/sources.csv` — public URL, author, publisher, `date_published`, `date_accessed`, `source_type` (`benchmark`, `vendor`, `video`, `post`).
- `data/hardware.csv` — `memory_gb`, `bandwidth_gb_s`, `dense_bf16_fp16_tflops`, `fp4_tflops`, `tdp_w`, `launch_price_usd`, `market_price_usd`, `market_price_date`.
- `data/models.csv` — `params_total_b`, `params_active_b` (billions), `architecture`, `license`.
- `data/measurements.csv` — one result: `hardware_id`, `hw_count`, `model_id`, `quantization`, `engine`, `engine_version`, `context_tokens`, `input_tokens`, `output_tokens`, `concurrency`, `prefill_tok_s`, `decode_tok_s`, `decode_tok_s_per_user`, `ttft_ms`, `power_w`, `task_time_s`, `source_id`, `evidence`, `notes`.

Ids are stable lowercase slugs (`a-z`, `0-9`, `.`, `-`). Empty cell means unknown. Do not write `NA`, `0`, or a midpoint for a range.

## Evidence

- `measured_by_source` — the cited page measured it, or a chart printed the label.
- `vendor_claim` — the vendor published it.
- `unverified_claim` — public, but the device or the page was not established. Say why in `notes`.
- `derived` — formula applied to a spec, for example `bandwidth_gb_s / 70` for a 70 GB weight read. The note must contain `Derived` and the formula. Never label that row `measured_by_source`.

Store `decode_tok_s_per_user` only when the source printed a per-request rate. Do not divide aggregate by concurrency and call it measured.

## Add a row

1. Cite a public `https` URL. No private notes, local paths, or unpublished prices.
2. Reuse hardware and model ids. Create one only if the name is new.
3. One measurement row per result. Explain every blank you considered filling.
4. `python scripts/validate.py` must pass. It checks types, unique ids, foreign keys, and that every measurement's source has a URL and `date_accessed`.
5. Regenerate JSON with `python scripts/export_json.py` if you change a CSV.

Load from Python with `inference_data.load()` or `pandas.read_csv` on `data/measurements.csv`. The raw URL after merge is `https://raw.githubusercontent.com/knoel99/inference-data/main/data/measurements.csv`.
