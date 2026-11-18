"""Phase-0 pilot runner for Claude Code.

The runner prints the planned request count and token budget and does not
start ``claude`` unless ``--confirm`` is present. It never calls the
Anthropic API itself and it refuses to start if a console API key is set.
OAuth stays inside ``claude -p``.

Warm cells repeat the cold command in the same directory and are skipped
(not sent) when more than 60 seconds have passed since the cold process
exited. Mixed cells use ``--continue`` in that directory.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from hosted_agentperf.schema import EFFORT_PINNED, MODEL_PINNED

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ENV_TEMPLATE = PACKAGE_ROOT / "env" / "claude-code.pilot.env"
SETTINGS_FILE = PACKAGE_ROOT / "env" / "pilot-settings.json"
ADDON = PACKAGE_ROOT / "proxy" / "sse_timestamp.py"

CONSOLE_KEY_VARS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY",
)
WARM_WINDOW_S = 60.0
DEFAULT_SYSTEM_PROMPT_BUDGET = 25000


@dataclass(frozen=True)
class CallSpec:
    name: str
    mode: str
    user_tokens: int
    output_cap: int | None = None
    disable_prompt_caching: bool = False
    output_format: str = "text"
    prompt_kind: str = "ok"


def build_plan(proxy_repeats: int = 20, system_prompt_budget: int = DEFAULT_SYSTEM_PROMPT_BUDGET) -> dict:
    if proxy_repeats < 1:
        raise ValueError("proxy_repeats must be at least 1")
    calls = [CallSpec("proxy_short", "cold", user_tokens=40, prompt_kind="ok")]
    for _index in range(2, proxy_repeats + 1):
        calls.append(CallSpec("proxy_short", "warm", user_tokens=40, prompt_kind="ok"))
    calls.extend(
        [
            CallSpec("max_output", "cold", user_tokens=80, output_cap=512, prompt_kind="long"),
            CallSpec(
                "system_prompt",
                "cold",
                user_tokens=20,
                disable_prompt_caching=True,
                prompt_kind="ok",
            ),
            CallSpec("ttl_json", "cold", user_tokens=10, output_format="json", prompt_kind="hello"),
            CallSpec("quota_cold_32k", "cold", user_tokens=32000, prompt_kind="corpus"),
            CallSpec("quota_warm_32k", "warm", user_tokens=32000, prompt_kind="corpus"),
            CallSpec("mixed_1k", "mixed", user_tokens=1024, prompt_kind="corpus"),
        ]
    )
    # Attach rep numbers for the proxy series.
    numbered: list[tuple[CallSpec, int]] = []
    proxy_rep = 0
    for spec in calls:
        if spec.name == "proxy_short":
            proxy_rep += 1
            numbered.append((spec, proxy_rep))
        else:
            numbered.append((spec, 1))

    cold_slots = sum(1 for spec, _rep in numbered if spec.mode == "cold" or spec.disable_prompt_caching)
    # Warm and mixed can also miss and pay a full prompt. Worst case counts every call.
    user_tokens = sum(spec.user_tokens for spec, _rep in numbered)
    expected_user = sum(
        spec.user_tokens
        for spec, _rep in numbered
        if spec.mode != "warm"
    )
    # Expected cache-hit case: warm user tokens are reads, not new.
    # Mixed still sends its new tail.
    worst_new = system_prompt_budget * len(numbered) + user_tokens
    expected_new = system_prompt_budget * cold_slots + expected_user
    return {
        "model": MODEL_PINNED,
        "effort": EFFORT_PINNED,
        "calls": [
            {
                "name": spec.name,
                "mode": spec.mode,
                "rep": rep,
                "user_tokens_estimate": spec.user_tokens,
                "output_cap": spec.output_cap,
                "disable_prompt_caching": spec.disable_prompt_caching,
                "output_format": spec.output_format,
                "prompt_kind": spec.prompt_kind,
            }
            for spec, rep in numbered
        ],
        "request_count": len(numbered),
        "system_prompt_budget_tokens": system_prompt_budget,
        "system_prompt_budget_is_measurement": False,
        "cold_system_prompt_slots": cold_slots,
        "user_text_tokens_estimate_chars_over_4": user_tokens,
        "expected_new_tokens_if_warm_hits": expected_new,
        "worst_case_new_tokens_if_every_request_misses": worst_new,
        "output_token_cap_note": (
            f"Only the max_output cell sets CLAUDE_CODE_MAX_OUTPUT_TOKENS=512. "
            f"Other cells are uncapped. Thinking cannot be disabled on {MODEL_PINNED}, "
            "so output tokens can exceed the visible reply."
        ),
    }


def format_plan(plan: dict) -> str:
    lines = [
        f"Planned Claude Code requests: {plan['request_count']}",
        f"Pinned model: {plan['model']}",
        f"Pinned effort: {plan['effort']}",
        "User-text size is a chars/4 estimate, not the model tokenizer.",
        (
            f"System-prompt budget per request that misses cache: "
            f"{plan['system_prompt_budget_tokens']} tokens. "
            "This is a ceiling you are confirming, not a measurement."
        ),
        f"Cold slots that pay that budget when cache works: {plan['cold_system_prompt_slots']}",
        f"Expected new tokens if warm requests hit cache: {plan['expected_new_tokens_if_warm_hits']}",
        (
            "Worst-case new tokens if every request misses cache: "
            f"{plan['worst_case_new_tokens_if_every_request_misses']}"
        ),
        plan["output_token_cap_note"],
        "The twenty proxy-offset requests dominate the worst case, because each one can pay the system prompt.",
        "No request is sent unless you pass --confirm.",
        "Calls:",
    ]
    for call in plan["calls"]:
        lines.append(
            f"  {call['name']} rep={call['rep']} mode={call['mode']} "
            f"user_tokens~{call['user_tokens_estimate']} format={call['output_format']}"
        )
    return "\n".join(lines) + "\n"


def console_key_present(env: dict | None = None) -> list[str]:
    source = os.environ if env is None else env
    return [name for name in CONSOLE_KEY_VARS if str(source.get(name) or "").strip()]


def claude_argv(
    claude_bin: str,
    settings: Path,
    prompt: str,
    *,
    continue_session: bool = False,
    output_format: str = "text",
    max_turns: int = 1,
) -> list[str]:
    argv = [
        claude_bin,
        "--restricted",
        "-p",
        "--max-turns",
        str(max_turns),
        "--model",
        MODEL_PINNED,
        "--effort",
        EFFORT_PINNED,
        "--tools",
        "",
        "--disallowed-tools",
        "*",
        "mcp__*",
        "--strict-mcp-config",
        "--settings",
        str(settings),
        "--output-format",
        output_format,
    ]
    if continue_session:
        argv.append("--continue")
    argv.append(prompt)
    return argv


def child_env(work: Path, base: dict | None = None, extra: dict | None = None) -> dict:
    env = dict(os.environ if base is None else base)
    for name in CONSOLE_KEY_VARS:
        env.pop(name, None)
    for name in (
        "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
        "CLAUDE_CODE_SIMPLE",
        "ENABLE_BETA_TRACING_DETAILED",
        "BETA_TRACING_ENDPOINT",
        "CLAUDE_CODE_RETRY_WATCHDOG",
        "FORCE_PROMPT_CACHING_5M",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    ):
        env.pop(name, None)
    body_dir = work / "bodies"
    ca = work / "mitmproxy-ca" / "mitmproxy-ca-cert.pem"
    body_dir.mkdir(parents=True, exist_ok=True)
    locked = _load_env_template(ENV_TEMPLATE, {"HARNESS_BODY_DIR": str(body_dir), "HARNESS_MITM_CA": str(ca)})
    env.update(locked)
    env["https_proxy"] = locked.get("HTTPS_PROXY", "http://127.0.0.1:8080")
    env["HTTPS_PROXY"] = env["https_proxy"]
    env["http_proxy"] = env["https_proxy"]
    env["HTTP_PROXY"] = env["https_proxy"]
    env["no_proxy"] = "127.0.0.1,localhost"
    env["NO_PROXY"] = env["no_proxy"]
    env["HARNESS_PROXY_DIR"] = str(work / "proxy")
    env["HARNESS_PHASE"] = "0"
    if extra:
        env.update(extra)
    return env


def _load_env_template(path: Path, substitutions: dict[str, str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        for name, replacement in substitutions.items():
            value = value.replace("${" + name + "}", replacement)
        values[key.strip()] = value
    return values


def estimate_tokens(text: str) -> int:
    """Character budget. Four characters per token. Not the model tokenizer."""
    return max(1, (len(text) + 3) // 4)


def neutral_corpus(n_tokens: int) -> str:
    line = "Line {n:06d}. Neutral measurement text for a hosted-agent benchmark corpus.\n"
    unit = estimate_tokens(line.format(n=0))
    count = max(1, (n_tokens + unit - 1) // unit)
    parts = [line.format(n=index) for index in range(count)]
    text = "".join(parts)
    # Trim to the requested estimate without cutting a line in half when possible.
    while estimate_tokens(text) > n_tokens and parts:
        parts.pop()
        text = "".join(parts)
    while estimate_tokens(text) < n_tokens:
        text += line.format(n=len(parts))
        parts.append(line)
    return text


def build_prompt(kind: str, nonce: str, user_tokens: int) -> str:
    if kind == "hello":
        body = "hello"
    elif kind == "long":
        body = (
            "Write the numbers from 1 to 3000 in words, separated by commas, "
            "with no commentary before or after the list."
        )
    elif kind == "corpus":
        body = neutral_corpus(user_tokens)
    else:
        body = "Reply with only OK."
    return (
        "Reply with only OK.\n\n"
        f"nonce: {nonce}\n\n"
        "The block below is neutral filler used to set the prompt length. "
        "It is not a task.\n\n"
        "----- corpus -----\n"
        f"{body}\n"
        "----- end -----\n"
    )


def assert_work_dir(path: Path) -> None:
    resolved = path.resolve()
    claude_home = (Path.home() / ".claude").resolve()
    if resolved == claude_home or claude_home in resolved.parents:
        raise SystemExit(f"Refusing to use {resolved}: it is inside ~/.claude")


def _which_claude(explicit: str) -> str:
    if explicit:
        return explicit
    candidate = Path.home() / ".local" / "bin" / "claude"
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    found = shutil.which("claude")
    if found:
        return found
    raise SystemExit("claude was not found at ~/.local/bin/claude or on PATH")


def _read_version(claude_bin: str) -> str:
    try:
        completed = subprocess.run(
            [claude_bin, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"unavailable: {exc}"
    return (completed.stdout or completed.stderr or "").strip()


def _host_facts() -> dict:
    facts = {"uname": os.uname().sysname + " " + os.uname().release + " " + os.uname().machine}
    try:
        facts["nproc"] = os.cpu_count()
    except OSError:
        pass
    meminfo = Path("/proc/meminfo")
    if meminfo.is_file():
        for line in meminfo.read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                facts["mem_total"] = line.split(":", 1)[1].strip()
                break
    return facts


def run_pilot(
    work: Path,
    *,
    confirm: bool,
    system_prompt_budget: int,
    proxy_repeats: int,
    claude_bin: str,
    mitmdump: str,
    start_services: bool,
    usage_recorded: bool,
    runner=None,
) -> int:
    """Execute the checklist. ``runner`` is a test seam; the default spawns processes."""
    work = work.resolve()
    assert_work_dir(work)
    plan = build_plan(proxy_repeats, system_prompt_budget)
    text = format_plan(plan)
    sys.stdout.write(text)
    work.mkdir(parents=True, exist_ok=True)
    (work / "plan.txt").write_text(text, encoding="utf-8")
    if not confirm:
        sys.stdout.write("Not sent: pass --confirm after reading the plan.\n")
        return 2
    present = console_key_present()
    if present:
        sys.stdout.write(
            "Refusing to start. Unset console credential variables before claude -p: "
            + ", ".join(present)
            + "\n"
        )
        return 2
    if not SETTINGS_FILE.is_file():
        raise SystemExit(f"Missing settings file {SETTINGS_FILE}")
    version = _read_version(claude_bin)
    meta = {
        "target": "claude_code",
        "phase": "0",
        "block": "pilot",
        "model_pinned": MODEL_PINNED,
        "effort": EFFORT_PINNED,
        "agent_version": version,
        "host": _host_facts(),
        "system_prompt_budget_tokens": system_prompt_budget,
    }
    (work / "run_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    if "2.1.312" not in version:
        sys.stdout.write(
            "Warning: this lock was written against Claude Code 2.1.312 and docs dated 2026-10-29. "
            f"This binary reported: {version!r}. Re-read the docs before a real campaign.\n"
        )
    services = _Services(work, mitmdump, start_services)
    services.start()
    checks: dict = {"version": version, "calls": [], "skipped": []}
    try:
        env = child_env(work)
        _run_calls(work, plan, claude_bin, env, checks, usage_recorded, runner)
    finally:
        services.stop()
    (work / "pilot_checks.json").write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
    from hosted_agentperf.join import join_directory

    rows = join_directory(work, work / "requests.csv")
    offset = [
        float(row["proxy_offset_ms"])
        for row in rows
        if str(row.get("proxy_offset_ms") or "") not in {"", "None"}
    ]
    if offset:
        checks["proxy_offset_mean_ms"] = sum(offset) / len(offset)
        checks["proxy_offset_n"] = len(offset)
    (work / "pilot_checks.json").write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
    off = [row for row in rows if str(row.get("off_thread") or "") == "1"]
    if off:
        sys.stdout.write(f"Off-thread requests: {len(off)}. See requests.csv.\n")
        return 3
    sys.stdout.write(f"Wrote {work / 'requests.csv'} ({len(rows)} rows).\n")
    return 0


def _run_calls(work, plan, claude_bin, env, checks, usage_recorded, runner) -> None:
    sessions = work / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    cold_dir: Path | None = None
    cold_nonce = ""
    cold_finished = 0.0
    measured_system: int | None = None
    usage_gate_done = False
    for call in plan["calls"]:
        if call["name"] in {"quota_cold_32k", "quota_warm_32k", "mixed_1k"}:
            if measured_system is not None and measured_system > plan["system_prompt_budget_tokens"]:
                checks["skipped"].append(
                    {
                        "name": call["name"],
                        "reason": "measured uncached prompt exceeds the confirmed system-prompt budget",
                        "measured_input_tokens": measured_system,
                    }
                )
                continue
            if not usage_gate_done:
                _usage_gate(usage_recorded)
                usage_gate_done = True
        if call["mode"] == "warm":
            if cold_dir is None:
                checks["skipped"].append({"name": call["name"], "rep": call["rep"], "reason": "no cold directory"})
                continue
            if call["name"] == "quota_warm_32k" and (time.monotonic() - cold_finished) > WARM_WINDOW_S:
                checks["skipped"].append(
                    {"name": call["name"], "reason": "more than 60s after the cold process exited; not sent"}
                )
                continue
            directory = cold_dir
            nonce = cold_nonce
            continue_session = False
        elif call["mode"] == "mixed":
            if cold_dir is None:
                checks["skipped"].append({"name": call["name"], "reason": "no session to continue"})
                continue
            directory = cold_dir
            nonce = secrets.token_hex(32)
            continue_session = True
        else:
            directory = Path(secrets.token_hex(8))
            directory = sessions / f"{call['name']}-{call['rep']}-{directory.name}"
            directory.mkdir(parents=True)
            nonce = secrets.token_hex(32)
            cold_dir = directory
            cold_nonce = nonce
            continue_session = False
        prompt = build_prompt(call["prompt_kind"], nonce, call["user_tokens_estimate"])
        extra = {}
        if call["output_cap"]:
            extra["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(call["output_cap"])
        if call["disable_prompt_caching"]:
            extra["DISABLE_PROMPT_CACHING"] = "1"
        call_env = dict(env)
        call_env.update(extra)
        argv = claude_argv(
            claude_bin,
            SETTINGS_FILE,
            prompt,
            continue_session=continue_session,
            output_format=call["output_format"],
        )
        record = {
            "name": call["name"],
            "cell": call["name"],
            "phase": "0",
            "block": "pilot",
            "rep": call["rep"],
            "mode": call["mode"],
            "nonce": nonce,
            "cwd": str(directory),
            "session_id": directory.name,
        }
        start = time.time()
        record["t_start_unix_ms"] = start * 1000.0
        sys.stdout.write(f"Sending {call['name']} rep={call['rep']} mode={call['mode']}\n")
        completed = _invoke(argv, directory, call_env, runner)
        end = time.time()
        record["t_end_unix_ms"] = end * 1000.0
        record["returncode"] = completed.returncode
        if call["mode"] == "cold":
            cold_finished = time.monotonic()
        stdout_path = work / "claude_stdout" / f"{call['name']}-rep{call['rep']}.txt"
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        (stdout_path.with_suffix(".err")).write_text(completed.stderr or "", encoding="utf-8")
        if call["name"] == "system_prompt":
            measured_system = _proxy_input_tokens(work, nonce) or _extract_input_tokens(completed.stdout or "")
            checks["uncached_ok_input_tokens"] = measured_system
        if call["name"] == "ttl_json":
            checks["ttl"] = _extract_cache_creation(completed.stdout or "")
        if call["name"] == "max_output":
            checks["max_output_returncode"] = completed.returncode
        _append_jsonl(work / "cells.jsonl", record)
        checks["calls"].append({key: record[key] for key in ("name", "rep", "mode", "returncode")})


def _invoke(argv, directory, env, runner):
    if runner is not None:
        return runner(argv, directory, env)
    completed = subprocess.run(
        argv,
        cwd=directory,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    return completed


def _usage_gate(usage_recorded: bool) -> None:
    sys.stdout.write(
        "Record /usage in a separate interactive claude session before the 32k cells.\n"
        "Do not change ~/.claude/settings.json. The pilot does not read OAuth itself.\n"
    )
    if usage_recorded:
        return
    if not sys.stdin.isatty():
        raise SystemExit("Non-interactive run: pass --usage-recorded after you have written down /usage.")
    input("Press Enter after /usage is recorded. ")


def _proxy_input_tokens(work: Path, nonce: str) -> int | None:
    path = work / "proxy" / "requests.jsonl"
    if not path.is_file():
        return None
    found = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        body_path = row.get("body_path")
        if not body_path or not Path(str(body_path)).is_file():
            continue
        if nonce not in Path(str(body_path)).read_text(encoding="utf-8", errors="replace"):
            continue
        value = row.get("input_tokens")
        if isinstance(value, int):
            found = value
    return found


def _extract_input_tokens(stdout: str) -> int | None:
    payload = _parse_json_blob(stdout)
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage")
    if isinstance(usage, dict) and isinstance(usage.get("input_tokens"), int):
        return usage["input_tokens"]
    return None


def _extract_cache_creation(stdout: str) -> dict:
    payload = _parse_json_blob(stdout)
    found = {}

    def walk(node) -> None:
        if isinstance(node, dict):
            if "ephemeral_1h_input_tokens" in node or "ephemeral_5m_input_tokens" in node:
                found["ephemeral_1h_input_tokens"] = node.get("ephemeral_1h_input_tokens")
                found["ephemeral_5m_input_tokens"] = node.get("ephemeral_5m_input_tokens")
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(payload)
    return found


def _parse_json_blob(stdout: str):
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                return None
    return None


def _append_jsonl(path: Path, row: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


class _Services:
    def __init__(self, work: Path, mitmdump: str, start: bool) -> None:
        self.work = work
        self.mitmdump = mitmdump
        self.start = start
        self.processes: list[subprocess.Popen] = []

    def start_procs(self) -> None:
        if not self.start:
            return
        otel_dir = self.work / "otel"
        otel_dir.mkdir(parents=True, exist_ok=True)
        proxy_dir = self.work / "proxy"
        proxy_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["HARNESS_PROXY_DIR"] = str(proxy_dir)
        collector = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "hosted_agentperf.otel_collector",
                "--dir",
                str(otel_dir),
            ],
            cwd=str(PACKAGE_ROOT),
            env={**env, "PYTHONPATH": str(PACKAGE_ROOT)},
        )
        self.processes.append(collector)
        if not self.mitmdump:
            raise SystemExit("Pass --mitmdump pointing at the venv mitmdump binary, or pass --no-start-services.")
        ca_dir = self.work / "mitmproxy-ca"
        ca_dir.mkdir(parents=True, exist_ok=True)
        proxy = subprocess.Popen(
            [
                self.mitmdump,
                "--listen-host",
                "127.0.0.1",
                "--listen-port",
                "8080",
                "--set",
                f"confdir={ca_dir}",
                "-s",
                str(ADDON),
            ],
            env=env,
        )
        self.processes.append(proxy)
        time.sleep(0.5)

    def start(self) -> None:
        self.start_procs()

    def stop(self) -> None:
        for process in self.processes:
            process.terminate()
        for process in self.processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Phase-0 Claude Code pilot")
    parser.add_argument("command", choices=["plan", "run"])
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--work-dir", default="")
    parser.add_argument("--system-prompt-budget", type=int, default=DEFAULT_SYSTEM_PROMPT_BUDGET)
    parser.add_argument("--proxy-repeats", type=int, default=20)
    parser.add_argument("--claude", default="")
    parser.add_argument("--mitmdump", default="")
    parser.add_argument("--no-start-services", action="store_true")
    parser.add_argument("--usage-recorded", action="store_true")
    args = parser.parse_args(argv)
    plan = build_plan(args.proxy_repeats, args.system_prompt_budget)
    if args.command == "plan":
        sys.stdout.write(format_plan(plan))
        return 0
    if not args.work_dir:
        raise SystemExit("--work-dir is required for run")
    if not args.confirm:
        return run_pilot(
            Path(args.work_dir),
            confirm=False,
            system_prompt_budget=args.system_prompt_budget,
            proxy_repeats=args.proxy_repeats,
            claude_bin=args.claude or "claude",
            mitmdump=args.mitmdump,
            start_services=False,
            usage_recorded=args.usage_recorded,
        )
    return run_pilot(
        Path(args.work_dir),
        confirm=True,
        system_prompt_budget=args.system_prompt_budget,
        proxy_repeats=args.proxy_repeats,
        claude_bin=_which_claude(args.claude),
        mitmdump=args.mitmdump,
        start_services=not args.no_start_services,
        usage_recorded=args.usage_recorded,
    )


if __name__ == "__main__":
    raise SystemExit(main())
