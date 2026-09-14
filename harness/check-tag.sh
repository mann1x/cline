#!/usr/bin/env bash
# Refuse a lane run whose model tag is misconfigured.
#
# WHY THIS EXISTS. eleven2go's `jackod4ac-9b_tb:q6_k-128k` carried
#   TEMPLATE "{{ .Prompt }}
#   RENDERER qwen3.5
#   ...
#   PARAMETER think_budget_message "
# The opening quote did not close until the quote inside think_budget_message,
# so ollama swallowed RENDERER, PARSER and every PARAMETER between them into one
# malformed template, dropped it, and fell back to the GGUF's Jinja. The tag ran
# with no renderer, no parser, no think_budget, no think_budget_message, no
# temperature and no presence_penalty -- and said nothing.
#
# Runs 0267-0271 were measured on it: 5/5 broken, 4.1 h of GPU, against 4/10
# FIXED for the same model on a correct tag. The result was attributed to the
# model. It was the tag.
#
# Nothing in the stack reports this. `ollama show` prints the swallowed text
# back as if it were configuration, so reading the Modelfile by eye CONFIRMS the
# wrong answer. The only reliable signal is /api/show's `parameters` field,
# which lists what is actually in force.
#
# Usage: check-tag.sh <endpoint> <model> [--require-budget]
set -uo pipefail
EP="${1:?endpoint}"; MODEL="${2:?model}"; REQUIRE_BUDGET="${3:-}"

python3 - "$EP" "$MODEL" "$REQUIRE_BUDGET" <<'PY'
import json, sys, urllib.request, re
ep, model, require_budget = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    req = urllib.request.Request(ep + "/api/show",
                                 data=json.dumps({"model": model}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
except Exception as e:
    print(f"TAG CHECK: cannot reach {ep} for {model}: {e}"); sys.exit(1)
if "error" in d:
    print(f"TAG CHECK: {model}: {d['error'][:120]}"); sys.exit(1)

tmpl = d.get("template", "")
params = d.get("parameters", "")
effective = {}
for line in params.split("\n"):
    parts = line.split(None, 1)
    if len(parts) == 2:
        effective.setdefault(parts[0], parts[1].strip())

problems = []
# The swallow signature: directives sitting INSIDE the template text.
for directive in ("RENDERER", "PARSER", "PARAMETER"):
    if re.search(rf"^{directive}\s", tmpl, re.M):
        problems.append(
            f"'{directive}' appears INSIDE the template -- an unclosed quoted "
            f"TEMPLATE swallowed it (template is {len(tmpl)} chars)")
        break

if require_budget == "--require-budget":
    if "think_budget" not in effective:
        problems.append("think_budget is not in effect")
    if "think_budget_message" not in effective:
        problems.append("think_budget_message is not in effect")

print(f"TAG CHECK {model} @ {ep}")
print(f"  template chars : {len(tmpl)}")
print(f"  effective params: {', '.join(sorted(effective)) or '(none)'}")
if problems:
    print("  BROKEN:")
    for p in problems:
        print(f"    - {p}")
    sys.exit(1)
print("  OK")
PY
