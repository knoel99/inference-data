# Hosted-agent phase-0 harness

Measurement harness for the pilot (phase 0) of a hosted-agent benchmark. It separates, as far as a client can:

- prefill of new, uncached tokens
- prefix-cache read cost and the cache-hit ratio of each request
- decode tokens per second
- queue or start wait (the regression intercept, plus header delay)
- cache-ratio change across turns
- failed or cut requests (E1–E6)

This directory is the Claude Code half, plus the Cursor cloud-agent task text and a transcript ingester. It does not launch Cursor agents and it does not call a paid API. Claude Code is started only as `claude -p` on the machine where you are already signed in.

The machine this was written for is a shared Linux VM: x86_64, 8 vCPU, about 15 GB RAM, Linux 6.12, Node at `/usr/local/bin/node`, Python 3, Claude Code 2.1.312 at `~/.local/bin/claude`. mitmproxy is not preinstalled. Nothing in these steps needs sudo, and nothing writes `~/.claude/settings.json`.

## What you do by hand

The cloud checkout that added this folder does not run Claude Code.

1. On the Linux VM, confirm `~/.local/bin/claude --version` and that the subscription login still works. Do not print or copy OAuth tokens.
2. Create a work directory that is not under `~/.claude`.
3. Install mitmproxy into a venv there (steps below).
4. Run `plan`, read the request count and the worst-case token line, then run with `--confirm`.
5. When the runner asks, record `/usage` in a separate interactive `claude` session. Do not change settings while you do it.
6. Cursor cells are prompts in `cursor_tasks/`. Launch them with your orchestrator. Point the ingester at the orchestrator log and the dumped transcript JSONL.

## Quota

`python -m hosted_agentperf.pilot plan` prints:

- the number of `claude -p` processes the pilot will start (26 with the default 20 proxy-offset repeats)
- a chars/4 estimate of the user text
- a system-prompt **budget** (default 25,000 tokens). That number is a ceiling, not a measurement
- expected new tokens if the warm calls hit cache
- worst-case new tokens if every call misses cache

The worst case is dominated by the twenty proxy-offset calls, because each one can pay the system prompt again. Warm calls are not free until the server reports a cache read.

Nothing is sent without `--confirm`. After the uncached `OK` call, if the measured `input_tokens` exceed the budget you confirmed, the 32k calls are not sent. On a non-interactive stdin, the 32k calls also wait for `--usage-recorded`.

Thinking cannot be disabled on `claude-sonnet-5-5`. Only the `max_output` cell sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=512`. Other replies are uncapped. There is no console API key: if `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, the runner exits before `claude` starts.

## Disk

Keep at least 1 GB free on the work filesystem.

| Piece | About |
| --- | --- |
| mitmproxy venv | 50–100 MB |
| mitmproxy CA directory | a few KB |
| Pilot prompt bodies (two 32k texts, plus the short calls) | under 2 MB, stored again under the OTEL body dir |
| SSE fragment log for short “OK” replies | usually under 10 MB |
| Cursor prompt files in this repo | under 1 MB |

A long thinking trace on an uncapped call can grow the fragment log. The 1 GB margin covers that for the pilot. Phase A (not this runner) is larger.

## Prerequisites

- Python 3.9+ (stdlib only for the joiner, the regression, and the tests)
- `~/.local/bin/claude` on the subscription account, Node already on the machine
- outbound HTTPS to the Anthropic API from that account, and nothing else this harness should talk to
- no system proxy, VPN, or `https_proxy` pointing anywhere but the local mitmproxy once the run starts (the runner sets this in the child environment)

Record the host, without changing it. Shared CPU is part of the wait term the quantile fit is there to absorb. There is no power-plan switch and no sudo.

```bash
uname -a
nproc
free -h
command -v node
~/.local/bin/claude --version
```

## Install mitmproxy without sudo

`python3 -m venv` fails on this image when `ensurepip` is missing. `--without-pip` still works.

```bash
export WORK="$HOME/hosted-agentperf-runs"
mkdir -p "$WORK"
cd /path/to/harness/hosted-agentperf

python3 -m venv --without-pip "$WORK/venv"
curl -fsSL https://bootstrap.pypa.io/get-pip.py | "$WORK/venv/bin/python"
"$WORK/venv/bin/python" -m pip install mitmproxy
```

