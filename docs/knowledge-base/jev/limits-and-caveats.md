# Limits and caveats

This page collects what the docs say Jev does badly or cannot do, and the operational
limits on using it. It is aimed at the model version the docs describe, `jev-1.13`; the
jaggedness page was last reviewed 2026-09-17.

## Jev 1.13 jaggedness

The docs' summary: `jev-1.13` "does the best on System One tasks. It may struggle with
tasks that require additional levels of indirection. It can be quite literal in its
understanding. It struggles with tasks that require numeric precision." TypeSafe expects
to fix many of these in later versions.

| # | Failure mode | What the docs say to do instead |
| --- | --- | --- |
| 1 | Literal reading | Write the exact condition, with criteria for each option. |
| 2 | Math and numbers | Keep the arithmetic in code. |
| 3 | Date and time comparison | Extract the components; compare in code. |
| 4 | Indirection | Reduce hops; point to the relevant part of the state. |
| 5 | Large state full of irrelevant detail | Filter first; send only what the question needs. |
| 6 | Adversarial content | Write precise prompts, and test edge cases before deploying. |
| 7 | Contradictory instructions and criteria | Align the criteria with the instruction. |
| 8 | Common-sense structural invariants | Ask each decision one way; enforce identities in code. |
| 9 | Generation | Use a generative model. |

Source: https://docs.typesafe.ai/model-jaggedness/jev-1.13

### 1. Literal reading

Jev "answers the question you wrote, not the one you meant". Scoping words, negations
and implied conditions are read at face value. The fix is to state the exact condition
and put boundary cases in the criteria. The docs' test: "When you look at a wrong answer
and find yourself explaining what you really meant, that explanation is the missing half
of the instruction." Where interpretation cannot be avoided, split it into two literal
questions.

### 2. Math and numbers

- "Jev is not a calculator." Do any arithmetic in code.
- **Counting is unreliable**: characters, occurrences, list items. The error grows with
  the size of what is being counted. To count items that match a criterion, ask one Noul
  per item and add the answers up in code.
- **Numeric representations** do worse than semantic ones. Hex or RGB colours do worse
  than colour names. High-level languages do better than assembly or binary-encoded
  instructions. Convert in code, and pass a number or a named bucket.
- **Do not read a Score's position as a magnitude.** You can threshold the expected
  score, but "score levels are weak in numerical calibration". Interpolating between two
  levels will not recover an exact number.

### 3. Date and time comparison

Jev reads dates as text, not as ordered quantities. Ordering, differences and window
checks are unreliable. They get worse with mixed formats, relative references, and
boundaries such as quarters. The fix: extract each date part as a Choice over its closed
set, with an explicit "not stated" option, then build the date and do all comparisons in
code.

### 4. Indirection

Double negatives, "a property of a property", and multi-hop reasoning cost accuracy.
Write instructions as directly as possible, and name the relevant part of the state.

### 5. Large state full of irrelevant detail (state size)

"Accuracy falls as the state grows with content unrelated to the decision." Unrelated
detail acts as a distractor, and a large state also makes it harder to tell which part of
the input caused a wrong answer. The page summarises: "Jev suffers from context rot, so
unrelated material in the `state` costs you accuracy." Retrieve and filter in code first.
When that is not possible, use a Noul to filter for relevance (see the Classifying RAG
passages cookbook).

The degradation the docs describe comes from **irrelevant** content, not from size alone.
The docs publish no accuracy-versus-state-size curve and no token count at which
accuracy starts to fall.

This does not contradict the "no context-rot" claim on the Introduction page. That claim
is about **adding questions**: questions are evaluated independently, so more questions
do not degrade one another. A bigger or noisier **state** does degrade accuracy.

### 6. Adversarial content

"State is data, and `jev-1.13` does not treat it as hostile by default." Injected
instructions, misleading framing, or "text that argues for its own classification" can
move the answer. The docs expect to improve this. Until then: be explicit in the
criteria, and "test your integration thoroughly before deploying it to many users".

