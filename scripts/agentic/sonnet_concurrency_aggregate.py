import csv, statistics as st, sys, datetime as dt
from zoneinfo import ZoneInfo
srcs = sys.argv[1:-1]; outdir = sys.argv[-1]
rows = []
for s in srcs: rows += list(csv.DictReader(open(s)))
MODEL = "claude-sonnet-5-5"
FX = 1.1130
def q(v, p):
    v = sorted(v); k = (len(v)-1)*p; f = int(k); c = min(f+1, len(v)-1)
    return v[f] + (v[c]-v[f])*(k-f)
calls = []
for r in rows:
    o = {"model": MODEL}
    for k, v in r.items():
        if k.startswith("t_"): o[k+"_unix"] = v
        else: o[k] = v
    calls.append(o)
fields = list(calls[0].keys())
with open(f"{outdir}/sonnet_concurrency_calls.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n"); w.writeheader(); w.writerows(calls)
agg = []
for n in sorted({int(r["tier"]) for r in rows}):
    tr = [r for r in rows if int(r["tier"]) == n]
    ok = [r for r in tr if r["http_status"] == "200" and not r["error"]]
    t0 = min(float(r["t_send"]) for r in tr); t1 = max(float(r["t_done"]) for r in ok)
    win = t1 - t0
    S = lambda k: sum(int(r[k]) for r in ok)
    tps = [float(r["inst_gen_tps"]) for r in ok]; ttft = [float(r["ttft_ms"]) for r in ok]
    sess = {r["session_id"] for r in ok if r["turn"] == "9"}
    cost = sum(float(r["cost_usd"] or 0) for r in tr)
    paris = lambda t: dt.datetime.fromtimestamp(t, ZoneInfo("Europe/Paris")).isoformat(timespec="seconds")
    agg.append(dict(model=MODEL, provider="anthropic-api", sessions=n,
        gen_per_session_tps=round(S("output_tokens")/win/n, 2),
        new_prefill_per_session_tps=round(S("new_prefill_tokens")/win/n, 1),
        ingest_per_session_tps=int(round(S("prompt_tokens")/win/n)),
        inst_gen_median_tps=round(st.median(tps), 1), inst_gen_p90_tps=round(q(tps, 0.10), 1),
        cache_rate=round(S("cache_read_tokens")/S("prompt_tokens"), 3),
        avg_context_k=round(S("prompt_tokens")/len(ok)/1000, 1),
        ttft_median_ms=round(st.median(ttft)), ttft_p90_ms=round(q(ttft, 0.90)),
        requests_ok=len(ok), requests_attempted=len(tr),
        http_429=sum(r["http_status"] == "429" for r in tr),
        http_other_errors=sum(r["http_status"] not in ("200", "429") for r in tr),
        sessions_completed=len(sess), output_tokens=S("output_tokens"), thinking_tokens=S("thinking_tokens"),
        window_s=round(win, 1), cost_usd=round(cost, 4), cost_eur=round(cost/FX, 4),
        start_paris=paris(t0), end_paris=paris(t1), run_date=paris(t0)[:10], saturated=False))
with open(f"{outdir}/sonnet_concurrency_tiers.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(agg[0].keys()), lineterminator="\n"); w.writeheader(); w.writerows(agg)
for a in agg: print(a)
