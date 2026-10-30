"""Sonnet 5.5 agentic concurrency sweep. Billed. Hard cap enforced with per-call worst-case reservations.
usage: python sweep.py --tiers 1 [--cap-usd 27.8] [--out calls.csv]
"""
import asyncio, json, os, random, time, csv, argparse, uuid, statistics, sys
import httpx
_t = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "mobydick.txt")).read()
_i = _t.find("CHAPTER 1. Loomings"); _i = _t.find("CHAPTER 1. Loomings", _i + 10)
BOOK = _t[_i:].split()   # Project Gutenberg #2701, public domain
MODEL = "claude-sonnet-5-5"
URL = "https://api.anthropic.com/v1/messages"
P_IN, P_CW, P_CR, P_OUT = 2.0, 2.5, 0.10, 10.0   # USD/MTok, 5m cache write
TPW = 1.928  # tokens per word for this text, measured with count_tokens
START_TOK, TURN_TOK, TURNS, MAX_TOKENS = 60_000, 8_000, 10, 16_000
TOPICS = ["a harbor town in winter", "the history of the public library", "a mountain railway", "morning markets",
          "how rivers shape cities", "the life of a museum guard", "letters that were never sent", "a night shift at a data center",
          "village festivals", "the sound of engines", "gardens on rooftops", "a lighthouse keeper's notebook"]
HDR = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
FIELDS = ["tier", "session_id", "turn", "attempt", "http_status", "request_id", "t_send", "t_first_event", "t_first_text", "t_last_delta", "t_done",
          "ttft_ms", "ttft_text_ms", "decode_window_ms", "inst_gen_tps", "input_tokens", "cache_creation_tokens", "cache_read_tokens",
          "output_tokens", "thinking_tokens", "prompt_tokens", "new_prefill_tokens", "text_chars", "thinking_chars", "stop_reason", "cost_usd", "itpm_remaining", "otpm_remaining", "error"]

def cost(u):
    return (u.get("input_tokens", 0) * P_IN + u.get("cache_creation_input_tokens", 0) * P_CW
            + u.get("cache_read_input_tokens", 0) * P_CR + u.get("output_tokens", 0) * P_OUT) / 1e6

class Budget:
    def __init__(s, cap): s.cap, s.spent, s.reserved, s.lock = cap, 0.0, 0.0, asyncio.Lock()
    async def reserve(s, amt):
        async with s.lock:
            if s.spent + s.reserved + amt > s.cap: return False
            s.reserved += amt; return True
    async def settle(s, amt_reserved, actual):
        async with s.lock: s.reserved -= amt_reserved; s.spent += actual

START_W, TURN_W = int(START_TOK / TPW), int(TURN_TOK / TPW)
def task_text(seed, turn):
    topic = TOPICS[(seed * 7 + turn) % len(TOPICS)]
    a = START_W + turn * TURN_W
    return (f"Next excerpt (part {turn + 2}):\n\n" + " ".join(BOOK[a:a + TURN_W]) +
            f"\n\nTask: write an original essay of about 500 words on {topic}, in plain prose without lists or headings. "
            "You may echo the style of the excerpts.")

