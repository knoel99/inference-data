"""Sonnet 5.5 agentic concurrency sweep. Billed. Hard cap enforced with per-call worst-case reservations.

usage: python sonnet_concurrency_sweep.py --tiers 1,2,4 [--turns 10] [--start-tok 60000] [--turn-tok 8000] [--workload essay|agentic]
         [--max-tokens 16000] [--cap-usd 27.8] [--spent-before 0] [--out calls.csv] [--stagger 2] [--max-failed-frac 0.25]
       python sonnet_concurrency_sweep.py --dry-run --workload agentic --tiers 2 --turns 3   # builds every request offline: no key, no network
       python sonnet_concurrency_sweep.py --calibrate --workload agentic                     # count_tokens (free endpoint): chars per token

Corpora. essay: mobydick.txt next to this file (Project Gutenberg #2701, https://www.gutenberg.org/ebooks/2701.txt.utf-8), one ~500-word
essay per turn. agentic: the local Python standard library (PSF licence) served as a fake repository through next_file / write_file /
run_tests tools, one file per turn, so the output is code inside tool_use JSON and every turn after the first is a tool_result, like a
coding agent's. Both workloads add the same number of new tokens per turn, so they cost the same for a given --start-tok / --turn-tok.
"""
import asyncio, json, os, random, time, csv, argparse, uuid, sys, resource, sysconfig, contextlib

MODEL = "claude-sonnet-5-5"
URL = "https://api.anthropic.com/v1/messages"
P_IN, P_CW, P_CR, P_OUT = 2.0, 2.5, 0.10, 10.0   # USD/MTok, 5m cache write
TPW = 1.928         # tokens per whitespace-separated word of Moby-Dick, measured with count_tokens
CACHE_TTL_S = 300   # ephemeral cache TTL; a session idle for longer re-writes its whole prefix at P_CW
HERE = os.path.dirname(os.path.abspath(__file__))
TOPICS = ["a harbor town in winter", "the history of the public library", "a mountain railway", "morning markets",
          "how rivers shape cities", "the life of a museum guard", "letters that were never sent", "a night shift at a data center",
          "village festivals", "the sound of engines", "gardens on rooftops", "a lighthouse keeper's notebook"]
FIELDS = ["tier", "session_id", "turn", "attempt", "http_status", "request_id",
          "t_send", "t_headers", "t_message_start", "t_first_block", "t_first_event", "t_first_text", "t_last_delta", "t_done",
          "ttfb_ms", "ttft_block_ms", "ttft_ms", "ttft_text_ms", "decode_window_ms", "inst_gen_tps", "inst_gen_text_tps",
          "input_tokens", "cache_creation_tokens", "cache_read_tokens", "output_tokens", "thinking_tokens", "prompt_tokens", "new_prefill_tokens",
          "text_chars", "thinking_chars", "block_types", "stop_reason", "cost_usd",
          "rpm_remaining", "itpm_limit", "itpm_remaining", "itpm_reset", "otpm_limit", "otpm_remaining", "otpm_reset", "retry_after", "error"]
RL = {"rpm_remaining": "anthropic-ratelimit-requests-remaining", "itpm_limit": "anthropic-ratelimit-input-tokens-limit",
      "itpm_remaining": "anthropic-ratelimit-input-tokens-remaining", "itpm_reset": "anthropic-ratelimit-input-tokens-reset",
      "otpm_limit": "anthropic-ratelimit-output-tokens-limit", "otpm_remaining": "anthropic-ratelimit-output-tokens-remaining",
      "otpm_reset": "anthropic-ratelimit-output-tokens-reset", "retry_after": "retry-after"}
KEEP = ("type", "text", "thinking", "signature", "data", "id", "name", "input")   # block keys sent back as history
HDR = TIMEOUT = A = WL = None   # set in main()

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

# ---------- corpora and workloads ----------

