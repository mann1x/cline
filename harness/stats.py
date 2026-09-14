#!/usr/bin/env python3
"""Statistics across harness runs, and how long the current streak is.

The target is 20 consecutive runs that end with the file fixed, so the streak
is the headline number and everything else is context for it. Timing is
reported as median and range rather than a mean: run durations here are
bounded below by the model and above by the retry ladder, and one 40-minute
outlier should not move the number anyone reads.

  ./stats.py [runs_dir]      all runs
  ./stats.py --last 20       the last 20 only
"""

import json
import statistics
import sys
from pathlib import Path


def load(runs_dir):
    out = []
    for run in sorted(runs_dir.glob("2*-[0-9][0-9][0-9][0-9]")):
        summary = run / "summary.json"
        if summary.exists():
            try:
                out.append(json.loads(summary.read_text()))
            except json.JSONDecodeError:
                pass
    return out


def describe(values, unit=""):
    if not values:
        return "n/a"
    if len(values) == 1:
        return f"{values[0]:.0f}{unit}"
    return (
        f"median {statistics.median(values):.0f}{unit}  "
        f"range {min(values):.0f}-{max(values):.0f}{unit}  "
        f"mean {statistics.fmean(values):.0f}{unit}"
    )


def streaks(runs):
    """Current and best run of consecutive fixes."""
    best = current = 0
    for run in runs:
        if run.get("fixed"):
            current += 1
            best = max(best, current)
        else:
            current = 0
    return current, best


def main():
    args = sys.argv[1:]
    limit = None
    if "--last" in args:
        index = args.index("--last")
        limit = int(args[index + 1])
        del args[index : index + 2]
    runs_dir = Path(args[0]) if args else Path(__file__).with_name("runs")

    runs = load(runs_dir)
    if limit:
        runs = runs[-limit:]
    if not runs:
        print("no analysed runs yet")
        return 0

    fixed = [r for r in runs if r.get("fixed")]
    current, best = streaks(runs)
    durations = [r["duration_s"] for r in runs if r.get("duration_s")]
    fixed_durations = [r["duration_s"] for r in fixed if r.get("duration_s")]

    print(f"runs analysed        {len(runs)}")
    print(f"fixed                {len(fixed)}/{len(runs)}  ({100 * len(fixed) / len(runs):.0f}%)")
    print(f"streak (current)     {current}   target 20")
    print(f"streak (best)        {best}")
    print()
    print(f"duration, all        {describe(durations, 's')}")
    print(f"duration, fixed only {describe(fixed_durations, 's')}")
    print(f"iterations           {describe([r['iterations'] for r in runs if r.get('iterations')])}")
    print(f"tool calls           {describe([len(r.get('tools') or []) for r in runs])}")
    print(f"edit calls           {describe([r.get('edit_calls', 0) for r in runs])}")
    print(f"output tokens        {describe([r['output_tokens'] for r in runs if r.get('output_tokens')])}")
    print(f"reasoning chars      {describe([r['reasoning_chars'] for r in runs if r.get('reasoning_chars') is not None])}")
    print(f"budget hits          {sum(r.get('budget_hits', 0) for r in runs)} total")
    print(
        f"output-limit discards {sum(r['cline'].get('output_limit_discards', 0) for r in runs)} total, "
        f"condensed {sum(r['cline'].get('condensed_discards', 0) for r in runs)}"
    )
    total = sum(durations)
    print(f"\nwall clock           {total / 3600:.1f}h over {len(runs)} runs")

    failures = {}
    for run in runs:
        if not run.get("fixed"):
            reason = (run.get("smoke") or {}).get("error") or "unknown"
            # Collapse the varying line/frame numbers so the shapes group.
            key = reason.split(":")[0].strip()
            failures[key] = failures.get(key, 0) + 1
    if failures:
        print("\nfailure shapes:")
        for reason, count in sorted(failures.items(), key=lambda kv: -kv[1]):
            print(f"  {count:3d}  {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
