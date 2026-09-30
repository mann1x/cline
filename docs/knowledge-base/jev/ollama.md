# Ollama's Jev-compatible endpoint

Ollama 0.35 serves TypeSafe's Jev API at `POST /v1/systemone` with local decision
models. xollama carries the same code. This page records how that endpoint differs from
TypeSafe's and what Cerebriline does about each difference. It was checked against
Ollama's source (`decision/`, `server/routes.go`, upstream `main` of 2026-09-30) and
measured live on solidPC's xollama `0.35.0-dev.562eea98`.

Sources: https://ollama.com/blog/ollama-now-supports-jev-style-decision-models,
https://docs.ollama.com/capabilities/decision, https://docs.ollama.com/api/systemone

## Models

| Model | Size | From |
| --- | --- | --- |
| `nimble` | 9B, 9.5 GB | Bespoke Labs, open source |
| `tev1` | 4B | Together AI, experimental |
| `tev1:0.8b` | 0.8B | Together AI, experimental |

`/api/tags` lists them with `"decision"` in `capabilities`. That is how the Jev tab's
model picker finds them. `/v1/models` carries no capabilities.

## What is the same

The request fields (`model`, `state`, `questions`), all three question types, noul
`criteria` of `{true, false}`, and every answer field. Score is the probability-weighted
level mean. The blog's ticket-triage request, run live, returned the blog's answers
within 0.01.

## What differs, and how the client branches

The client asks any custom endpoint `GET /api/version` once. A string `version` means
Ollama, and the answer is kept per server. TypeSafe's own URL is never probed.

| | TypeSafe | Ollama | Client |
| --- | --- | --- | --- |
| URL | API base `…/v1` + `/systemone` | server root + `/v1/systemone` | the root, `/v1` and the full path are all accepted |
| Key | required | none (a bearer is ignored) | `Authorization` only when a key is set |
| Body | no byte limit documented | 64 KiB (`413`) | the state is cut to fit |
| Prompt | 32k tokens | the model's **loaded window**, never truncated: `400 prompt 0 has N tokens; expected 1–M` | cut to `M/N` of the state, retried, and the size is remembered per server and model |
| Choice options | up to 255 | 2 to 26 (one letter each) | more than 26 fails before sending |
| Questions | no stated maximum | 1 to 64 | the tool asks at most 10 |
| Errors | 401, 422, 429, 529 | 400/404/413, `{"error": "…"}` | Ollama's message is shown; a `404` names the models to pull |
| Models | TypeSafe's (`jev-latest`) | local GGUF only; `:cloud` is refused | a custom endpoint keeps its own model |

The prompt limit is the one that bites. On xollama nimble loaded with an 8,194-token
window, so a 24,000-character state was refused until it was cut.

## Confidence

Ollama's choice and score `confidence` is `1 − H/ln n`: one minus the entropy of the
probabilities, normalized. TypeSafe documents its confidence only as "derived from
`probabilities`". Floors tuned on one server are not known to carry over to the other.