If `python3 -m venv` works on a later image, the same three lines are still valid.

Generate the CA inside the work directory (not `~/.mitmproxy`, and not `~/.claude`):

```bash
mkdir -p "$WORK/mitmproxy-ca"
"$WORK/venv/bin/mitmdump" --listen-host 127.0.0.1 --listen-port 8080 \
  --set confdir="$WORK/mitmproxy-ca" -q &
sleep 1
kill %1
test -f "$WORK/mitmproxy-ca/mitmproxy-ca-cert.pem"
```

Trust is `NODE_EXTRA_CA_CERTS` pointed at that file. Do not install the CA into the system store.

## Run the pilot

From `harness/hosted-agentperf`, so `python -m` finds the package:

```bash
export PYTHONPATH="$PWD"
export WORK="$HOME/hosted-agentperf-runs"
python3 -m hosted_agentperf.pilot plan
python3 -m hosted_agentperf.pilot run \
  --confirm \
  --work-dir "$WORK/pilot-001" \
  --mitmdump "$WORK/venv/bin/mitmdump" \
  --claude "$HOME/.local/bin/claude"
```

The runner starts the OTLP collector on `127.0.0.1:4318` and mitmdump on `127.0.0.1:8080`, then `claude -p`. If you would rather start them yourself, pass `--no-start-services` after they are listening, with `HARNESS_PROXY_DIR` set to `$WORK/pilot-001/proxy`.

What the runner forces, and why:

- `--restricted` plus `--settings env/pilot-settings.json`. `--restricted` is the documented way for a harness on a shared machine to skip user and project settings. The file sets `ultracode` off, `idleCompaction` off, and denies tools. `~/.claude/settings.json` is not opened.
- `--model claude-sonnet-5-5` and `--effort low`. The env file sets `CLAUDE_CODE_EFFORT_LEVEL=low` as well. Effort `low` does not by itself turn ultracode off, so the settings key is `false`.
- `--tools ""`, `--disallowed-tools "*" mcp__*`, `--strict-mcp-config`, `--max-turns 1`. Calibration is one main-thread request stream. `CLAUDE_CODE_SIMPLE` is not set: it would drop the subscription login.
- Cold call: new temp directory under the work dir, 64-character nonce. Warm call: the same directory and the same prompt, skipped (not sent) if more than 60 seconds have passed since the cold process exited. Mixed call: `--continue` in that directory with a new tail.
- `NO_PROXY=127.0.0.1,localhost` so the OTLP export does not loop back through mitmproxy. `https_proxy` is set explicitly because Claude Code reads the lowercase name first.

After the run:

```bash
python3 -m hosted_agentperf.analysis "$WORK/pilot-001/requests.csv" \
  --out "$WORK/pilot-001/analysis.json" \
  --bootstrap 2000
```

`requests.csv` is section 7.1. `off_thread` is an extra column: `1` when `query_source` is present and is not `repl_main_thread`, `0` when it is the main thread, empty when the source was not observed. The regression drops empty and `1`. A main-thread miss is a harness failure (exit code 3) because calibration was supposed to be one stream.

`pilot_checks.json` holds the uncached `OK` input-token count, the TTL fields found in the json result, and the mean of `ttft_ms - first_content_ms_otel` (the proxy overhead the checklist asks you to record).

## Environment lock

`env/claude-code.pilot.env` is the template. Paths use `${HARNESS_BODY_DIR}` and `${HARNESS_MITM_CA}`. The claim-by-claim table is `docs/docs-verification.md`.

Left unset on purpose: `CLAUDE_CODE_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M`. The pilot is there to read which TTL the subscription actually wrote. `DISABLE_PROMPT_CACHING` is set only around the uncached `OK` call. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set only around the cap call.

## Statistics

`hosted_agentperf.analysis` fits, at tau = 0.10,

```
TTFT = L0 + alpha * new_tokens + beta * cache_read_tokens + block indicators
```

with a cell-stratified bootstrap (default 2,000). L0 is the reference block's 0.10 quantile, not a clock on an empty queue. `sigma` is the residual standard deviation of that fit. The formula SE(α) ≈ sigma / (sqrt(n) · sd(new tokens)) is computed from those residuals. The protocol's 200 ms, 1.2 µs, and beta ≈ alpha/100 are stored under `placeholder_not_used` and are not the estimates.