For a coding agent this matters directly. Repository files, tool output and web content
placed in `state` are exactly this kind of untrusted text.

### 7. Contradictory instructions and criteria

When `instructions` and `criteria` ask for different things, Jev "might get confused".
The docs' example is a Noul whose `true` maps to no and whose `false` maps to yes. Treat
the criteria as an extension of the instruction.

### 8. Common-sense structural invariants

Jev is "extremely consistent": semantically similar inputs give quantitatively similar
outputs. But identities you might expect between separate questions do not hold:

- The same refund question as a Noul gave `0.22`. As a yes/no Choice it gave
  `yes 0.01 / no 0.99`, with confidence 0.97.
- A question and its negation, asked as two Nouls, gave `0.72` and `0.47`, which sum to
  1.19.

So: do not carry a threshold tuned on a Noul over to a Choice. Do not expect
`P(x) + P(not x) = 1` across questions. Word each question to mean directly what you want.

### 9. Generation

Jev "is not trained to generate text". Forcing it by chaining Choices "will not work well
and will be very slow". For extraction, propose candidates with a regex or a generative
model, and let Jev pick one.

### The page's closing checklist (verbatim)

- Asking the model something code can compute exactly.
- Hiding several judgments inside one question.
- System Two tasks: more layers of indirections
- Giving it more context in `state` than the question needs. Jev suffers from context
  rot, so unrelated material in the `state` costs you accuracy.

Source: https://docs.typesafe.ai/model-jaggedness/jev-1.13, https://docs.typesafe.ai/introduction

## Other failure modes the docs flag

- **A Choice always picks something.** Probabilities sum to 1, so "some line ranks first
  even when the document doesn't answer the question." Add `other` / `none of the above`,
  or pair the Choice with a Noul on whether any option applies.
- **Answers are not deterministic.** Repeated identical calls vary slightly: a mean
  standard deviation of about 0.01, with some Nouls moving across 0.5 and some Choice top
  labels flipping between close options. See the Self-consistency cookbooks in
  [patterns.md](patterns.md#self-consistency-repeatability-and-an-explicit-uncertain-outcome).
- **Higher confidence is not proof that a prompt change helped.** An example that
  matches the input can raise confidence without the answer being more correct. Check
  against labelled inputs.
- **Examples in criteria steer the model** and help only when they resemble real inputs.
- **Alias drift.** `jev-latest` and `jev-preview` move when releases ship, which changes
  answers and invalidates tuned thresholds. Pin a versioned id when thresholds matter.
- **The agent skill can go stale.** An out-of-date TypeSafe skill can make a coding agent
  "invent request or response fields".

Source: https://docs.typesafe.ai/cookbooks/semantic_find, https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook,
https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook, https://docs.typesafe.ai/primitives/score,
https://docs.typesafe.ai/models#aliases, https://docs.typesafe.ai/agent-skill#common-issues

## Calibration caveats

- Calibration is measured "across groups of predictions; it does not guarantee that an
  individual answer is correct."
- `confidence` describes the shape of the distribution, "not a guarantee that the answer
  is correct".
- The docs label every threshold number illustrative. The cookbooks' bands (0.30–0.70
  for Nouls, top probability ≥ 0.60 for Choices, confidence ≥ 0.8 or 0.9) are "neither a
  calibrated guarantee nor an optimized threshold".
- The docs do not publish calibration curves (reliability diagrams) for `jev-1.13`, or
  accuracy figures by task type.
