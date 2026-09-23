# Jev knowledge base

This is internal reference material for integrating **Jev**, TypeSafe AI's "System One"
model, into Cerebriline as a confidence and decision helper that the coding agent calls
through a tool. The content is drawn from docs.typesafe.ai as of 2026-09-23 (model
`jev-1.13.0`, JavaScript SDK 0.6.0). It states only what those docs say. Where the docs
are silent, the pages say so, and gaps an integrator needs filled are listed at the end
of this file.

These pages are not part of the published Cline docs navigation (`docs/docs.json`).

## What Jev is

Jev is TypeSafe's flagship model and the first "System One" model. It takes a **state**
(a string, JSON object or array of text) and a map of typed **questions**. It returns one
typed **answer** per question:

| Question | Answer |
| --- | --- |
| Choice: which of these options? | `choice`, per-option `probabilities`, `confidence` |
| Score: which level on an ordered rubric? | `score` (probability-weighted, can fall between levels), `legend`, `probabilities`, `confidence` |
| Noul: is this true? | `noul`, the probability of yes (0–1). No `confidence` field. |

All the questions in a request see the same state and are evaluated independently and in
parallel. Answers are constrained to the options you supplied. Jev is trained ("RLCD") to
return calibrated probabilities, meaning calibrated across groups of predictions, not a
guarantee for any single answer.

Source: https://docs.typesafe.ai/introduction, https://docs.typesafe.ai/concepts/system-one

## What Jev is not

- **Not a chat or code LLM.** It "does not generate text, write code, or hold a
  conversation." It does not stream, call tools or edit files. No `model: "jev-latest"`
  setting turns a coding agent into a Jev-powered agent. The docs have a page for exactly
  this confusion.
- **Not a reasoner.** It is built for gut-check judgments "a knowledgeable person makes
  in a second". Multi-hop, indirect, arithmetic, counting and date-comparison questions
  are documented weak spots.
- **Not an agent.** The docs position it for "AI-powered software", where code owns the
  control flow and Jev answers narrow questions inside it.
- **Not customisable per account.** It is not fine-tuned on customer data. You shape it
  only through `state`, `instructions` and `criteria`.
- **Not multimodal.** Text only.

Source: https://docs.typesafe.ai/introduction/coding-agents, https://docs.typesafe.ai/concepts/how-to-build-with-system-one,
https://docs.typesafe.ai/model-jaggedness/jev-1.13, https://docs.typesafe.ai/models

## When it is worth calling

The docs' own list for use inside an agent or app: when code needs to

- route a request to one of a fixed set of destinations, and know how confident that
  routing is;
- score something on a rubric (urgency, quality, risk) and branch on the number;
- check whether a statement is true of a document, message or record before acting;
- replace a fragile "return JSON" LLM prompt with a call that returns typed values by
  construction.

The Example use cases page also lists "Harness Engineering" (model routing, semantic
context retrieval, LLM error detection and guardrails, reasoning-trace classification)
and "Universal Verification" (checking prompts, extractions, reasoning traces and tool
calls). Two cookbooks work in an agent harness: one checks tool-call traces question by
question, and one suggests a skill per turn.

The docs' cost and latency figures: about 100 ms for most queries; 111–114 ms measured
round trips for 8–14 question calls; $0.042 per million input tokens, with output free.

The docs argue against calling it when code can compute the answer exactly, when the
question hides several judgments, when it needs multi-step reasoning, or when the state
would carry a lot of irrelevant context.

Source: https://docs.typesafe.ai/introduction/coding-agents#when-jev-is-worth-reaching-for,
https://docs.typesafe.ai/concepts/use-case-map, https://docs.typesafe.ai/model-jaggedness/jev-1.13

## Files in this knowledge base