Also written: OLS on the per-cell minimum TTFT, a quadratic term in new tokens, a C0-versus-C1 interaction, decode median/p10/p90 for the full window and the text window, cache ratio per turn with no smoothing, and E1–E6 counts. E5 and E6 are outside the failure rate.

How `1000/alpha` and `decode_tps` differ from AA's `prefillTokensPerSecond` and `outputTokensPerSecond` is in `docs/aa-crosswalk.md`.

## Cursor cloud agents

No SDK and no Cursor API key. This account can launch `composer-2.5` and `grok-4.7`. Claude, GPT, and Opus ids are refused because usage beyond the included plan is off. Run the two models as separate targets.

The transcript dump is only `role` and `text`. It has no timestamps, no usage, and no model id, so it is not the measurement. The task text tells the agent to append `bench/cursor_runs/<run_id>/steps.jsonl` with `date +%s.%N` before and after each tool call, then commit that file on its branch. `cursor_tasks/log_step.sh` is the append command. Each line has the step index, bytes read (context added this turn), bytes written, `bytes/4` token estimates, and `model_pinned`.

The model turn is the gap from `t_after` of one line to `t_before` of the next. That gap is prefill and decode together. Fetch the committed log and fit it:

```bash
python3 -m hosted_agentperf.cursor_tasks
python3 -m hosted_agentperf.cursor_selflog path/to/steps.jsonl --out cursor_fit.json
```

The measurement cells are `ctx2k`, `ctx8k`, and `ctx32k`, each with a short reply and a long reply, for each model. Prompts are `cursor_tasks/prompts/measure/`. The fit is `turn_time_ms = L0 + a * new_tokens + b * output_tokens`. `1000/a` and `1000/b` are the prefill and decode estimates. Turn 1 versus later turns at the same context size is the cache comparison. The report labels all of this as agent-side wall clocks with tokens estimated from bytes.

`cursor_tasks/manifest.json` lists every cell twice, once per model. `C0` is not launched. SWE-bench prompts are `cursor_tasks/swebench/`, with the published problem text for `django__django-15851`, `django__django-14500`, and `sphinx-doc__sphinx-10614`. They carry the same log instruction and do not add a method or ask for the test suite.

An orchestrator log can still be turned into `cursor_turns.csv` for launch-to-finish wall time and message lengths. That file is not the prefill or decode fit. A dumped transcript looks like `{"role":"user","text":"..."}` then an assistant thinking line and an assistant text line, and nothing else.

```bash
python3 -m hosted_agentperf.cursor_ingest \
  --orchestrator orchestrator.jsonl \
  --transcript-dir transcripts/ \
  --out-dir "$WORK/cursor-001"
```

## Tests

```bash
cd harness/hosted-agentperf
python3 -m unittest discover -s tests -v
```

The synthetic test builds proxy and OTEL rows with a known line plus positive skewed wait (most waits are zero, the rest are exponential), joins them, and checks that the quantile fit recovers alpha, beta, and L0. It does not start Claude Code or open a network connection.

## Layout

| Path | Role |
| --- | --- |
| `env/claude-code.pilot.env` | Locked environment template |
| `env/pilot-settings.json` | Session settings passed with `--settings` |
| `proxy/sse_timestamp.py` | mitmproxy addon, streaming timestamps |
| `hosted_agentperf/otel_collector.py` | OTLP/HTTP JSON receiver |
| `hosted_agentperf/pilot.py` | Phase-0 runner |
| `hosted_agentperf/join.py` | `requests.csv` |
| `hosted_agentperf/analysis.py` | Section 5.7 |
| `cursor_tasks/log_step.sh` | What the agent runs around each tool call |
| `hosted_agentperf/cursor_tasks.py` | Cloud-agent prompts |
| `hosted_agentperf/cursor_selflog.py` | Fit of the committed step log |
| `hosted_agentperf/cursor_ingest.py` | Orchestrator wall clock only, not the service fit |
| `docs/docs-verification.md` | Claim, status, URL, date |
| `docs/aa-crosswalk.md` | TurnReport and the published speeds |
