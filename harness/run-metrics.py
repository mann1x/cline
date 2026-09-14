#!/usr/bin/env python3
"""One row of comparable numbers per harness run.

Written because the interesting comparison stopped being pass/fail. Ornith
1.5 35B A3B thinks *less* per turn than a3b-coder and still burned 208
iterations without settling a transaction, which is coderx's signature and not
a3b-coder's. Total reasoning volume conflates those two; depth and turn count
have to be read apart, so both are here.

Handles run.jsonl and run.jsonl.gz. Reads `reasoning` content events -- not
`thinking`, which is what the SDK used to call them and what an earlier version
of this looked for, reporting a confident zero.

  ./run-metrics.py <run-dir> [<run-dir> ...]          table
  ./run-metrics.py --json <run-dir>                   one object per line
"""
import gzip
import json
import os
import statistics
import sys


def metrics(run_dir):
    path = os.path.join(run_dir, "run.jsonl")
    if not os.path.exists(path):
        path += ".gz"
    if not os.path.exists(path):
        return None
    opener = gzip.open if path.endswith(".gz") else open

    blocks, cur = [], 0
    iters = budget = out_tokens = text_chars = errors = compactions = 0
    tools = {}
    with opener(path, "rt", errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            event = record.get("event") or {}
            etype, ctype = event.get("type"), event.get("contentType")
            if etype == "iteration_start":
                iters += 1
            elif etype == "error":
                errors += 1
            elif etype == "notice" and "auto-compact" in json.dumps(event):
                compactions += 1
            if ctype == "tool" and etype == "content_start":
                name = event.get("toolName") or "?"
                tools[name] = tools.get(name, 0) + 1
            elif ctype == "reasoning" and etype == "content_start":
                cur += len(event.get("reasoning") or "")
            elif ctype == "reasoning" and etype == "content_end":
                if cur:
                    blocks.append(cur)
                cur = 0
            elif ctype == "text" and etype == "content_start":
                text_chars += len(event.get("text") or "")
            if etype == "usage":
                usage = event.get("usage") or event
                for key in ("outputTokens", "output_tokens", "completionTokens"):
                    if isinstance(usage.get(key), int):
                        out_tokens += usage[key]
                        break
            if "thinking budget" in line.lower():
                budget += 1
    if cur:
        blocks.append(cur)

    def field(name, path=os.path.join(run_dir, "build.txt")):
        try:
            for line in open(path, errors="replace"):
                for part in line.split():
                    if part.startswith(name + "="):
                        return part.split("=", 1)[1]
        except OSError:
            pass
        return ""

    verdict = wall = ""
    try:
        exit_line = open(os.path.join(run_dir, "exit.txt"), errors="replace").read()
        for part in exit_line.split():
            if part.startswith("verdict="):
                verdict = part.split("=", 1)[1]
            elif part.startswith("wall="):
                wall = part.split("=", 1)[1].rstrip("s")
    except OSError:
        verdict = "RUNNING"

    return {
        "run": os.path.basename(run_dir.rstrip("/")),
        "model": field("model"),
        "arm": field("arm"),
        "verdict": verdict,
        "wall_s": int(wall) if wall.isdigit() else None,
        "iterations": iters,
        "reasoning_blocks": len(blocks),
        "reasoning_chars": sum(blocks),
        "reasoning_mean": round(statistics.mean(blocks)) if blocks else 0,
        "reasoning_median": round(statistics.median(blocks)) if blocks else 0,
        "reasoning_max": max(blocks) if blocks else 0,
        "output_tokens": out_tokens,
        "text_chars": text_chars,
        "budget_hits": budget,
        "errors": errors,
        "compactions": compactions,
        "tools": tools,
    }


def main(argv):
    as_json = "--json" in argv
    dirs = [a for a in argv if not a.startswith("--")]
    rows = [m for m in (metrics(d) for d in dirs) if m]
    if as_json:
        for row in rows:
            print(json.dumps(row))
        return 0
    head = (
        f"{'run':22s} {'verdict':8s} {'wall':>6s} {'iters':>6s} "
        f"{'reason':>9s} {'mean':>7s} {'median':>7s} {'outTok':>9s} {'bud':>4s}"
    )
    print(head)
    for r in rows:
        print(
            f"{r['run']:22s} {r['verdict']:8s} "
            f"{(str(r['wall_s']) if r['wall_s'] else '-'):>6s} "
            f"{r['iterations']:6d} {r['reasoning_chars']:9,d} "
            f"{r['reasoning_mean']:7,d} {r['reasoning_median']:7,d} "
            f"{r['output_tokens']:9,d} {r['budget_hits']:4d}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