def load_book():
    p = A.book or os.path.join(HERE, "mobydick.txt")
    if not os.path.exists(p): sys.exit(f"missing {p}: save https://www.gutenberg.org/ebooks/2701.txt.utf-8 there (Project Gutenberg #2701)")
    t = open(p, encoding="utf-8").read(); i = t.find("CHAPTER 1. Loomings"); i = t.find("CHAPTER 1. Loomings", i + 10)
    return t[i:].split()

SKIP_DIRS = {"test", "tests", "site-packages", "__pycache__", "idlelib", "lib2to3", "turtledemo", "pydoc_data", "encodings", "tkinter", "ensurepip", "venv"}
def load_code():
    """The local Python standard library as one deterministic text: mid-sized .py files, sorted, each under a === path === header."""
    root = sysconfig.get_paths()["stdlib"]; parts = []
    for d, dirs, names in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("config-"))
        for n in sorted(names):
            p = os.path.join(d, n)
            if not n.endswith(".py") or not 2000 <= os.path.getsize(p) <= 60000: continue
            try: src = open(p, encoding="utf-8").read()
            except UnicodeDecodeError: continue
            parts.append(f"=== {os.path.relpath(p, root)} ===\n{src}\n")
    return "".join(parts)

class Essay:
    """The original workload: Moby-Dick excerpts, one ~500-word essay per turn."""
    name, fixed_tok, extra = "essay", 0, {}
    def __init__(s): s.W = load_book(); s.start_w, s.turn_w = int(A.start_tok / TPW), int(A.turn_tok / TPW)
    def task(s, seed, turn):
        topic = TOPICS[(seed * 7 + turn) % len(TOPICS)]; a = s.start_w + turn * s.turn_w
        return (f"Next excerpt (part {turn + 2}):\n\n" + " ".join(s.W[a:a + s.turn_w]) +
                f"\n\nTask: write an original essay of about 500 words on {topic}, in plain prose without lists or headings. "
                "You may echo the style of the excerpts.")
    def first(s, sid, seed):
        start = (f"[session {sid}]\nBelow are excerpts from a public-domain novel (Herman Melville, Moby-Dick, 1851).\n\n"
                 "Excerpt (part 1):\n\n" + " ".join(s.W[:s.start_w]))
        return [{"type": "text", "text": start}, {"type": "text", "text": s.task(seed, 0)}]
    def next_turn(s, seed, turn, prev): return [{"type": "text", "text": s.task(seed, turn)}]
    def est_tok(s, blocks): return sum(len(b.get("text", "").split()) for b in blocks) * TPW
    def fake_reply(s): return [{"type": "text", "text": "(essay)"}]
    def samples(s): return [("one turn of excerpt", " ".join(s.W[s.start_w:s.start_w + s.turn_w]))]

SYSTEM = """You are a coding agent reviewing a Python repository through three tools, driven by a harness rather than a person. The harness serves the repository one file per turn. Each turn: say in two or three sentences what you found in the last file, call write_file once with an improved version of one function or class you have read (keep the new source between 40 and 80 lines, complete and runnable), then call next_file to receive the next file in the queue. Never ask questions and never stop early; the harness ends the session.

Tools. next_file takes no arguments and returns the next file in review order; the queue is fixed, so asking for a path changes nothing. write_file(path, content) stores a whole file; use the path shown in the === header of the file you are improving and keep its imports and module docstring. run_tests(path) runs the suite and returns a summary line; call it at most once every three turns.

Repository conventions, apply them in every write_file:
- Python 3.12 or later. Type hints on every public function and method, PEP 604 unions, no typing.Optional, no bare except.
- Docstrings in the imperative mood: one summary line under 80 characters, a blank line, then details, PEP 257 layout.
- Names: snake_case for functions and variables, CapWords for classes, UPPER_CASE for module constants, a leading underscore for private helpers.
- Functions under 50 lines; extract helpers rather than nesting more than three levels; no mutable default arguments.
- Prefer early returns to deep else chains; prefer explicit loops to comprehensions longer than one line.
- Errors: raise the most specific built-in exception, chain with "from", include the offending value in the message.
- Logging through the module logger, never print; f-strings everywhere except in logging calls, which use % placeholders.
- Resources through context managers; no global state except constants; dataclasses for plain records, frozen with slots when immutable.
- Tests pytest-style with plain asserts, one behaviour per test, fixtures over setup methods, parametrize over loops.
- Do not change public signatures, module names or import paths; a review patch keeps the interface and improves the body.
- Comments explain the why, not the what; delete commented-out code; line length 100; ASCII source; four-space indents; LF endings.
Review priorities, in order: correctness bugs, resource leaks, unclear error handling, missing type hints, naming, docstrings, layout.

Example of one turn. Text: "The parser accepts a trailing comma but the docstring says it must raise; the loop also rebinds the argument." Then write_file with the whole improved function, then next_file. Keep that cadence every turn."""
TOOLS = [
    {"name": "next_file", "description": "Return the next file in the review queue. Takes no arguments; files arrive in a fixed order.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "write_file", "description": "Write a whole file in the repository.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "run_tests", "description": "Run the test suite and return a one-line summary.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string", "description": "optional test path"}}}},
]