async def call(client, body, row, budget, reserve_usd, stop):
    """one streamed request, retries on 429/529/overloaded. returns (assistant_content, usage) or None"""
    delays = [2, 4, 8, 16, 32, 60]
    rows = []
    for attempt in range(len(delays) + 1):
        r = dict(row, attempt=attempt)
        if not await budget.reserve(reserve_usd):
            r["error"] = "budget_cap"; return None, rows + [r]
        t_send = time.time(); r["t_send"] = t_send
        blocks, usage, cur, first_ev, first_txt, last = [], {}, None, None, None, None
        try:
            async with client.stream("POST", URL, headers=HDR, json=body, timeout=httpx.Timeout(600, connect=30)) as resp:
                r["http_status"] = resp.status_code; r["request_id"] = resp.headers.get("request-id", "")
                r["itpm_remaining"] = resp.headers.get("anthropic-ratelimit-input-tokens-remaining", "")
                r["otpm_remaining"] = resp.headers.get("anthropic-ratelimit-output-tokens-remaining", "")
                if resp.status_code != 200:
                    txt = (await resp.aread()).decode()[:300]; r["error"] = txt.replace("\n", " ")
                    await budget.settle(reserve_usd, 0.0)
                    if resp.status_code in (429, 529, 500, 502, 503) and attempt < len(delays):
                        ra = resp.headers.get("retry-after"); rows.append(r)
                        await asyncio.sleep(float(ra) if ra else delays[attempt]); continue
                    return None, rows + [r]
                ev = None
                async for line in resp.aiter_lines():
                    if line.startswith("event:"): ev = line[6:].strip(); continue
                    if not line.startswith("data:"): continue
                    d = json.loads(line[5:]); typ = d.get("type")
                    now = time.time()
                    if typ == "message_start":
                        usage.update(d["message"].get("usage", {}))
                    elif typ == "content_block_start":
                        cur = dict(d["content_block"]); blocks.append(cur)
                    elif typ == "content_block_delta":
                        dl = d["delta"]; first_ev = first_ev or now; last = now
                        if dl["type"] == "text_delta": first_txt = first_txt or now; cur["text"] = cur.get("text", "") + dl["text"]
                        elif dl["type"] == "thinking_delta": cur["thinking"] = cur.get("thinking", "") + dl["thinking"]
                        elif dl["type"] == "signature_delta": cur["signature"] = cur.get("signature", "") + dl["signature"]
                    elif typ == "message_delta":
                        usage.update({k: v for k, v in d.get("usage", {}).items() if v is not None}); r["stop_reason"] = d["delta"].get("stop_reason")
                    elif typ == "error":
                        r["error"] = json.dumps(d)[:300]
        except Exception as e:
            r["error"] = f"{type(e).__name__}: {e}"[:300]
        t_done = time.time(); c = cost(usage) if usage.get("output_tokens") is not None else 0.0
        await budget.settle(reserve_usd, c)
        pr = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
        r.update(t_first_event=first_ev or "", t_first_text=first_txt or "", t_last_delta=last or "", t_done=t_done,
                 ttft_ms=round((first_ev - t_send) * 1000, 1) if first_ev else "", ttft_text_ms=round((first_txt - t_send) * 1000, 1) if first_txt else "",
                 decode_window_ms=round((last - first_ev) * 1000, 1) if first_ev else "",
                 inst_gen_tps=round(usage.get("output_tokens", 0) / (last - first_ev), 2) if first_ev and last > first_ev else "",
                 input_tokens=usage.get("input_tokens", ""), cache_creation_tokens=usage.get("cache_creation_input_tokens", ""),
                 cache_read_tokens=usage.get("cache_read_input_tokens", ""), output_tokens=usage.get("output_tokens", ""), thinking_tokens=(usage.get("output_tokens_details") or {}).get("thinking_tokens", ""),
                 prompt_tokens=pr, new_prefill_tokens=usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0),
                 text_chars=sum(len(b.get("text", "")) for b in blocks), thinking_chars=sum(len(b.get("thinking", "")) for b in blocks),
                 cost_usd=round(c, 6))
        if r.get("stop_reason") == "refusal" or not usage.get("output_tokens"):
            r["error"] = r.get("error") or f"bad_response stop_reason={r.get('stop_reason')} output_tokens={usage.get('output_tokens')}"
        if r.get("error") or r.get("http_status") != 200:
            transient = r.get("stop_reason") != "refusal" and any(k in str(r.get("error")) for k in ("RemoteProtocolError", "ReadError", "ReadTimeout", "ConnectError", "overloaded_error", "api_error"))
            if transient and attempt < len(delays):
                r["error"] = "retried: " + str(r["error"]); rows.append(r)
                await asyncio.sleep(delays[attempt]); continue
            return None, rows + [r]
        content = [{k: v for k, v in b.items() if k in ("type", "text", "thinking", "signature", "data")} for b in blocks]
        for b in content:
            if b["type"] == "text": b.setdefault("text", "")
            if b["type"] == "thinking": b.setdefault("thinking", ""); b.setdefault("signature", "")
        return (content, usage), rows + [r]
    return None, []


