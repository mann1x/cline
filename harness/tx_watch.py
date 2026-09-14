#!/usr/bin/env python3
"""Emit one line per closed transaction, per run verdict, and on any way the
batch can stop.

The harness only writes transactions.txt when a run ends, so a transaction that
closes mid-run is invisible there. The live record is the CLI's own event
stream: run.jsonl carries an `atomic_transaction` event the moment the oracle
decides, with metadata.kept saying whether the change survived. This reads that
file incrementally -- it reaches millions of events on a long run, and
re-parsing it every poll would cost more than the run.

Silence is not success, so it also emits on the ways the batch can end without
a verdict: the loop disappearing, and the transcript going quiet for half an
hour while the loop is still alive.
"""
import glob
import json
import os
import subprocess
import sys
import time

H = "/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
FIRST = 86          # omnimerge-v4 IQ2_M arm (0086-0095)
EXPECTED = 10
STALE_AFTER = 1800  # seconds of no new events while the loop is still running

offsets = {}        # run.jsonl path -> bytes consumed
tx_seen = {}        # run name -> transactions already reported
verdicts_off = 0
last_growth = time.time()
stale_reported = False
verdicts_seen = 0


def emit(line):
    print(line, flush=True)


def harness_alive():
    return subprocess.run(
        ["pgrep", "-f", "[n]ative.sh"], capture_output=True
    ).returncode == 0


def run_dirs():
    out = []
    for path in sorted(glob.glob(os.path.join(H, "runs-native", "2*"))):
        try:
            index = int(path.rsplit("-", 1)[1])
        except (IndexError, ValueError):
            continue
        if index >= FIRST:
            out.append(path)
    return out


# Start from the end of verdicts-native.txt: earlier lines belong to the coderx
# batch and are not news.
verdicts_path = os.path.join(H, "verdicts-native.txt")
if os.path.exists(verdicts_path):
    verdicts_off = os.path.getsize(verdicts_path)

emit(f"tx-watch armed: runs {FIRST:04d}+ under {H}/runs-native")

while True:
    grew = False

    for run_dir in run_dirs():
        name = os.path.basename(run_dir)
        jsonl = os.path.join(run_dir, "run.jsonl")
        if not os.path.exists(jsonl):
            continue
        size = os.path.getsize(jsonl)
        start = offsets.get(jsonl, 0)
        if size < start:            # truncated or replaced; start over
            start = 0
        if size > start:
            grew = True
            with open(jsonl, errors="replace") as handle:
                handle.seek(start)
                chunk = handle.read()
                offsets[jsonl] = start + len(chunk.encode("utf-8", "replace"))
            # A partial last line is re-read next poll rather than dropped.
            lines = chunk.split("\n")
            if not chunk.endswith("\n"):
                tail = lines.pop() if lines else ""
                offsets[jsonl] -= len(tail.encode("utf-8", "replace"))
            for line in lines:
                if '"atomic_transaction"' not in line and '"atomic_empty_attempt"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                event = record.get("event") if isinstance(record.get("event"), dict) else record
                meta = event.get("metadata") or {}
                message = " ".join((event.get("message") or "").split())[:180]
                # An empty submission is not a transaction and is not numbered as
                # one: since the guard landed it costs nothing, so counting it
                # against the budget would misreport how much of the run is left.
                if meta.get("kind") == "atomic_empty_attempt":
                    ending = "" if meta.get("continued") else "  (run stopping)"
                    emit(f"{name[-4:]} empty submission in TX-{meta.get('transaction')}{ending} | {message}")
                    continue
                if meta.get("kind") != "atomic_transaction":
                    continue
                count = tx_seen.get(name, 0) + 1
                tx_seen[name] = count
                state = "kept" if meta.get("kept") else "discarded"
                emit(f"{name[-4:]} TX-{count:02d} {state} | {message}")

    if os.path.exists(verdicts_path):
        size = os.path.getsize(verdicts_path)
        if size > verdicts_off:
            with open(verdicts_path, errors="replace") as handle:
                handle.seek(verdicts_off)
                new = handle.read()
                verdicts_off += len(new.encode("utf-8", "replace"))
            for line in new.splitlines():
                if line.strip():
                    verdicts_seen += 1
                    emit(f"RUN DONE ({verdicts_seen}/{EXPECTED}) {line.strip()}")
            grew = True

    if grew:
        last_growth = time.time()
        stale_reported = False

    if verdicts_seen >= EXPECTED:
        emit(f"batch complete: {EXPECTED} runs finished")
        sys.exit(0)

    if not harness_alive():
        # Give a run that is between iterations a moment before calling it dead.
        time.sleep(20)
        if not harness_alive():
            emit(f"HARNESS GONE after {verdicts_seen}/{EXPECTED} runs -- no loop process")
            sys.exit(1)

    if not stale_reported and time.time() - last_growth > STALE_AFTER:
        stale_reported = True
        quiet = int((time.time() - last_growth) / 60)
        emit(f"STALLED: no new events for {quiet} min while the loop is alive")

    time.sleep(60)