- **[api.md](api.md)**: the HTTP API as documented. It covers `POST /v1/systemone`
  with Bearer auth; the request fields (`state`, `model`, `questions`); each question
  type's fields and limits (Choice up to 255 options, Score 2–10 levels, optional Noul
  criteria); structured instructions; the response shape for each answer type and
  `usage`; errors 401, 422, 429 and 529, with retry guidance; `GET /v1/models`; the
  models and aliases (`jev-latest`, `jev-preview`, `jev-1.13.0`); price, rate limits,
  context limits (64k per request, 32k for the state plus the longest question),
  text-only input, language support, and the latency figures the docs give. The JSON
  examples are copied from the docs.
- **[javascript-sdk.md](javascript-sdk.md)**: `@typesafe-ai/sdk` 0.6.0. Install;
  `TypeSafeClient` construction and every config option (`TYPESAFE_API_KEY`,
  `TYPESAFE_BASE_URL`, 10 s per-attempt timeout, retry policy); `systemOne()` and its
  typed request and response interfaces, copied verbatim; the builder functions; the
  error class hierarchy; retry and backoff defaults; and what a direct HTTP client would
  need to replicate. It also notes where the SDK types and the HTTP reference disagree.
- **[primitives-and-confidence.md](primitives-and-confidence.md)**: what Choice, Score
  and Noul are each for and how to choose between them; the docs' rules for writing
  instructions, levels and criteria (atomic questions, decomposition, structure,
  backticked state paths); how confidence relates to the probabilities (the documented
  approximation, plus one clearly marked observation); what low confidence means for a
  Choice versus a Score; why a Noul has no confidence field; the three-band pattern; and
  "thresholds scale with risk".
- **[patterns.md](patterns.md)**: confidence-gated routing, intent routing, composite
  scoring, speculative fan-out, self-consistency, guardrails for LLMs, citation checking,
  and classification using confidence. Each gets its mechanism, question shapes and
  example thresholds, plus the skill-suggestion and function-calling cookbooks. All the
  docs' example code is Python.
- **[limits-and-caveats.md](limits-and-caveats.md)**: the nine `jev-1.13` jaggedness
  failure modes (including accuracy loss from irrelevant state); structural
  non-invariants; run-to-run variation; calibration caveats; language; input limits;
  rate-limit volatility; pricing; and data handling, ZDR and legal documents.

## Sources

