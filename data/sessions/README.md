# Claude Code sessions

Token counts from the repository owner's own Claude Code sessions in October 2026, kept to compare a hosted frontier model with the agentic-trace results in `data/agentic.csv`. These files are outside the `datapackage.json` contract: they come from private session transcripts, not from a public page, so they carry no source URL. Do not cite them as measurements of a device.

| File | One row is |
| --- | --- |
| `claude-code-sessions.csv` | A session: task, period (UTC), model, agent counts, and output, cache-read, and cache-write tokens in millions |
| `claude-code-session-c-agents.csv` | One sub-agent of session C: phase, mean number of agents running at the same time, active minutes, and its tokens |

Columns ending in `_tok_s` in the per-agent file are computed here, not timed: tokens divided by the agent's active time (from its first to its last API call, tool calls included). `uncached_input_tok_s` uses cache-write tokens, the part of each prompt the server actually had to compute; `total_input_tok_s` adds cache-read tokens, the part served from Anthropic's prompt cache. Across session C, cache reads are about 47 times cache writes. The model's own compute time is not in the transcripts, so these rates are demand averaged over the agent's life, not prefill or decode speeds.