async def session(client, tier, idx, budget, stop, writer, log):
    sid = f"N{tier}-s{idx}-{uuid.uuid4().hex[:8]}"; seed = tier * 100 + idx
    await asyncio.sleep(random.uniform(0, 2))
    start = (f"[session {sid}]\nBelow are excerpts from a public-domain novel (Herman Melville, Moby-Dick, 1851).\n\n"
             "Excerpt (part 1):\n\n" + " ".join(BOOK[:START_W]))
    msgs = [{"role": "user", "content": [{"type": "text", "text": start}]}]
    prev_prompt, prev_out = 0, 0
    for turn in range(TURNS_RUN):
        if stop.is_set(): log(f"{sid} stop before turn {turn}"); return
        # drop older breakpoints, put one on the newest user block
        for m in msgs:
            if m["role"] == "user":
                for b in m["content"]: b.pop("cache_control", None)
        newblk = {"type": "text", "text": task_text(seed, turn), "cache_control": {"type": "ephemeral"}}
        if turn == 0: msgs[0]["content"].append(newblk)
        else: msgs.append({"role": "user", "content": [newblk]})
        new_est = (START_TOK if turn == 0 else 0) + TURN_TOK + prev_out + 500
        reserve = (new_est * P_CW + prev_prompt * P_CR + MAX_TOKENS * P_OUT) / 1e6 * 1.1
        body = {"model": MODEL, "max_tokens": MAX_TOKENS, "stream": True, "thinking": {"type": "adaptive"}, "messages": msgs}
        res, rows = await call(client, body, {"tier": tier, "session_id": sid, "turn": turn}, budget, reserve, stop)
        for r in rows: writer.writerow({k: r.get(k, "") for k in FIELDS})
        if res is None:
            last = rows[-1] if rows else {}
            log(f"{sid} turn {turn} FAILED status={last.get('http_status')} err={str(last.get('error'))[:160]} -> stopping tier")
            stop.set(); return
        content, usage = res
        msgs.append({"role": "assistant", "content": content})
        prev_prompt = rows[-1]["prompt_tokens"]; prev_out = usage.get("output_tokens", 0)
        log(f"{sid} t{turn} prompt={prev_prompt} cw={usage.get('cache_creation_input_tokens')} cr={usage.get('cache_read_input_tokens')} "
            f"out={prev_out} think={rows[-1]['thinking_tokens']} ttft={rows[-1]['ttft_ms']}ms tps={rows[-1]['inst_gen_tps']} spent={budget.spent:.3f}")

async def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--tiers", default="1"); ap.add_argument("--cap-usd", type=float, default=27.8)
    ap.add_argument("--spent-before", type=float, default=0.0); ap.add_argument("--out", default="calls.csv"); ap.add_argument("--turns", type=int, default=TURNS)
    ap.add_argument("--per-session-usd", type=float, default=0.0, help="projection; skip tier if spent+N*this*1.15 > cap")
    a = ap.parse_args()
    global TURNS_RUN; TURNS_RUN = a.turns
    budget = Budget(a.cap_usd); budget.spent = a.spent_before
    new = not os.path.exists(a.out)
    f = open(a.out, "a", newline=""); w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
    if new: w.writeheader()
    def log(m): print(time.strftime("%H:%M:%S"), m, flush=True); f.flush()
    async with httpx.AsyncClient(http2=False, limits=httpx.Limits(max_connections=64)) as client:
        for n in [int(x) for x in a.tiers.split(",")]:
            if a.per_session_usd and budget.spent + n * a.per_session_usd * 1.15 > budget.cap:
                log(f"SKIP tier N={n}: projected {budget.spent + n * a.per_session_usd * 1.15:.2f} > cap {budget.cap}"); continue
            stop = asyncio.Event(); t0 = time.time(); log(f"=== tier N={n} start (spent {budget.spent:.3f})")
            await asyncio.gather(*[session(client, n, i, budget, stop, w, log) for i in range(n)])
            f.flush(); log(f"=== tier N={n} done in {time.time()-t0:.0f}s, spent {budget.spent:.3f} USD, stopped={stop.is_set()}")
    log(f"TOTAL spent {budget.spent:.4f} USD")
asyncio.run(main())