class Agentic:
    """Coding-agent shaped workload: code in, tool_use out, tool_result back, same token budget per turn as the essay."""
    name = "agentic"
    def __init__(s):
        s.C, s.cpt = load_code(), A.chars_per_tok
        # The system block carries a second, static breakpoint: identical across sessions, so sessions after the first read it from
        # cache. It only takes effect if system + tools reach the model's minimum cacheable length (1024 tokens on Sonnet); below
        # that the API ignores it and the prefix is simply cached under the per-session breakpoint.
        s.extra = {"system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}], "tools": TOOLS}
        s.fixed_tok = int((len(SYSTEM) + len(json.dumps(TOOLS))) / s.cpt)
    def slice(s, seed, lo_tok, hi_tok):
        need = int((A.start_tok + (A.turns + 1) * A.turn_tok) * s.cpt) + 1
        if need > len(s.C): sys.exit(f"code corpus too small: {len(s.C)} chars, a session needs {need}")
        off = (seed * 1_000_003) % (len(s.C) - need)
        return s.C[off + int(lo_tok * s.cpt): off + int(hi_tok * s.cpt)]
    def first(s, sid, seed):
        head = f"[session {sid}]\nRepository snapshot, files in review order (the queue continues through next_file):\n\n"
        task = ("\n\nTask: review this repository for correctness and clarity as described in the system prompt. Start with the files "
                "above: comment, call write_file once with an improved function or class, then call next_file.")
        return [{"type": "text", "text": head + s.slice(seed, 0, A.start_tok)},
                {"type": "text", "text": "Next file in the queue:\n\n" + s.slice(seed, A.start_tok, A.start_tok + A.turn_tok) + task}]
    def next_turn(s, seed, turn, prev):
        """tool_result for every tool_use of the previous reply; the turn's one file goes to the first next_file call, else to a text block."""
        chunk = "Next file in the queue:\n\n" + s.slice(seed, A.start_tok + turn * A.turn_tok, A.start_tok + (turn + 1) * A.turn_tok)
        blocks, given = [], False
        for b in prev:
            if b["type"] != "tool_use": continue
            if b["name"] == "next_file" and not given: res, given = chunk, True
            elif b["name"] == "next_file": res = "The queue serves one file per turn; call next_file again next turn."
            elif b["name"] == "write_file": res = f"Wrote {b['input'].get('path', '?')} ({len(str(b['input'].get('content', '')))} chars)."
            else: res = "collected 212 items\n212 passed in 1.84s"
            blocks.append({"type": "tool_result", "tool_use_id": b["id"], "content": res})
        if not given: blocks.append({"type": "text", "text": "Continue. " + chunk})
        return blocks
    def est_tok(s, blocks): return sum(len(json.dumps(b)) for b in blocks) / s.cpt
    def fake_reply(s):
        return [{"type": "text", "text": "(review)"},
                {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:12]}", "name": "write_file", "input": {"path": "x.py", "content": "def f():\n    return 1\n"}},
                {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:12]}", "name": "next_file", "input": {}}]
    def samples(s): return [("one turn of code", s.slice(0, A.start_tok, A.start_tok + A.turn_tok))]

