#!/usr/bin/env python3
"""Read one harness run and say what happened.

Three log sources, because no one of them can answer the question on its own:

  cline.jsonl  the agent event stream: what it did, what it spent
  cline.log    the runtime's own diagnostics: output caps, discarded turns,
               the condenser, the retry ladder
  ollama.log   the server's side: how the generation actually ended, and
               whether the thinking budget fired

The question the harness exists to answer is whether a run that edits the file
also checks it, and what the thinking budget did on the way. So the summary
leads with the tool sequence and the budget, not with the token counts.
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BUDGET_MARK = "I have used my thinking budget"

# Tools that change a file, and tools that look at one afterwards. The CLI host
# ships none of the latter -- `check_file` lives in the VS Code extension -- so
# `check_calls` is expected to be zero here and is reported rather than judged.
EDIT_TOOLS = {"editor", "apply_patch", "write_file", "write_to_file", "replace_in_file"}
CHECK_TOOLS = {"check_file", "lsp", "linter", "get_diagnostics"}


def read_jsonl(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def read_tool_calls(run):
    """The tool sequence, read from the session rather than the event stream.

    The CLI's `--json` stream emits a `tool_call` hook event per call but does
    not name the tool, so the name has to come from the persisted conversation.
    Each entry is (name, input) because "did it check what it edited" is a
    question about paths, not just about counts.
    """
    calls = []
    for path in sorted(run.glob("state/sessions/*/*.messages.json")):
        try:
            data = json.loads(path.read_text(errors="replace"))
        except (json.JSONDecodeError, OSError):
            continue
        messages = data if isinstance(data, list) else data.get("messages", [])
        for message in messages:
            if not isinstance(message, dict):
                continue
            for part in message.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    calls.append((part.get("name"), part.get("input")))
    return calls


def analyse_events(records):
    """Reasoning volume, spend and the run's own verdict."""
    reasoning, texts = [], []
    result = {}
    for rec in records:
        if rec.get("type") == "run_result":
            result = rec
            continue
        event = rec.get("event") or {}
        kind = event.get("type")
        if kind == "content_end":
            if event.get("contentType") == "reasoning":
                reasoning.append(event.get("reasoning") or "")
            elif event.get("contentType") == "text":
                texts.append(event.get("text") or "")
    usage = result.get("usage") or {}
    return {
        "finish_reason": result.get("finishReason"),
        "iterations": result.get("iterations"),
        "duration_s": round((result.get("durationMs") or 0) / 1000, 1),
        "input_tokens": usage.get("inputTokens"),
        "output_tokens": usage.get("outputTokens"),
        "final_text": (result.get("text") or "")[:400],
        "reasoning_blocks": len(reasoning),
        "reasoning_chars": sum(len(r) for r in reasoning),
        "budget_hits": sum(r.count(BUDGET_MARK) for r in reasoning),
        "assistant_chars": sum(len(t) for t in texts),
    }


# Runtime diagnostics worth counting, and the label each gets in the summary.
CLINE_PATTERNS = {
    "output_limit_discards": r"Discarded a turn cut off at the output limit",
    "condensed_discards": r"Condensed \d+ chars of discarded reasoning",
    "uncondensed_discards": r"Discarded turn (?:not condensed|had nothing|was not condensed)",
    "retries_on_reduced_cap": r"Retrying a truncated turn on a reduced output cap",
    "capped_thinking_condensed": r"Condensed capped thinking",
    "capped_thinking_reused": r"Reused the condensed note",
}


def analyse_cline_log(path):
    out = {key: 0 for key in CLINE_PATTERNS}
    out["errors"] = []
    caps = []
    if not path.exists():
        return out
    for line in path.read_text(errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("msg") or ""
        for key, pattern in CLINE_PATTERNS.items():
            if re.search(pattern, msg):
                out[key] += 1
        found = re.search(r"Resolved output cap (\S+)", msg)
        if found:
            caps.append(found.group(1))
        if rec.get("level", 0) >= 50:
            out["errors"].append(msg[:200])
    out["output_caps"] = caps
    out["errors"] = out["errors"][:5]
    return out


def analyse_ollama_log(path):
    """What the budget sampler did, from the server's own log.

    Two fields here read the log for strings it has never contained. The
    sampler logs under a source name ollama truncates to `common_reaso:`, so
    `reasoning[_ ]budget` matched nothing and `budget_events` was 0 on every run
    ever analysed -- including the one run that ended FIXED, whose log holds four
    line-boundary cuts and three grace expiries. And `eval_count=` is not in the
    server log at any verbosity: token counts come back in the API response, so
    the cline side already carries them as input_tokens/output_tokens and this
    field could only ever be empty.

    So the budget is counted by the messages the sampler actually writes, split
    by how each block ended, and eval_counts is gone rather than left looking
    like a measurement.
    """
    out = {
        "done_reasons": {},
        "budget_activations": 0,
        "budget_forced": 0,
        "budget_forced_at_line": 0,
        "budget_forced_immediately": 0,
        "budget_forced_after_wait": 0,
        "budget_forced_mid_line": 0,
        "budget_natural_ends": 0,
        "budget_resets": 0,
        "context_shifts": 0,
        "errors": [],
    }
    if not path.exists():
        return out
    text = path.read_text(errors="replace")
    for reason in re.findall(r"done_reason=(\w+)", text):
        out["done_reasons"][reason] = out["done_reasons"].get(reason, 0) + 1
    # The sampler's own vocabulary. `budget exhausted` is the only one that means
    # the block was cut; the rest describe a budget that was never spent.
    #
    # Three wordings, not two. The sampler logs the bare message when it did not
    # have to wait at all -- the budget expired with the model already on a line
    # boundary -- and names the wait only when the wait changed where the cut
    # landed. So the bare form is a clean cut, not an unclassified one, and a
    # partition into "waited" and "gave up" loses it: run 0002 reported 10 cuts
    # as 7 + 2.
    out["budget_activations"] = len(re.findall(r"activated, budget=", text))
    out["budget_forced"] = len(re.findall(r"budget exhausted, forcing end sequence", text))
    out["budget_forced_after_wait"] = len(re.findall(r"forcing end sequence \(line boundary", text))
    out["budget_forced_mid_line"] = len(re.findall(r"forcing end sequence \(no line boundary", text))
    out["budget_forced_immediately"] = (
        out["budget_forced"] - out["budget_forced_after_wait"] - out["budget_forced_mid_line"]
    )
    # The number the line-boundary patch exists to move: cuts that landed at the
    # end of a line, however they got there.
    out["budget_forced_at_line"] = out["budget_forced_immediately"] + out["budget_forced_after_wait"]
    out["budget_natural_ends"] = len(re.findall(r"deactivated \(natural end\)", text))
    out["budget_resets"] = len(re.findall(r"reset sequence seen, forgiving", text))
    out["context_shifts"] = len(re.findall(r"context shift|shifting kv cache", text, re.I))
    for line in text.splitlines():
        if re.search(r"level=ERROR|panic:", line):
            out["errors"].append(line[-200:])
    out["errors"] = out["errors"][:5]
    return out


SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.S | re.I)


