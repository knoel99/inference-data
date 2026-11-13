"""Column names for the phase-0 CSV files.

``REQUEST_COLUMNS`` follows protocol section 7.1, then the derived columns
defined there, then ``off_thread``. ``off_thread`` is not in the protocol
table: it is the calibration flag for a request whose query source is not
the main thread. Empty means the source was not observed.

Cursor columns follow section 7.2. Cells that the transcript and the
orchestrator log do not contain stay empty. Derived cursor columns are the
ones the protocol defines from those raw cells.
"""

REQUEST_RAW_COLUMNS = [
    "target",
    "phase",
    "cell",
    "block",
    "rep",
    "agent_version",
    "model_pinned",
    "model_served",
    "effort",
    "speed",
    "session_id",
    "turn_index",
    "query_source",
    "request_id",
    "attempt",
    "http_status",
    "t_send",
    "t_headers",
    "t_message_start",
    "t_first_delta",
    "t_first_text",
    "t_last_delta",
    "t_message_stop",
    "ttft_ms_otel",
    "first_content_ms_otel",
    "duration_ms_otel",
    "input_tokens",
    "cache_creation_tokens",
    "cache_creation_5m",
    "cache_creation_1h",
    "cache_read_tokens",
    "output_tokens",
    "stop_reason",
    "has_tool_call",
    "n_tool_calls",
    "prefix_shared_chars",
    "failure_class",
]

REQUEST_DERIVED_COLUMNS = [
    "prompt_tokens",
    "new_tokens",
    "cache_ratio",
    "ttft_ms",
    "ttft_text_ms",
    "decode_window_ms",
    "decode_tps",
    "turn_ms",
    "proxy_offset_ms",
]

REQUEST_COLUMNS = REQUEST_RAW_COLUMNS + REQUEST_DERIVED_COLUMNS + ["off_thread"]

CURSOR_TURN_COLUMNS = [
    "target",
    "phase",
    "cell",
    "block",
    "rep",
    "model_pinned",
    "model_served",
    "effort",
    "failure_class",
    "sdk_version",
    "model_id",
    "model_params",
    "runtime",
    "agent_id",
    "run_id",
    "request_id",
    "turn_index",
    "t_send",
    "t_status_creating",
    "t_status_running",
    "t_first_delta",
    "t_first_text_delta",
    "t_last_delta",
    "t_turn_ended",
    "t_finished",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "durationMs",
    "status",
    "error_code",
    "n_steps",
    "n_tool_calls",
    "thinking_duration_ms_sum",
    "usage_api_input",
    "usage_api_output",
    "usage_api_cache_read",
    "usage_api_cache_write",
    "start_wait_ms",
    "ttft_ms",
    "cache_ratio",
    "decode_tps_est",
    # Filled from the orchestrator log and the role/text transcript.
    # Token, prefill, cache, and decode columns above stay empty.
    "measurement",
    "n_user_messages",
    "n_assistant_texts",
    "n_thinking",
    "user_chars",
    "assistant_text_chars",
    "thinking_chars",
]

# Launch ids this account can start. Claude, GPT, and Opus ids are refused.
CURSOR_MODELS = ("composer-2.5", "grok-4.7")

CURSOR_STEP_COLUMNS = [
    "agent_id",
    "run_id",
    "turn_index",
    "step_id",
    "t_step_started",
    "t_step_completed",
    "stepDurationMs",
    "n_text_deltas",
    "n_text_chars",
    "token_delta_sum",
    "model_call_ids",
]

MODEL_PINNED = "claude-sonnet-5-5"
EFFORT_PINNED = "low"
MAIN_THREAD_SOURCES = {"repl_main_thread"}

# Protocol section 5.7. E5 and E6 are counted apart from the failure rate.
FAILURE_CLASSES = ("E1", "E2", "E3", "E4", "E5", "E6")
FAILURE_RATE_CLASSES = ("E1", "E2", "E3", "E4")
