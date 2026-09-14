# Runs that must not be pooled into any comparison

## 0267-0271 — jackod4ac on eleven2go, broken tag (found 2026-09-14)

```
20260912-150953-0267  broken  4201s
20260912-161956-0268  broken  3475s
20260912-171753-0269  broken  1777s
20260912-174731-0270  broken  3699s
20260912-184911-0271  broken  1490s
```

Driver: `go-jackod4ac-e2g.sh`, arm=oracle, `MODEL=jackod4ac-9b_tb:q6_k-128k`
on eleven2go.

**Why invalid.** That tag on *that host* had an unclosed quoted `TEMPLATE` which
swallowed `RENDERER qwen3.5`, `PARSER qwen3.5` and every `PARAMETER`. Ollama
discarded the malformed template and fell back to the GGUF's Jinja, so the arm
ran with:

- no `qwen3.5` renderer or parser (⇒ **no separated thinking channel**)
- no `think_budget`, no `think_budget_message`
- no `temperature` (0.6 intended), no `presence_penalty` (1.5 intended)

solidPC's tag of the *same name* was correct, and the same model scored **4/10
FIXED** there (runs 0018-0027). The 0/5 here measures the tag, not the model.

Because there was no separated reasoning, the struggle detector could not
register distress or hedging on this arm either — any escalation reading from
these logs is also void.

**Disposition.** Both jackod4ac tags have been deleted from both hosts and
`native.sh` now refuses to start on a tag that fails `check-tag.sh`.