def check_html(path):
    """Did the edits leave valid JavaScript behind?

    The failure this whole exercise came from was sixteen problems in the file
    after four unchecked edits, so a run is not "successful" because it ended
    cleanly -- the file has to still parse.
    """
    if not path.exists():
        return {"exists": False}
    source = path.read_text(errors="replace")
    blocks = [b for b in SCRIPT_RE.findall(source) if b.strip()]
    errors = []
    for index, block in enumerate(blocks):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
            handle.write(block)
            temp = handle.name
        try:
            proc = subprocess.run(
                ["node", "--check", temp], capture_output=True, text=True, timeout=30
            )
            if proc.returncode != 0:
                first = next(
                    (ln for ln in proc.stderr.splitlines() if "Error" in ln), ""
                )
                errors.append(f"script[{index}]: {first.strip()[:160]}")
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            errors.append(f"script[{index}]: check failed: {exc}")
        finally:
            Path(temp).unlink(missing_ok=True)
    return {
        "exists": True,
        "bytes": len(source),
        "script_blocks": len(blocks),
        "js_syntax_errors": errors,
    }


def smoke(path):
    """Run the page headless and see whether the game actually ticks.

    Parsing is not the bar. The pristine test source parses too -- its defect is
    a `class Level` body that closes early plus two dozen functions that are
    called and never defined, and nothing but execution finds that.
    """
    if not path.exists():
        return {"ok": False, "error": "no file", "frames_run": 0}
    script = Path(__file__).with_name("smoke.js")
    try:
        proc = subprocess.run(
            ["node", str(script), str(path), "30"],
            capture_output=True,
            text=True,
            timeout=90,
        )
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, json.JSONDecodeError, IndexError, OSError) as exc:
        return {"ok": False, "error": f"smoke failed: {exc}", "frames_run": 0}


def main():
    run = Path(sys.argv[1])
    events = analyse_events(read_jsonl(run / "cline.jsonl"))
    cline = analyse_cline_log(run / "cline.log")
    ollama = analyse_ollama_log(run / "ollama.log")
    before = run / "manic_miner.before.html"
    after = run / "manic_miner.after.html"
    html = check_html(after)
    html["changed"] = (
        before.exists()
        and after.exists()
        and before.read_bytes() != after.read_bytes()
    )

    ran = smoke(after)
    calls = read_tool_calls(run)
    tools = [name for name, _ in calls]
    edits = [n for n in tools if n in EDIT_TOOLS]
    checks = [n for n in tools if n in CHECK_TOOLS]
    summary = {
        "run": run.name,
        **events,
        "tools": tools,
        "tool_sequence": " -> ".join(tools),
        "edit_calls": len(edits),
        "check_calls": len(checks),
        # Not a defect on this host by itself: the CLI toolset has no
        # `check_file` (it is a VS Code extension tool), so the edit
        # verification guard has no checker to name and stands aside.
        "edited_without_check": len(edits) > 0 and len(checks) == 0,
        "cline": cline,
        "ollama": ollama,
        "html": html,
        "smoke": ran,
        # The only success condition that matters: the page runs.
        "fixed": bool(ran.get("ok")),
    }
    (run / "summary.json").write_text(json.dumps(summary, indent=2))

    js_errors = html.get("js_syntax_errors") or []
    verdict = "FIXED" if ran.get("ok") else "broken"
    print(
        f"{run.name}  {verdict}  finish={events['finish_reason']} "
        f"iters={events['iterations']} {events['duration_s']}s "
        f"tools={len(tools)} (edit={len(edits)} check={len(checks)}) "
        f"budget_hits={events['budget_hits']} "
        f"cuts={ollama['budget_forced']}"
        f"({ollama['budget_forced_at_line']}line/{ollama['budget_forced_mid_line']}mid) "
        f"discards={cline['output_limit_discards']} "
        f"retries={cline['retries_on_reduced_cap']} "
        f"js_errors={len(js_errors)} "
        f"changed={html['changed']} frames={ran.get('frames_run')}"
    )
    if not ran.get("ok"):
        print(f"    why: {ran.get('error')}")
    for err in js_errors[:3]:
        print(f"    {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
