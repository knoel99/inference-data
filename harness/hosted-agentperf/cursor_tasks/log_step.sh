#!/bin/sh
# Append one measurement line. The agent runs this before and after work
# only in the sense that t_before is captured before the tool and this
# script stamps t_after. Commit the resulting jsonl on the agent branch.
#
#   t0=$(date +%s.%N)
#   # tool call
#   sh log_step.sh "$RUN_ID" "$MODEL" "$CELL" "$STEP" "$t0" "$READ_BYTES" "$WRITE_BYTES"
#
# Step 0, written at start before any tool: read and write bytes are 0.
# read_bytes is context added this turn. write_bytes is what the turn wrote.
# Tokens in the file are bytes/4. The analysis recomputes that itself.
set -eu
run_id=$1
model=$2
cell=$3
step=$4
t_before=$5
read_bytes=$6
write_bytes=$7
dir="bench/cursor_runs/$run_id"
mkdir -p "$dir"
t_after=$(date +%s.%N)
read_tokens=$((read_bytes / 4))
write_tokens=$((write_bytes / 4))
printf '%s\n' \
  "{\"run_id\":\"$run_id\",\"model_pinned\":\"$model\",\"cell\":\"$cell\",\"step\":$step,\"t_before\":\"$t_before\",\"t_after\":\"$t_after\",\"read_bytes\":$read_bytes,\"read_tokens_est\":$read_tokens,\"write_bytes\":$write_bytes,\"write_tokens_est\":$write_tokens}" \
  >> "$dir/steps.jsonl"
