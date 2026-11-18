"""Section 5.7 summaries from a joined requests.csv.

L0, alpha, and beta are the tau=0.10 fit of

    TTFT = L0 + alpha * new_tokens + beta * cache_read_tokens + block effects

The intercept is the reference block's 0.10 quantile, which still contains
whatever wait sits below that quantile. It is not a measurement of an empty
queue. sigma and the coefficient standard errors are computed from the pilot
residuals and from the bootstrap. The protocol's 200 ms sigma, 1.2 µs SE,
and beta ≈ alpha/100 are recorded only so a reader can see they were not used.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

from hosted_agentperf.csvutil import as_float, read_csv
from hosted_agentperf.join import regression_rows
from hosted_agentperf.regression import (
    bootstrap_quantile,
    design_matrix,
    fit_ols,
    fit_quantile,
    formula_se,
    quantile_sorted,
    residual_sigma,
    sd,
)
from hosted_agentperf.schema import FAILURE_CLASSES, FAILURE_RATE_CLASSES

# Placeholders from protocol section 5.7. Not used as estimates.
PLACEHOLDER = {
    "sigma_ms": 200.0,
    "n_new": 72,
    "sd_new_tokens": 20000.0,
    "se_alpha_ms_per_token": 0.0012,
    "beta_over_alpha": 0.01,
    "note": "Protocol section 5.7 placeholders. The estimates below replace them.",
}


def analyze(rows: list[dict], n_boot: int = 2000, seed: int = 0, tau: float = 0.10) -> dict:
    sample = regression_rows(rows)
    report: dict = {
        "tau": tau,
        "n_rows": len(rows),
        "n_regression": len(sample),
        "placeholder_not_used": PLACEHOLDER,
        "failures": _failures(rows),
        "cache_ratio_by_turn": _cache_by_turn(rows),
        "decode": _decode(rows),
        "aa_comparison": _aa_comparison(rows),
    }
    if len(sample) < 4:
        report["quantile_regression"] = {"error": "fewer than 4 regression rows"}
        return report
    design, response, names = design_matrix(sample)
    beta = fit_quantile(design, response, tau=tau)
    if beta is None:
        report["quantile_regression"] = {"error": "quantile fit failed"}
        return report
    coef = dict(zip(names, beta))
    sigma = residual_sigma(design, response, beta)
    new_values = [row["new_tokens"] for row in sample]
    cached_values = [row["cache_read_tokens"] for row in sample]
    se_alpha = formula_se(sigma, len(sample), sd(new_values))
    se_beta = formula_se(sigma, len(sample), sd(cached_values))
    intervals = bootstrap_quantile(sample, names, n_boot=n_boot, tau=tau, seed=seed)
    alpha = coef.get("alpha")
    beta_coef = coef.get("beta")
    ratio = None
    if alpha not in (None, 0) and beta_coef is not None:
        ratio = beta_coef / alpha
    report["quantile_regression"] = {
        "coefficients_ms": coef,
        "sigma_residual_sd_ms": sigma,
        "se_formula_ms": {"alpha": se_alpha, "beta": se_beta},
        "bootstrap_95": intervals,
        "n_bootstrap": n_boot,
        "prefill_tok_s_from_alpha": (1000.0 / alpha) if alpha and alpha > 0 else None,
        "cache_read_tok_s_from_beta": (1000.0 / beta_coef) if beta_coef and beta_coef > 0 else None,
        "beta_over_alpha_estimated": ratio,
        "reference_block": sorted({row["block"] for row in sample})[0],
    }
    report["cell_minima_ols"] = _cell_minima(sample)
    report["linearity"] = _extra_fit(sample, "new_sq", tau)
    report["c0_vs_c1"] = _extra_fit(sample, "c1_interaction", tau)
    return report


def analyze_csv(path: Path, n_boot: int = 2000, seed: int = 0) -> dict:
    return analyze(read_csv(Path(path)), n_boot=n_boot, seed=seed)


def write_report(report: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _failures(rows: list[dict]) -> dict:
    counts = {code: 0 for code in FAILURE_CLASSES}
    counts["none"] = 0
    for row in rows:
        code = str(row.get("failure_class") or "")
        if code in counts:
            counts[code] += 1
        elif code == "":
            counts["none"] += 1
        else:
            counts[code] = counts.get(code, 0) + 1
    rate_denom = len(rows)
    rate_num = sum(counts[code] for code in FAILURE_RATE_CLASSES)
    return {
        "counts": counts,
        "failure_rate_e1_to_e4": (rate_num / rate_denom) if rate_denom else None,
        "e5_and_e6_excluded_from_rate": True,
        "definitions": {
            "E1": "Provider error on this attempt (429 that is not a quota refusal, 500, 529).",
            "E2": "Retries exhausted, or a run that ended in error.",
            "E3": "Stream closed without message_stop, or a watchdog timeout.",
            "E4": "max_tokens outside the intentional cap cells (D* and max_output).",
            "E5": "Quota or usage-limit refusal. Counted apart from the failure rate.",
            "E6": "Harness defect: served model differs from the pin, fast mode, or a non-main-thread query source.",
        },
    }


def _cache_by_turn(rows: list[dict]) -> list[dict]:
    """Per-request cache ratios in turn order. No smoothing."""
    series = []
    for row in rows:
        if _off(row) == "1":
            continue
        ratio = as_float(row.get("cache_ratio"))
        series.append(
            {
                "cell": row.get("cell") or "",
                "session_id": row.get("session_id") or "",
                "turn_index": row.get("turn_index") or "",
                "request_id": row.get("request_id") or "",
                "cache_ratio": ratio,
            }
        )
    return series


def _decode(rows: list[dict]) -> dict:
    by_cell: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if str(row.get("failure_class") or ""):
            continue
        if _off(row) == "1":
            continue
        cell = str(row.get("cell") or "")
        total = as_float(row.get("decode_tps"))
        text = _text_window_tps(row)
        if total is None and text is None:
            continue
        by_cell[cell].append({"total": total, "text": text})
    summary = {}
    for cell, items in sorted(by_cell.items()):
        summary[cell] = {
            "total_window": _spread([item["total"] for item in items]),
            "text_window": _spread([item["text"] for item in items]),
            "text_window_note": (
                "Numerator is still output_tokens - 1. The usage block does not "
                "split thinking tokens from text tokens, so the text-window rate "
                "uses the full output count over the shorter text window."
            ),
        }
    return summary


def _off(row: dict) -> str:
    value = row.get("off_thread")
    if value is None or value == "":
        return ""
    return str(value).strip()


def _text_window_tps(row: dict) -> float | None:
    output_tokens = as_float(row.get("output_tokens"))
    first_text = as_float(row.get("t_first_text"))
    last = as_float(row.get("t_last_delta"))
    if output_tokens is None or first_text is None or last is None:
        return None
    window = last - first_text
    if window <= 0 or output_tokens < 2:
        return None
    return 1000.0 * (output_tokens - 1) / window


def _spread(values: list[float | None]) -> dict:
    clean = [value for value in values if value is not None and not math.isnan(value)]
    if not clean:
        return {"n": 0, "p10": None, "median": None, "p90": None}
    return {
        "n": len(clean),
        "p10": quantile_sorted(clean, 0.10),
        "median": quantile_sorted(clean, 0.50),
        "p90": quantile_sorted(clean, 0.90),
    }


def _cell_minima(sample: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in sample:
        grouped[row["cell"]].append(row)
    minima = [min(group, key=lambda row: row["ttft_ms"]) for group in grouped.values()]
    if len(minima) < 4:
        return {"error": "fewer than 4 cells"}
    design, response, names = design_matrix(minima)
    beta = fit_ols(design, response)
    if beta is None:
        return {"error": "ols failed"}
    return {"n_cells": len(minima), "coefficients_ms": dict(zip(names, beta))}


def _extra_fit(sample: list[dict], extra: str, tau: float) -> dict:
    design, response, names = design_matrix(sample, extra=extra)
    beta = fit_quantile(design, response, tau=tau)
    if beta is None:
        return {"error": "fit failed", "term": extra}
    return {"term": extra, "coefficients_ms": dict(zip(names, beta))}


def _aa_comparison(rows: list[dict]) -> dict:
    """Put our summaries next to the two speeds AA publishes per result.

    AA's leaderboard field ``prefillTokensPerSecond`` is new prompt tokens
    divided by the sum of time-to-first-token. That denominator includes
    queueing and cache reads. ``outputTokensPerSecond`` is the pooled decode
    speed (their tooltip: total generated tokens over total generation time,
    longer turns weigh more). The local reporter's per-turn formula subtracts
    one token because the first-to-last window spans one interval fewer than
    the tokens. Our ``decode_tps`` matches that per-turn formula. ``1/alpha``
    is not AA's prefill ratio.
    """
    new_tokens = 0.0
    ttft_s = 0.0
    decode_tokens = 0.0
    decode_s = 0.0
    n_prefill = 0
    n_decode = 0
    for row in rows:
        if str(row.get("failure_class") or ""):
            continue
        if _off(row) == "1":
            continue
        new = as_float(row.get("new_tokens"))
        ttft = as_float(row.get("ttft_ms"))
        if new is not None and ttft is not None and ttft > 0:
            new_tokens += new
            ttft_s += ttft / 1000.0
            n_prefill += 1
        output_tokens = as_float(row.get("output_tokens"))
        window = as_float(row.get("decode_window_ms"))
        if output_tokens is not None and window is not None and window > 0 and output_tokens >= 2:
            decode_tokens += output_tokens - 1
            decode_s += window / 1000.0
            n_decode += 1
    return {
        "aa_style_prefill_tok_s": (new_tokens / ttft_s) if ttft_s > 0 else None,
        "aa_style_prefill_n": n_prefill,
        "pooled_decode_tok_s": (decode_tokens / decode_s) if decode_s > 0 else None,
        "pooled_decode_n": n_decode,
        "how_they_differ": {
            "prefillTokensPerSecond": (
                "AA divides tokens added since the previous prompt by the sum of "
                "TTFT. Our prefill service rate is 1000/alpha from the tau=0.10 "
                "regression, which separates new tokens from cache reads and puts "
                "positive wait into the upper residual rather than into alpha."
            ),
            "outputTokensPerSecond": (
                "AA pools generated tokens over generation time across the run, "
                "so longer turns weigh more, and the public tooltip counts "
                "reasoning tokens. Our decode_tps is per request, (output_tokens-1) "
                "/ first-to-last window, summarized as median, p10, and p90. "
                "pooled_decode_tok_s uses the same minus-one numerator as "
                "agentperf-local's per-turn decoder and is the closest single "
                "number to AA's outputTokensPerSecond."
            ),
        },
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Quantile analysis of requests.csv")
    parser.add_argument("csv")
    parser.add_argument("--out", default="")
    parser.add_argument("--bootstrap", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    report = analyze_csv(Path(args.csv), n_boot=args.bootstrap, seed=args.seed)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
