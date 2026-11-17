"""Aggregate runner output into the published tables.

usage: python sonnet_concurrency_aggregate.py RUN.csv [RUN2.csv ...] OUTDIR
Inputs are runner CSVs (t_send, ...) or an already published calls CSV (model, t_send_unix, ...); columns an older run did not record
stay blank. Writes OUTDIR/sonnet_concurrency_calls.csv and OUTDIR/sonnet_concurrency_tiers.csv with the InferenceX formulas:
gen/session = output tokens / tier window / N, new prefill/session = (uncached input + cache-write tokens) / window / N,
ingest/session = all prompt tokens / window / N, window = first request sent to last response finished.
"""
import csv, statistics as st, sys, datetime as dt
from zoneinfo import ZoneInfo
from sonnet_concurrency_sweep import FIELDS

MODEL = "claude-sonnet-5-5"
FX = 1.1130
TIERS_FIELDS = ["model", "provider", "sessions", "turns", "gen_per_session_tps", "new_prefill_per_session_tps", "ingest_per_session_tps",
                "gen_per_session_span_tps", "inflight_mean", "inst_gen_median_tps", "inst_gen_p90_tps", "inst_gen_text_median_tps",
                "inst_gen_text_p90_tps", "cache_rate", "avg_context_k", "ttft_median_ms", "ttft_p90_ms", "ttft_turn0_median_ms",
                "requests_ok", "requests_attempted", "http_429", "http_529", "http_other_errors", "sessions_completed", "output_tokens",
                "thinking_tokens", "window_s", "cost_usd", "cost_eur", "start_paris", "end_paris", "run_date", "saturated"]

def q(v, p):
    v = sorted(v); k = (len(v) - 1) * p; f = int(k); c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)

def read(paths):
    rows = []
    for p in paths:
        for r in csv.DictReader(open(p, newline="")):
            o = {(k[:-5] if k.endswith("_unix") else k): v for k, v in r.items() if k != "model"}
            o = {k: o.get(k, "") for k in FIELDS}
            if o["inst_gen_text_tps"] == "" and o["t_first_text"] and o["t_last_delta"] and o["output_tokens"]:
                # Thinking is generated before the first text delta, so the visible-text rate is text tokens over the text window.
                win = float(o["t_last_delta"]) - float(o["t_first_text"])
                if win > 0: o["inst_gen_text_tps"] = round((int(o["output_tokens"]) - int(o["thinking_tokens"] or 0)) / win, 2)
            rows.append(o)
    return rows

def tier_row(n, tr):
    ok = [r for r in tr if r["http_status"] == "200" and not r["error"]]
    t0 = min(float(r["t_send"]) for r in tr if r["t_send"]); t1 = max(float(r["t_done"]) for r in ok); win = t1 - t0
    S = lambda k: sum(int(r[k] or 0) for r in ok)
    tps = [float(r["inst_gen_tps"]) for r in ok]; ttft = [float(r["ttft_ms"]) for r in ok]
    text_tps = [float(r["inst_gen_text_tps"]) for r in ok if r["inst_gen_text_tps"]]
    ttft0 = [float(r["ttft_ms"]) for r in ok if r["turn"] == "0"]
    turns = max(int(r["turn"]) for r in tr) + 1
    by = {}
    for r in ok: by.setdefault(r["session_id"], []).append(r)
    # Each session over its own span: immune to the ragged tier end, which lowers the window formula as N grows.
    span_tps = [sum(int(x["output_tokens"]) for x in v) / (max(float(x["t_done"]) for x in v) - min(float(x["t_send"]) for x in v)) for v in by.values()]
    # Time-weighted mean number of requests in flight over the window; equals N only if every session is busy the whole time.
    ev = sorted([(float(r["t_send"]), 1) for r in tr if r["t_send"] and r["t_done"]] + [(float(r["t_done"]), -1) for r in tr if r["t_send"] and r["t_done"]])
    area, cur, last = 0.0, 0, ev[0][0]
    for t, d in ev: area += cur * (t - last); last = t; cur += d
    cost = sum(float(r["cost_usd"] or 0) for r in tr)
    paris = lambda t: dt.datetime.fromtimestamp(t, ZoneInfo("Europe/Paris")).isoformat(timespec="seconds")
    return dict(model=MODEL, provider="anthropic-api", sessions=n, turns=turns,
        gen_per_session_tps=round(S("output_tokens") / win / n, 2),
        new_prefill_per_session_tps=round(S("new_prefill_tokens") / win / n, 1),
        ingest_per_session_tps=int(round(S("prompt_tokens") / win / n)),
        gen_per_session_span_tps=round(st.mean(span_tps), 2), inflight_mean=round(area / win, 2),
        inst_gen_median_tps=round(st.median(tps), 1), inst_gen_p90_tps=round(q(tps, 0.10), 1),
        inst_gen_text_median_tps=round(st.median(text_tps), 1) if text_tps else "",
        inst_gen_text_p90_tps=round(q(text_tps, 0.10), 1) if text_tps else "",
        cache_rate=round(S("cache_read_tokens") / S("prompt_tokens"), 3),
        avg_context_k=round(S("prompt_tokens") / len(ok) / 1000, 1),
        ttft_median_ms=round(st.median(ttft)), ttft_p90_ms=round(q(ttft, 0.90)), ttft_turn0_median_ms=round(st.median(ttft0)) if ttft0 else "",
        requests_ok=len(ok), requests_attempted=len(tr),
        http_429=sum(r["http_status"] == "429" for r in tr), http_529=sum(r["http_status"] == "529" for r in tr),
        http_other_errors=sum(r["http_status"] not in ("200", "429", "529") for r in tr),
        sessions_completed=len({r["session_id"] for r in ok if int(r["turn"]) == turns - 1}),
        output_tokens=S("output_tokens"), thinking_tokens=S("thinking_tokens"),
        window_s=round(win, 1), cost_usd=round(cost, 4), cost_eur=round(cost / FX, 4),
        start_paris=paris(t0), end_paris=paris(t1), run_date=paris(t0)[:10], saturated=False)

def main():
    srcs, outdir = sys.argv[1:-1], sys.argv[-1]
    rows = read(srcs)
    calls = [{"model": MODEL, **{(k + "_unix" if k.startswith("t_") else k): r[k] for k in FIELDS}} for r in rows]
    with open(f"{outdir}/sonnet_concurrency_calls.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(calls[0].keys()), lineterminator="\n"); w.writeheader(); w.writerows(calls)
    agg = [tier_row(n, [r for r in rows if int(r["tier"]) == n]) for n in sorted({int(r["tier"]) for r in rows})]
    with open(f"{outdir}/sonnet_concurrency_tiers.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=TIERS_FIELDS, lineterminator="\n"); w.writeheader(); w.writerows(agg)
    for a in agg: print(a)

if __name__ == "__main__":
    main()