def check(msgs):
    """Structural checks the API would otherwise reject with a 400; used by --dry-run and cheap enough to run always."""
    for i, m in enumerate(msgs):
        assert m["role"] == ("user" if i % 2 == 0 else "assistant"), f"role order broken at message {i}"
        assert m["content"], f"empty content at message {i}"
        if m["role"] == "user" and i:
            ids = {b["id"] for b in msgs[i - 1]["content"] if b["type"] == "tool_use"}
            res = [b for b in m["content"] if b["type"] == "tool_result"]
            assert {b["tool_use_id"] for b in res} == ids, f"tool_result ids do not match the tool_use ids at message {i}"
            assert all(b["type"] == "tool_result" for b in m["content"][:len(res)]), f"tool_result blocks must come first at message {i}"
    assert sum("cache_control" in b for m in msgs for b in m["content"]) == 1, "exactly one breakpoint expected in messages"

# ---------- one request ----------

async def call(client, body, row, budget, reserve_usd):
    """one streamed request; retries on 429/529/5xx and transport errors. returns ((content, usage), rows) or (None, rows)"""
    delays = [2, 4, 8, 16, 32, 60]; rows = []
    for attempt in range(len(delays) + 1):
        r = dict(row, attempt=attempt)
        if not await budget.reserve(reserve_usd): r["error"] = "budget_cap"; return None, rows + [r]
        settled = False; t_send = time.time(); r["t_send"] = t_send
        blocks, usage, cur, first_blk, first_ev, first_txt, last = [], {}, None, None, None, None, None
        try:
            async with client.stream("POST", URL, headers=HDR, json=body, timeout=TIMEOUT) as resp:
                r["t_headers"] = time.time(); r["http_status"] = resp.status_code; r["request_id"] = resp.headers.get("request-id", "")
                for k, h in RL.items(): r[k] = resp.headers.get(h, "")
                if resp.status_code != 200:
                    r["error"] = (await resp.aread()).decode()[:300].replace("\n", " ")
                    await budget.settle(reserve_usd, 0.0); settled = True
                    if resp.status_code in (429, 529, 500, 502, 503) and attempt < len(delays):
                        ra = resp.headers.get("retry-after"); r["error"] = "retried: " + r["error"]; rows.append(r)
                        await asyncio.sleep(float(ra) if ra else delays[attempt]); continue
                    return None, rows + [r]
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"): continue
                    d = json.loads(line[5:]); typ = d.get("type"); now = time.time()
                    if typ == "message_start":
                        r["t_message_start"] = now; usage.update(d["message"].get("usage", {}))
                    elif typ == "content_block_start":
                        cur = dict(d["content_block"]); blocks.append(cur); first_blk = first_blk or now
                    elif typ == "content_block_delta":
                        dl = d["delta"]; first_ev = first_ev or now; last = now
                        if dl["type"] == "text_delta": first_txt = first_txt or now; cur["text"] = cur.get("text", "") + dl["text"]
                        elif dl["type"] == "thinking_delta": cur["thinking"] = cur.get("thinking", "") + dl["thinking"]
                        elif dl["type"] == "signature_delta": cur["signature"] = cur.get("signature", "") + dl["signature"]
                        elif dl["type"] == "input_json_delta": cur["_json"] = cur.get("_json", "") + dl["partial_json"]
                    elif typ == "content_block_stop" and cur is not None and cur.get("type") == "tool_use":
                        try: cur["input"] = json.loads(cur.pop("_json", "") or "{}")
                        except ValueError: cur["input"] = {}; r["error"] = "tool_use input is not valid JSON"
                    elif typ == "message_delta":
                        usage.update({k: v for k, v in d.get("usage", {}).items() if v is not None}); r["stop_reason"] = d["delta"].get("stop_reason")
                    elif typ == "error":
                        r["error"] = json.dumps(d)[:300]
        except Exception as e:
            r["error"] = f"{type(e).__name__}: {e}"[:300]
        t_done = time.time(); c = cost(usage) if usage.get("output_tokens") is not None else 0.0
        if not settled: await budget.settle(reserve_usd, c)
        out = usage.get("output_tokens") or 0; th = (usage.get("output_tokens_details") or {}).get("thinking_tokens")
        ms = lambda a, b: round((b - a) * 1000, 1) if a and b else ""
        rate = lambda tok, a, b: round(tok / (b - a), 2) if a and b and b > a else ""
        pr = (usage.get("input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0)
        r.update(t_first_block=first_blk or "", t_first_event=first_ev or "", t_first_text=first_txt or "", t_last_delta=last or "", t_done=t_done,
                 ttfb_ms=ms(t_send, r.get("t_headers")), ttft_block_ms=ms(t_send, first_blk), ttft_ms=ms(t_send, first_ev), ttft_text_ms=ms(t_send, first_txt),
                 decode_window_ms=ms(first_ev, last), inst_gen_tps=rate(out, first_ev, last),
                 inst_gen_text_tps=rate(out - (th or 0), first_txt, last),   # visible text tokens over the visible text window
                 input_tokens=usage.get("input_tokens", ""), cache_creation_tokens=usage.get("cache_creation_input_tokens", ""),
                 cache_read_tokens=usage.get("cache_read_input_tokens", ""), output_tokens=usage.get("output_tokens", ""),
                 thinking_tokens="" if th is None else th, prompt_tokens=pr,
                 new_prefill_tokens=(usage.get("input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0),
                 text_chars=sum(len(b.get("text", "")) for b in blocks), thinking_chars=sum(len(b.get("thinking", "")) for b in blocks),
                 block_types=",".join(b.get("type", "?") for b in blocks), cost_usd=round(c, 6))
        if r.get("stop_reason") in ("refusal", "max_tokens") or not usage.get("output_tokens"):
            r["error"] = r.get("error") or f"bad_response stop_reason={r.get('stop_reason')} output_tokens={usage.get('output_tokens')}"
        if r.get("error") or r.get("http_status") != 200:
            transient = r.get("stop_reason") not in ("refusal", "max_tokens") and any(
                k in str(r.get("error")) for k in ("RemoteProtocolError", "ReadError", "ReadTimeout", "ConnectError", "overloaded_error", "api_error"))
            if transient and attempt < len(delays):
                r["error"] = "retried: " + str(r["error"]); rows.append(r)
                await asyncio.sleep(delays[attempt]); continue
            return None, rows + [r]
        content = [{k: v for k, v in b.items() if k in KEEP} for b in blocks]
        for b in content:
            if b["type"] == "thinking": b.setdefault("thinking", ""); b.setdefault("signature", "")
            if b["type"] == "tool_use": b.setdefault("input", {})
        content = [b for b in content if b["type"] != "text" or b.get("text", "").strip()]   # the API rejects empty text blocks
        return (content, usage), rows + [r]
    return None, rows

# ---------- sessions and tiers ----------

class Tier:
    def __init__(s, n): s.n, s.stop, s.failed = n, asyncio.Event(), 0

async def session(client, tier, idx, budget, writer, log):
    sid = f"N{tier.n}-s{idx}-{uuid.uuid4().hex[:8]}"; seed = tier.n * 100 + idx
    await asyncio.sleep(random.uniform(0, A.stagger))
    msgs = [{"role": "user", "content": WL.first(sid, seed)}]
    prev_prompt, prev_out, t_ok = 0, 0, time.time()
    for turn in range(A.turns):
        if tier.stop.is_set(): log(f"{sid} stop before turn {turn}"); return
        for m in msgs:   # one moving breakpoint: drop the older ones, mark the newest user block
            if m["role"] == "user":
                for b in m["content"]: b.pop("cache_control", None)
        if turn: msgs.append({"role": "user", "content": WL.next_turn(seed, turn, msgs[-1]["content"])})
        msgs[-1]["content"][-1]["cache_control"] = {"type": "ephemeral"}
        try: check(msgs)
        except AssertionError as e:
            log(f"{sid} turn {turn} malformed request, session stops: {e}"); tier.failed += 1; return
        new_est = (A.start_tok + WL.fixed_tok if turn == 0 else 0) + A.turn_tok + prev_out + 500
        p_prev = P_CW if time.time() - t_ok > CACHE_TTL_S - 60 else P_CR   # idle near the TTL: the whole prefix may be rewritten
        reserve = (new_est * P_CW + prev_prompt * p_prev + A.max_tokens * P_OUT) / 1e6 * 1.1
        body = {"model": MODEL, "max_tokens": A.max_tokens, "stream": True, "thinking": {"type": "adaptive"}, "messages": msgs, **WL.extra}
        if A.dry_run:
            new = msgs[-1]["content"]; est = WL.est_tok(new)
            log(f"dry {sid} t{turn}: messages={len(msgs)} new_blocks={[b['type'] for b in new]} new_tok~{est:.0f} "
                f"prompt_tok~{prev_prompt + est:.0f} body_bytes={len(json.dumps(body))} reserve=${reserve:.3f}")
            msgs.append({"role": "assistant", "content": WL.fake_reply()}); prev_prompt += est + prev_out; prev_out = 600; continue
        res, rows = await call(client, body, {"tier": tier.n, "session_id": sid, "turn": turn}, budget, reserve)
        for r in rows: writer.writerow({k: r.get(k, "") for k in FIELDS})
        if res is None:
            last = rows[-1] if rows else {}; err = str(last.get("error")); tier.failed += 1
            fatal = err == "budget_cap" or tier.failed > tier.n * A.max_failed_frac
            log(f"{sid} turn {turn} FAILED status={last.get('http_status')} err={err[:160]} -> {'stopping tier' if fatal else 'session stops, tier continues'}")
            if fatal: tier.stop.set()
            return
        content, usage = res
        msgs.append({"role": "assistant", "content": content})
        prev_prompt = rows[-1]["prompt_tokens"]; prev_out = usage.get("output_tokens", 0); t_ok = time.time()
        log(f"{sid} t{turn} prompt={prev_prompt} cw={usage.get('cache_creation_input_tokens')} cr={usage.get('cache_read_input_tokens')} "
            f"out={prev_out} think={rows[-1]['thinking_tokens']} blocks={rows[-1]['block_types']} ttft={rows[-1]['ttft_ms']}ms "
            f"tps={rows[-1]['inst_gen_tps']} text_tps={rows[-1]['inst_gen_text_tps']} spent={budget.spent:.3f}")

async def lag_monitor(samples):
    """Event-loop lag in ms, sampled every 50 ms: if the client is the bottleneck, this grows with N before anything else does."""
    while True:
        t = time.perf_counter(); await asyncio.sleep(0.05); samples.append((time.perf_counter() - t - 0.05) * 1000)

def client_load(samples, cpu0, wall):
    ru = resource.getrusage(resource.RUSAGE_SELF); cpu = ru.ru_utime + ru.ru_stime - cpu0
    s = sorted(samples) or [0.0]; p99 = s[int(0.99 * (len(s) - 1))]
    flag = "  <- client-bound, distrust this tier" if wall > 5 and (p99 > 50 or cpu > 0.7 * wall) else ""
    return f"client load: event-loop lag p99 {p99:.1f} ms, max {s[-1]:.1f} ms; cpu {cpu:.1f}s of {wall:.0f}s wall ({cpu / max(wall, 1e-9):.0%}){flag}"

def calibrate():
    """Free count_tokens calls: the fixed prefix (system + tools) and the chars per token of one turn's chunk."""
    import httpx
    hdr = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
    def count(body):
        r = httpx.post(URL + "/count_tokens", headers=hdr, json=dict(body, model=MODEL), timeout=60); r.raise_for_status()
        return r.json()["input_tokens"]
    base = count({"messages": [{"role": "user", "content": "x"}], **WL.extra})
    print(f"fixed prefix (system + tools + a 1-token message): {base} tokens")
    for label, text in WL.samples():
        n = count({"messages": [{"role": "user", "content": text}], **WL.extra}) - base
        print(f"{label}: {len(text)} chars, {len(text.split())} words -> {n} tokens: {len(text) / n:.3f} chars/tok, {n / len(text.split()):.3f} tok/word")

async def main():
    global HDR, TIMEOUT, A, WL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tiers", default="1"); ap.add_argument("--turns", type=int, default=10)
    ap.add_argument("--start-tok", type=int, default=60_000); ap.add_argument("--turn-tok", type=int, default=8_000)
    ap.add_argument("--workload", choices=("essay", "agentic"), default="essay")
    ap.add_argument("--max-tokens", type=int, default=16_000, help="also the per-call output reservation; the essay needs about 1k")
    ap.add_argument("--chars-per-tok", type=float, default=3.0, help="agentic chunk sizing; measure with --calibrate")
    ap.add_argument("--book", default="", help="essay corpus path; default mobydick.txt next to this script")
    ap.add_argument("--stagger", type=float, default=2.0, help="random session start delay, seconds")
    ap.add_argument("--max-failed-frac", type=float, default=0.25, help="stop a tier once more than this fraction of its sessions failed")
    ap.add_argument("--cap-usd", type=float, default=27.8); ap.add_argument("--spent-before", type=float, default=0.0)
    ap.add_argument("--per-session-usd", type=float, default=0.0, help="projection; skip tier if spent+N*this*1.15 > cap")
    ap.add_argument("--out", default="calls.csv")
    ap.add_argument("--dry-run", action="store_true", help="build and check every request offline; no key, no network, no CSV")
    ap.add_argument("--calibrate", action="store_true", help="count_tokens only (not billed): prints tokens of the fixed prefix and of one chunk")
    A = ap.parse_args()
    WL = Essay() if A.workload == "essay" else Agentic()
    if A.calibrate: return calibrate()
    tiers = [int(x) for x in A.tiers.split(",")]
    budget = Budget(float("inf") if A.dry_run else A.cap_usd); budget.spent = A.spent_before
    f = w = None
    if not A.dry_run:
        import httpx
        HDR = {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"}
        TIMEOUT = httpx.Timeout(600, connect=30)
        pool = max(64, max(tiers) + 8)   # one HTTP/1.1 connection per in-flight stream, all kept alive between turns
        client = httpx.AsyncClient(http2=False, limits=httpx.Limits(max_connections=pool, max_keepalive_connections=pool))
        new = not os.path.exists(A.out)
        f = open(A.out, "a", newline=""); w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        if new: w.writeheader()
    else:
        client = contextlib.nullcontext()
    def log(m):
        print(time.strftime("%H:%M:%S"), m, flush=True)
        if f: f.flush()
    log(f"workload={WL.name} turns={A.turns} start_tok={A.start_tok} turn_tok={A.turn_tok} max_tokens={A.max_tokens} python={sys.version.split()[0]}")
    async with client:
        for n in tiers:
            if A.per_session_usd and budget.spent + n * A.per_session_usd * 1.15 > budget.cap:
                log(f"SKIP tier N={n}: projected {budget.spent + n * A.per_session_usd * 1.15:.2f} > cap {budget.cap}"); continue
            tier = Tier(n); samples = []; mon = asyncio.create_task(lag_monitor(samples))
            ru = resource.getrusage(resource.RUSAGE_SELF); cpu0 = ru.ru_utime + ru.ru_stime; t0 = time.time()
            log(f"=== tier N={n} start (spent {budget.spent:.3f})")
            await asyncio.gather(*[session(client, tier, i, budget, w, log) for i in range(n)])
            mon.cancel(); await asyncio.gather(mon, return_exceptions=True)
            if f: f.flush()
            log(f"=== tier N={n} done in {time.time() - t0:.0f}s, spent {budget.spent:.3f} USD, failed sessions {tier.failed}, stopped={tier.stop.is_set()}")
            log(client_load(samples, cpu0, time.time() - t0))
    log(f"TOTAL spent {budget.spent:.4f} USD")

if __name__ == "__main__":
    asyncio.run(main())
