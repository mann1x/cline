#!/usr/bin/env python3
"""Gate: prove a 27B harness tag carries the sourced param set exactly.

Replaces the old "byte-identical to ornith15-base-rp_tb:35b-high" gate, which is
no longer the right reference: the 35B base arm deliberately carries none of the
published params (user, 2026-09-09: "ornith 35b does not carry them ... but ours
must"), so comparing against it would now fail every 27B tag by design.

SOURCED, from the published model's own params layer, verbatim except num_ctx:
  {"draft_num_predict":3,"min_p":0,"num_ctx":32768,"presence_penalty":1.5,
   "repeat_penalty":1,"temperature":1,"top_k":20,"top_p":0.95}
num_ctx is 131072 and temperature 0.6 per the user's rulings, not the published
32768 / 1 -- 0.6/0.95/20 is Qwen's thinking-mode sampler and what the 35B base
arm and all 50 toolbench cells ran at.
OURS, which the official ornith lacks and whose absence is a known defect:
  RENDERER/PARSER qwen3.5, num_gpu 99, think_budget high + cap message.

Numerics are compared as floats: ollama may render 1 as "1" or "1.0" and a
string compare would flag that as a config difference when it is not one.
Order is ignored -- /api/show does not emit parameters in a stable order.

PRESENCE_PENALTY IS THE ONE VALUE THIS GATE NO LONGER PINS. It defaults to 1.5,
which is what every tag built after 2026-09-09 16:14 carries and therefore what
those arms must still be checked against. But 1.5 came from the published BASE
model's params layer, and ollama's published *coding* model for the same family
ships presence_penalty 0 -- as does `ornith15-base-rp_tb:35b-high` (8/10 FIXED)
and the qwen3.6 27B dense tag (8/8 FIXED), while the 1.5 tags went 2/11. The
`.pre-sourced-params` backup shows the 27B coder carried no presence_penalty at
all before that edit. So a tag built to test 0 is not a broken tag, and the gate
takes the expected value rather than refusing it:

  check_27b_config.py --presence-penalty 0 <endpoint> <tag>

usage: check_27b_config.py [--presence-penalty V] <endpoint> <tag> [<tag> ...]
       exit 0 = all match
"""
import json, subprocess, sys

NUMERIC = {
    "num_gpu": 99, "draft_num_predict": 3, "min_p": 0, "num_ctx": 131072,
    "presence_penalty": 1.5, "repeat_penalty": 1, "temperature": 0.6,
    "top_k": 20, "top_p": 0.95,
}
STRING = {"think_budget": "high"}
MSG_MUST_CONTAIN = "I have used my thinking budget"


def show(endpoint, tag):
    r = subprocess.run(["curl", "-s", "--max-time", "30", endpoint + "/api/show",
                        "-d", json.dumps({"name": tag})],
                       capture_output=True, text=True)
    return json.loads(r.stdout)


def params(d):
    """/api/show 'parameters' is 'key<spaces>value' lines; the budget message is
    a single line with escaped newlines, so a plain split is safe here."""
    out = {}
    for ln in (d.get("parameters") or "").splitlines():
        if not ln.strip():
            continue
        k, _, v = ln.strip().partition(" ")
        out[k] = v.strip().strip('"')
    return out


def check(endpoint, tag, numeric=NUMERIC):
    d = show(endpoint, tag)
    if "modelfile" not in d:
        print("FAIL %s: /api/show returned no modelfile" % tag)
        return False
    p = params(d)
    bad = []

    for k, want in numeric.items():
        if k not in p:
            bad.append("%s MISSING (want %s)" % (k, want))
            continue
        try:
            if float(p[k]) != float(want):
                bad.append("%s = %s (want %s)" % (k, p[k], want))
        except ValueError:
            bad.append("%s = %r not numeric (want %s)" % (k, p[k], want))

    for k, want in STRING.items():
        if p.get(k) != want:
            bad.append("%s = %r (want %r)" % (k, p.get(k), want))

    if MSG_MUST_CONTAIN not in (p.get("think_budget_message") or ""):
        bad.append("think_budget_message missing or wrong")

    # Anything we did not ask for is also a failure: an inherited params layer
    # is exactly how unwanted values arrive silently.
    extra = set(p) - set(numeric) - set(STRING) - {"think_budget_message"}
    if extra:
        bad.append("UNEXPECTED params: %s" % sorted(extra))

    # Keyed off the model's own architecture, not a hard-coded "qwen35moe.":
    # a dense qwen3.6 27B publishes the same field under "qwen35." and was
    # failed for "no MTP" while carrying all four NextN tensors.
    mi = d.get("model_info") or {}
    arch = mi.get("general.architecture") or "qwen35moe"
    nextn_key = "%s.nextn_predict_layers" % arch
    if mi.get(nextn_key) != 1:
        bad.append("%s = %r (want 1) -- no MTP" % (nextn_key, mi.get(nextn_key)))
    nextn = [t for t in (d.get("tensors") or [])
             if "nextn" in (t.get("name") or "").lower()]
    if len(nextn) != 4:
        bad.append("NextN tensors = %d (want 4) -- GGUF lacks the MTP head" % len(nextn))

    mf = d["modelfile"]
    for want in ("RENDERER qwen3.5", "PARSER qwen3.5"):
        if not any(l.strip() == want for l in mf.splitlines()):
            bad.append("missing %r" % want)

    if bad:
        print("PARITY FAIL %s" % tag)
        for b in bad:
            print("   " + b)
        return False
    print("PARITY OK %s (%d sourced params, presence_penalty=%s + renderer/parser + MTP head)"
          % (tag, len(p), numeric["presence_penalty"]))
    return True


if __name__ == "__main__":
    argv = sys.argv[1:]
    numeric = dict(NUMERIC)
    if "--presence-penalty" in argv:
        i = argv.index("--presence-penalty")
        numeric["presence_penalty"] = float(argv[i + 1])
        del argv[i:i + 2]
    ep, tags = argv[0], argv[1:]
    sys.exit(0 if all([check(ep, t, numeric) for t in tags]) else 1)