- The exact `confidence` formula is not documented; the Confidence page's demo gives only
  a three-option approximation. See
  [primitives-and-confidence.md](primitives-and-confidence.md#what-it-is).
- Non-English input: accuracy is lower, and the docs specifically advise paying close
  attention to confidence when routing it.

Source: https://docs.typesafe.ai/concepts/system-one, https://docs.typesafe.ai/confidence,
https://docs.typesafe.ai/introduction/machine-learning-primer, https://docs.typesafe.ai/models#language-support

## Input limits

| Limit | Value |
| --- | --- |
| Context per request | 64k tokens (the state plus all questions) |
| State plus the longest question | 32k tokens |
| Choice options | up to 255 (one cookbook: "reliably up to roughly 240") |
| Score levels | 2 to 10 |
| Input type | text only: a string, JSON object, or array of text values. No images, audio, video or binaries; turn them into text first. |
| Questions per request | no documented maximum beyond the token budget |

The 32k bound is the tighter one for large states: the state plus any single question
must fit in 32k tokens, even when the total is under 64k. The docs do not say which
tokenizer counts these tokens.

Source: https://docs.typesafe.ai/models, https://docs.typesafe.ai/api

## Language

English is the primary training language and where accuracy is best. Other languages,
including CJK scripts, are accepted but "not equally well". Test on your own content
before relying on Jev for a non-English workload. The docs say nothing about
non-English text inside code (comments, identifiers, commit messages). About programming
languages they say only that questions about high-level languages do better than
questions about assembly or binary-encoded instructions.

Source: https://docs.typesafe.ai/models#language-support, https://docs.typesafe.ai/model-jaggedness/jev-1.13#numeric-representations

## Rate limits and their volatility

- Published: 250,000 tokens per second and 1,200 requests per minute. Going over either
  returns `429`.
- "Rate limits are adjusting dynamically ... the limits above can change without notice".
  TypeSafe is serving heavy demand while it adds GPU capacity. Higher limits come with
  custom and enterprise plans.
- `529 Overloaded` is a separate, documented response.
- A cookbook limits itself to 6 concurrent workers because "the public endpoint
  rate-limits above roughly eight". That is an observation made on `jev-1.12`, not a
  published limit.
- The docs do not say whether limits apply per key, per account or per organisation.

Source: https://docs.typesafe.ai/models, https://docs.typesafe.ai/api#errors, https://docs.typesafe.ai/cookbooks/entity_alignment

## Pricing

- `jev-1.13.0`: $42 per billion input tokens ($0.042 per million). **Output tokens are
  free.**
- A request re-sends and re-bills the whole state each time. Batching questions over one
  state is the main cost lever: 13 questions in one call was 12.2× cheaper than 13 calls
  in the Parallel questions cookbook.
- Costs printed in the cookbooks use "historical price assumptions" and are not billing
  figures.
- The docs do not say whether failed requests (4xx or 5xx) are billed, and they do not
  mention prompt caching or discounts for a repeated state.

Source: https://docs.typesafe.ai/models, https://docs.typesafe.ai/cookbooks/parallel_questions,
https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook

## Data handling, ZDR and legal

- "Jev is not trained on customer requests or responses."
- The same weights serve every account. Jev is not fine-tuned or LoRA-adapted on
  customer data; you adapt it through `state`, `instructions` and `criteria`.
- Zero data retention (ZDR) is offered **to enterprise customers**; contact
  privacy@typesafe.ai. The docs do not state the default retention period for
  non-enterprise accounts; that is in the Data Processing Agreement, which this knowledge
  base has not reviewed.
- The governing documents are the Data Processing Agreement
  (https://typesafe.ai/legal/data-processing), the Master Customer Agreement
  (https://typesafe.ai/legal/mca), and the Privacy Policy
  (https://typesafe.ai/legal/privacy-policy).
- The docs do not state data residency or processing regions.
- JS SDK logging at `debug` level writes request bodies unredacted. A `state` that
  contains source code or secrets would end up in logs.
- The JS SDK refuses browser use unless `dangerouslyAllowBrowser` is set, because the API
  key would be exposed to page users.

Source: https://docs.typesafe.ai/models#data-handling, https://docs.typesafe.ai/models#customizing-jev,
https://docs.typesafe.ai/legal, https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig
