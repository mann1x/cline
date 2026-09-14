#!/usr/bin/env python3
"""Per-run thinking-volume stats, one method for every arm.

Reasoning is read from content_end/contentType=reasoning, which carries the
whole block; the per-token content_start events are only a stream of the same
text and counting both would double it. Handles .gz because native.sh gzips a
run.jsonl once six newer runs exist.
"""
import glob, gzip, json, os, statistics, sys

H = "/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"


def opener(path):
    return gzip.open(path, "rt", errors="replace") if path.endswith(".gz") \
        else open(path, errors="replace")


def stats(run_dir):
    path = os.path.join(run_dir, "run.jsonl")
    if not os.path.exists(path):
        path += ".gz"
    if not os.path.exists(path):
        return None
    blocks, text, tools, iters = [], 0, [], 0
    chunk_reasoning = 0
    kept = discarded = empty = 0
    with opener(path) as handle:
        for line in handle:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            ev = rec.get("event") if isinstance(rec.get("event"), dict) else rec
            t = ev.get("type")
            if t == "iteration_start":
                iters = max(iters, ev.get("iteration", 0))
            elif t == "content_start" and ev.get("contentType") == "reasoning":
                chunk_reasoning += len(ev.get("reasoning") or "")
            elif t == "content_end":
                ct = ev.get("contentType")
                if ct == "reasoning":
                    blocks.append(len(ev.get("reasoning") or ""))
                elif ct == "text":
                    text += len(ev.get("text") or "")
                elif ct == "tool":
                    tools.append(ev.get("toolName") or "?")
            elif t == "notice":
                meta = ev.get("metadata") or {}
                if meta.get("kind") == "atomic_transaction":
                    if meta.get("kept"): kept += 1
                    else: discarded += 1
                elif meta.get("kind") == "atomic_empty_attempt":
                    empty += 1
    return {
        "blocks": len(blocks),
        "think": sum(blocks),
        "think_stream": chunk_reasoning,
        "median_block": int(statistics.median(blocks)) if blocks else 0,
        "max_block": max(blocks) if blocks else 0,
        "text": text,
        "tools": len(tools),
        "iters": iters,
        "kept": kept, "discarded": discarded, "empty": empty,
    }


def wall(run_dir):
    try:
        for tok in open(os.path.join(run_dir, "exit.txt")).read().split():
            if tok.startswith("wall="):
                return int(tok[5:].rstrip("s"))
    except OSError:
        pass
    return None


if __name__ == "__main__":
    print(f"{'run':6s} {'wall':>6s} {'iters':>5s} {'blks':>5s} {'thinkKch':>9s} "
          f"{'medBlk':>7s} {'maxBlk':>7s} {'textKch':>8s} {'tools':>5s} {'k/d/e':>7s} {'stream=block':>13s}")
    for index in sys.argv[1:]:
        # Only real run dirs: native.sh names them by timestamp, and the
        # abandoned 110k experiments sit beside them as "aborted-*-0056",
        # which a "*-{index}" glob happily returns and sorts LAST.
        dirs = [d for d in glob.glob(os.path.join(H, "runs-native", f"2*-{index}"))
                if os.path.exists(os.path.join(d, "exit.txt"))]
        if not dirs:
            print(f"{index}  <no completed run dir>"); continue
        run_dir = sorted(dirs)[-1]
        s = stats(run_dir)
        if not s:
            print(f"{index}  <no run.jsonl>"); continue
        w = wall(run_dir)
        agree = "ok" if abs(s["think_stream"] - s["think"]) <= max(200, 0.02 * max(1, s["think"])) else \
                f"DIFF {s['think_stream']/1000:.0f}K"
        print(f"{index:6s} {str(w or '--'):>6s} {s['iters']:5d} {s['blocks']:5d} "
              f"{s['think']/1000:9.1f} {s['median_block']:7d} {s['max_block']:7d} "
              f"{s['text']/1000:8.1f} {s['tools']:5d} "
              f"{s['kept']}/{s['discarded']}/{s['empty']:>1} {agree:>13s}")
