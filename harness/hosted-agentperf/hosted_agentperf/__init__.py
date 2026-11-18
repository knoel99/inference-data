"""Phase-0 measurement harness for a hosted-agent benchmark.

Claude Code is driven only by ``claude -p`` on the operator's machine.
This package does not call the Anthropic API and does not read OAuth tokens.
Cursor cloud agents are not launched here; their transcripts are ingested.
"""

__version__ = "0.1.0"
