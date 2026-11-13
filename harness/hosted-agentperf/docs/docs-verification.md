# Docs verification

Checked on **2026-10-29** against the public pages below. Status is `confirmed`, `not found`, or `different`. The pilot does not depend on a row that is not `confirmed`. Rows that describe product behavior the docs do not state stay on the empirical checklist.

The protocol's statistical placeholders (sigma ≈ 200 ms, SE(α) ≈ 1.2 µs/token, β ≈ α/100) are not documentation claims. The analysis computes sigma, the standard errors, and β/α from the sample.

| Claim | Status | Source | Date |
| --- | --- | --- | --- |
| On a Claude subscription, within included plan usage, the main conversation (interactive, `-p`, SDK) requests a one-hour prompt cache. Subagents, compaction, workflows, and session titles stay at five minutes unless configured. A cache hit resets the timer. | confirmed | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| The one-hour TTL is unconditional for any subscription session. | different | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| Once the session draws on usage credits, the main conversation drops to five minutes unless you set the TTL yourself. A few server-controlled helper requests can still be one hour. | confirmed | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts only `5m` or `1h` for the main conversation (v2.1.242+). `FORCE_PROMPT_CACHING_5M=1` overrides it and forces five minutes for both buckets. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `claude -p "hello" --output-format json` reports one-hour writes as `usage.cache_creation.ephemeral_1h_input_tokens` and five-minute writes as `ephemeral_5m_input_tokens`. | confirmed | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| Cache is scoped by machine and directory, and sequential sessions share a prefix only when the git status snapshot taken at startup matches. | confirmed | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| On Sonnet 5.5 with a subscription, changing effort keeps the cache. | confirmed | https://code.claude.com/docs/en/prompt-caching | 2026-10-29 |
| `DISABLE_PROMPT_CACHING=1` disables prompt caching for all models. `DISABLE_PROMPT_CACHING_SONNET=1` follows the `sonnet` alias, not an arbitrary pinned Sonnet id. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| Span `claude_code.llm_request` carries `ttft_ms`, `duration_ms`, `input_tokens` (excluding cache), `cache_read_tokens`, `cache_creation_tokens`, `output_tokens`, `request_id`, `attempt`, `stop_reason`, `speed`, `effort`, `model`, `status_code`, `error_class`. Tracing needs `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and `OTEL_TRACES_EXPORTER`. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| `first_content_ms` is the delay from request start to the first content block of the successful attempt (v2.1.268+). It is absent if the request fell back to non-streaming. It is a different field from `ttft_ms`. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| `query_source_safe` is on the span without detailed beta tracing (v2.1.268+), with values such as `repl_main_thread`. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| The span attribute `query_source` (values such as `compact`) requires `ENABLE_BETA_TRACING_DETAILED`, which also sends logs and traces to `BETA_TRACING_ENDPOINT`. | different | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| The `api_request` log event carries `query_source` (`repl_main_thread`, `compact`, or a subagent name) without that detailed-tracing switch. The harness reads it from the log. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| `OTEL_LOG_RAW_API_BODIES=file:<dir>` writes untruncated request and response bodies and, on v2.1.274+, an `index.jsonl` with `request_id`, `message_id`, and the file names. `=1` truncates at 60 KB. Extended thinking in the bodies is redacted. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` and a local OTLP endpoint are supported. Signal-specific endpoints in the docs look like `http://localhost:4318/v1/logs`. | confirmed | https://code.claude.com/docs/en/monitoring-usage | 2026-10-29 |
| `DISABLE_AUTOUPDATER=1` disables background auto-update. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` skips the small-model session-title request. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` turns prompt suggestions off (v2.1.238+). | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_FAST_MODE=1` disables fast mode. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` disables the silent model switch on a classifier flag. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` keeps a mid-stream failure from being retried as a non-streaming request. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables auto memory. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` stops CLAUDE.md files from being loaded. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_EFFORT_LEVEL=low` is a valid effort. For Sonnet 5.5 the documented levels are `low`, `medium`, `high`, `xhigh`, `max`, and the default is `medium`. `low` is the lowest level. | confirmed | https://code.claude.com/docs/en/model-config | 2026-10-29 |
| `MAX_THINKING_TOKENS=0` and `CLAUDE_CODE_DISABLE_THINKING=1` do not turn thinking off on Sonnet 5.5. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_MAX_RETRIES` overrides the retry count (default 10). | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429 and 529 past that cap. The harness leaves it unset. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `idleCompaction` is an environment variable. | not found | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `idleCompaction: false` in settings disables idle compaction (v2.1.290+). `DISABLE_AUTO_COMPACT=1` also disables idle compaction and context-limit auto-compaction. The env var `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` only raises the threshold (floor 100000). | confirmed | https://code.claude.com/docs/en/settings-reference and https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` sets the output-token cap for most requests. Values above the model cap are lowered. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| With that cap, Claude Code sends exactly one request and does not launch another after `stop_reason=max_tokens`. | not found | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `HTTPS_PROXY` is supported. SOCKS proxies are not. Claude Code checks `https_proxy`, then `HTTPS_PROXY`, then `http_proxy`, then `HTTP_PROXY`. | confirmed | https://code.claude.com/docs/en/network-config | 2026-10-29 |
| `NODE_EXTRA_CA_CERTS` adds a CA file. | confirmed | https://code.claude.com/docs/en/network-config | 2026-10-29 |
| Request-body gzip is skipped when a proxy is configured, and also when a client certificate or `NODE_EXTRA_CA_CERTS` is set. `CLAUDE_CODE_GZIP_REQUEST_BODIES=0` turns gzip off explicitly. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| The first-byte deadline on the direct API is 180 seconds plus one second per 32 KB of request body, including through an HTTPS proxy. | confirmed | https://code.claude.com/docs/en/network-config | 2026-10-29 |
| `CLAUDE_CODE_SIMPLE=1` / `--bare` does not read OAuth or keychain credentials. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `--settings <file>` overrides the same keys for one session. Keys you omit keep their values from settings files, so this flag alone does not isolate `~/.claude/settings.json`. | confirmed | https://code.claude.com/docs/en/cli-reference | 2026-10-29 |
| `--restricted` (v2.1.248+) loads only managed settings and `--settings`, does not read user or project settings, removes command-running tools and WebFetch, and refuses cloud sessions. The docs describe it for an evaluation harness on a shared machine. | confirmed | https://code.claude.com/docs/en/cli-reference | 2026-10-29 |
| `--model` accepts a full model id and overrides `ANTHROPIC_MODEL` and the `model` setting. | confirmed | https://code.claude.com/docs/en/cli-reference | 2026-10-29 |
| Claude API model id for Sonnet 5.5 is `claude-sonnet-5-5`. Dateless ids from the 4.6 generation on are pinned snapshots. | confirmed | https://platform.claude.com/docs/en/models/sonnet-5-5/overview | 2026-10-29 |
| `--effort low` sets the session effort and does not persist. `--effort ultracode` turns ultracode on at `xhigh`. The `ultracode` setting is separate; `false` starts sessions with it off. `CLAUDE_CODE_EFFORT_LEVEL` does not turn ultracode off by itself. | confirmed | https://code.claude.com/docs/en/model-config | 2026-10-29 |
| `--tools ""` disables built-in tools. `--disallowed-tools "*"` removes every tool from context. `--max-turns` limits agentic turns in print mode. `claude -p --continue` resumes a `-p` session in the current directory. `--strict-mcp-config` ignores MCP configs other than `--mcp-config`. | confirmed | https://code.claude.com/docs/en/cli-reference | 2026-10-29 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` turn off background tool runs and background agents. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is off unless set to `1`. | confirmed | https://code.claude.com/docs/en/env-vars | 2026-10-29 |
| `disableAllHooks` and `workflowKeywordTriggerEnabled` are settings keys. | confirmed | https://code.claude.com/docs/en/settings-reference | 2026-10-29 |
| `docs/schemas` in aa-agentperf-local contains a closed JSON schema for `turns.jsonl`. | not found | https://github.com/ArtificialAnalysis/aa-agentperf-local/blob/main/docs/FORMATS.md | 2026-10-29 |
| The schemas in that folder are recipe, NVIDIA telemetry, runtime qualification, and the submission OpenAPI spec. Per-turn fields are `TurnReport` in `agentperf_local/reports/reporting.py`. | confirmed | https://github.com/ArtificialAnalysis/aa-agentperf-local/blob/main/docs/FORMATS.md and `agentperf_local/reports/reporting.py` | 2026-10-29 |
| The public laptop leaderboard publishes per-result `prefillTokensPerSecond` and `outputTokensPerSecond`. | confirmed | https://artificialanalysis.ai/hardware-inference-stack/laptops-workstations | 2026-10-29 |

## What the protocol treated as settled, and the docs do not

1. **One-hour cache on every subscription session.** The hour applies to the main conversation only while the session is inside included plan usage. On usage credits it falls back to five minutes. The pilot reads `ephemeral_1h_input_tokens` instead of assuming the hour.

2. **`idleCompaction` as an environment variable.** It is a settings key. The lock sets `idleCompaction: false` in the session settings file passed with `--settings`, and also sets `DISABLE_AUTO_COMPACT=1`.

3. **Span `query_source` without extra switches.** Detailed beta tracing would move the export off the local collector. The harness uses `query_source` on the `api_request` log and `query_source_safe` on the span.

4. **No second request after `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.** The cap exists. Whether Claude Code launches another request is not in the docs. The `max_output` cell counts proxy rows and records the result.

5. **`~/.claude/settings.json` can be left untouched by `--settings` alone.** Omitted keys still come from that file. `--restricted` is what stops the process from reading it. Managed settings still apply; the pilot cannot override those.

6. **There is no closed `turns.jsonl` schema to copy.** The field mapping is in `docs/aa-crosswalk.md`, taken from `TurnReport`.
