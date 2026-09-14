#!/usr/bin/env python3
"""Drop the `accumulated` field from streamed text deltas as run.jsonl is written.

The CLI emits one content_start per text token, and each one carries
`accumulated` -- the whole block so far. Log bytes therefore grow with the
SQUARE of block length: a single 42,313-char answer produced 829 MB of the
843 MB in run 20260907-181956-0004 (47,567 text deltas averaging 18 KB each,
against 148 B for a reasoning delta, which carries only its own delta).

Nothing is lost that matters. `content_end` still carries the full block, and
`text` on each delta still carries the increment, so the block is
reconstructible either way. Only a block that never ends -- an aborted or
in-flight turn -- loses its tail, which is the trade for not filling the disk.

Streaming and line-oriented: parse only lines that could contain the field.
"""
import json
import sys


def main() -> None:
    out = sys.stdout
    # Flush periodically: a run that gets killed still keeps almost all of its
    # log, which is how several of today's runs were diagnosed at all.
    n = 0
    for line in sys.stdin:
        n += 1
        if n % 1000 == 0:
            out.flush()
        if '"accumulated"' in line:
            try:
                obj = json.loads(line)
            except Exception:
                out.write(line)
                continue
            ev = obj.get("event") if isinstance(obj.get("event"), dict) else obj
            if isinstance(ev, dict) and ev.pop("accumulated", None) is not None:
                out.write(json.dumps(obj, separators=(",", ":")) + "\n")
                continue
            out.write(line)
        else:
            out.write(line)
    out.flush()


if __name__ == "__main__":
    main()