Pages read for this knowledge base (all under https://docs.typesafe.ai):

| Page | URL |
| --- | --- |
| Introduction | https://docs.typesafe.ai/introduction |
| Jev with coding agents | https://docs.typesafe.ai/introduction/coding-agents |
| Quick start | https://docs.typesafe.ai/introduction/quickstart |
| AI primer | https://docs.typesafe.ai/introduction/machine-learning-primer |
| System One | https://docs.typesafe.ai/concepts/system-one |
| State | https://docs.typesafe.ai/concepts/state |
| How to build with TypeSafe | https://docs.typesafe.ai/concepts/how-to-build-with-system-one |
| Example use cases | https://docs.typesafe.ai/concepts/use-case-map |
| Primitives (Questions) | https://docs.typesafe.ai/primitives |
| Choice | https://docs.typesafe.ai/primitives/choice |
| Score | https://docs.typesafe.ai/primitives/score |
| Noul | https://docs.typesafe.ai/primitives/noul |
| Advanced: structure | https://docs.typesafe.ai/primitives/advanced |
| Confidence | https://docs.typesafe.ai/confidence |
| Patterns | https://docs.typesafe.ai/patterns |
| Speculative fan-out | https://docs.typesafe.ai/patterns/fan-out |
| Confidence-gated routing | https://docs.typesafe.ai/patterns/confidence-routing |
| Composite scoring | https://docs.typesafe.ai/patterns/composite-scoring |
| Intent routing | https://docs.typesafe.ai/patterns/intent-routing |
| Self-consistency: nouls | https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook |
| Self-consistency: choices | https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook |
| Parallel questions | https://docs.typesafe.ai/cookbooks/parallel_questions |
| Double-checking citations | https://docs.typesafe.ai/cookbooks/citation_check |
| Guardrails for LLMs | https://docs.typesafe.ai/cookbooks/llm_guardrails |
| Classification using confidence | https://docs.typesafe.ai/cookbooks/classification_using_confidence |
| Skill suggestion | https://docs.typesafe.ai/cookbooks/skill_suggestion |
| Function calling | https://docs.typesafe.ai/cookbooks/function_calling |
| Line-by-line search | https://docs.typesafe.ai/cookbooks/semantic_find |
| Pre-parsed value extraction | https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook |
| Entity alignment | https://docs.typesafe.ai/cookbooks/entity_alignment |
| Models | https://docs.typesafe.ai/models |
| API reference | https://docs.typesafe.ai/api |
| Jev 1.13 jaggedness | https://docs.typesafe.ai/model-jaggedness/jev-1.13 |
| Agent skill | https://docs.typesafe.ai/agent-skill |
| Legal | https://docs.typesafe.ai/legal |
| Client SDKs | https://docs.typesafe.ai/sdk |
| JavaScript SDK and changelog | https://docs.typesafe.ai/sdk/javascript, https://docs.typesafe.ai/sdk/javascript/changelog |
| JavaScript SDK API reference (classes, interfaces, type aliases, functions, variables) | https://docs.typesafe.ai/sdk/javascript/api |
| Python SDK constants and retries (for comparison only) | https://docs.typesafe.ai/sdk/python/api/constants, https://docs.typesafe.ai/sdk/python/api/retries |

Full page index: https://docs.typesafe.ai/llms.txt. All pages in one file:
https://docs.typesafe.ai/llms-full.txt. The JS SDK source that the docs cite for
options and defaults: https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts.

## Open questions for the Cerebriline integration

These are facts the docs leave unclear or do not cover that an integrator will need.

1. **Streaming.** No streaming or incremental response mode is documented. Every
   example shows one complete JSON response, but the docs never say whether partial
   delivery exists.
2. **Batch limits.** There is no documented maximum number of questions per request and
   no batch endpoint for many states. The only bounds are 64k and 32k tokens. The docs
   do not say what happens when a request exceeds the context budget (which status
   code, and whether it is truncated or rejected).
3. **Token counting.** No tokenizer is named and there is no pre-flight count. An agent
   filling `state` from repository files cannot check the 32k bound exactly before
   sending.
4. **API key scope.** The docs do not say whether a key belongs to a user, an
   organisation or a project, whether rate limits are per key or per account, or how
   keys rotate. This matters for whether Cerebriline ships one key per user
   (`TYPESAFE_API_KEY`) or proxies the calls.
5. **Latency.** The docs give "about 100 ms" and "150ms", and cookbooks measured 111–114
   ms for 8–14 questions. There is no SLA, no percentile figures, and no curve for how
   latency grows with state size (the one large-state data point is 0.27 s for 13
   questions over roughly 54,000 characters). Region and network effects are not
   discussed.
6. **Confidence formula.** Only a three-option approximation is published. It is not
   documented whether a Score's confidence accounts for ordinal distance between levels.
7. **`instructions` and `state` nullability.** The SDK types allow null or omitted
   values; the HTTP reference marks both as required. Server behaviour is not
   documented.
8. **Error body schema, and the 400, 403 and 404 cases.** The SDK has classes for them;
   the HTTP reference does not say when they occur. It is also not documented whether
   `529` carries `retry-after`, or whether failed requests are billed.
9. **Version lifecycle.** How long older versions (`jev-1.12`, used in several
   cookbooks) stay callable, whether `major.minor` names like `jev-1.13` resolve, and how
   much notice comes before `jev-latest` moves.
10. **Data retention for non-enterprise accounts.** ZDR is enterprise-only. The default
    retention and processing regions are in the DPA, which is not summarised in the docs
    and was not reviewed here. Code sent as `state` is customer data under those terms.
11. **Determinism.** The docs show small run-to-run variation, with labels flipping on
    close cases. They document no seed or deterministic mode.
12. **Suitability for code-centric states.** None of the docs' measured examples uses
    source code or diffs as the state. The nearest are the tool-call-trace decomposition
    (questions only, no published answers) and "Semantic code linting", listed as a use
    case with no cookbook. How accurate Jev is on "is this edit correct / complete /
    safe" style questions over code is not documented.
