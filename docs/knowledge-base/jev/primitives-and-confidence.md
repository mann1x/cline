# Primitives and confidence

Jev answers three types of question (the docs call them primitives): Choice, Score and
Noul. This page covers what each is for, how to pick between them, how the docs say to
write them, and what `confidence` means.

## The three primitives at a glance

| Type | Answers | Returns | Confidence field |
| --- | --- | --- | --- |
| Choice | Which of these options? (no order between them) | `choice`, `probabilities`, `confidence` | yes |
| Score | Which level on an ordered scale? | `score`, `legend`, `probabilities`, `confidence` | yes |
| Noul | Is this true? | `noul` (0 to 1) | **no** |

Two properties make the answers composable:

- **Constrained.** Every answer is a probability distribution over the options or levels
  you supplied, never a value outside them.
- **Independent.** One question's answer is not hidden context for another. You can add
  or remove questions without changing the others' results. The Parallel questions
  cookbook measured this: 13 questions asked in one call and in 13 separate calls gave
  the same means, and the run-to-run spread was the same either way.

Source: https://docs.typesafe.ai/primitives, https://docs.typesafe.ai/cookbooks/parallel_questions

## Choosing a question type

- **Choice**: the answer is one of a known set of options with no order between them,
  such as routing, document type or programming language. Give the full list. Add an
  `other` or `none of the above` option when the list might not cover every input.
- **Score**: the answer sits on a spectrum and you can describe each point on it, such
  as severity, frustration or skill level.
- **Noul**: a clean yes/no where the probability itself is the useful signal.

The docs' tie-breaker: when two types seem to fit, pick the one your code can act on
directly. A Choice maps to several code paths, a Score to a threshold, a Noul to an `if`.

Do not use a Noul to measure degree. "Is the candidate strong in Python?" gave 0.03,
0.14, 0.81 and 0.92 across four candidates. A 4-level Score on the same candidates gave
0.0, 1.0, 2.05 and 2.89, each landing on a level the author wrote. A Noul value of 0.5
means yes and no are equally likely. It does not mean "medium".

A Choice and a set of per-option Nouls answer different questions. The Choice is
relative: its probabilities sum to 1, so some option always wins. Each Noul is absolute,
so all of them can be low. The Line-by-line search and Skill suggestion cookbooks pair a
Choice (which one?) with a Noul (does any apply at all?) for this reason.

Source: https://docs.typesafe.ai/primitives#choose-a-question-type,
https://docs.typesafe.ai/primitives/noul#reading-a-noul,
https://docs.typesafe.ai/model-jaggedness/jev-1.13#common-sense-structural-invariants,
https://docs.typesafe.ai/cookbooks/semantic_find

## Choice

- `criteria` maps option names to descriptions (`null` when the name is enough), up to
  255 options.
- Both names and descriptions reach the model, so write descriptions that tell the
  options apart.
- The docs say to give the full list of options rather than a shortlist, because each
  option costs only a few tokens.
- For deep taxonomies, chain one Choice per level. Optionally pass each child's subtree
  as its description. The Hierarchical classification cookbook keeps the best K paths
  (a beam) instead of committing to the greedy one.
- When two options keep getting confused, describe each with an object: what it covers,
  what belongs to a neighbouring option (`not_for`), and examples. Use the same field
  names on every option.

Reading the answer: `choice` is the argmax. `probabilities` sum to 1. `confidence` drops
as probability spreads across options. In the docs' example, a ticket that belongs to two
teams gave `returns` 0.61 and `billing` 0.35, with confidence 0.42. The example code
copies in any second team whose share is above 0.25.

Source: https://docs.typesafe.ai/primitives/choice, https://docs.typesafe.ai/primitives/advanced

## Score

- `criteria` is an ordered array, low to high, of 2 to 10 levels. A level's number is
  its array index.
- `score` = Σ level × probability, a position that can fall between levels. Different
  distributions can give the same score: 1.0 can mean all weight on level 1, or half each
  on 0 and 2. Read `probabilities` and `confidence` alongside it.
- The docs normalise with `score / (len(criteria) - 1)` before combining Scores of
  different lengths.

How to write levels, per the docs:

- **Describe situations, not degrees.** "Broken or degraded feature, but workaround
  exists" works; "Moderately severe" does not.
- **Each level is judged on its own.** The model does not see a level's number or its
  neighbours, so "worse than the previous level" means nothing, and numbers in the
  descriptions or instructions do not help. With `criteria: ["0","1","2"]`, a report that
  scored 0.0 at confidence 1.0 under descriptive levels scored 0.55 at confidence 0.33.
- **One dimension per Score.** "Punctual and smart and experienced" measures three
  things; split it.
- **Give rare extremes their own level**, for example "abusive or threatening" above
  "very angry".
- **Use as many levels as you can describe distinctly, up to 10.** Three is fine.
- **When the model keeps landing between two levels on clear inputs,** turn each level
  into an object (`what` plus `examples`) with the same field names on every level.
  Examples only help when they look like your real inputs. On the Safari bug report, a
  matching example moved confidence from 0.35 to 0.96. An unrelated example left it at
  0.35.
- If there is no in-between at all, use a Choice, or split into several Nouls.

The docs warn more than once that **higher confidence alone does not show that a
description is better.** Check changes against inputs with known expected levels, then
test on separate inputs.

Source: https://docs.typesafe.ai/primitives/score

## Noul

- `instructions` holds one yes/no question or a statement to judge. `criteria.true` and
  `criteria.false` are optional.
- `noul` is P(yes). Near 1 is a strong yes, near 0 a strong no, near 0.5 uncertain.
- **There is no `confidence` field.** A two-outcome distribution is fully described by
  one number.

How to write Nouls, per the docs:

- One condition per Noul. "Is the customer angry and asking for a refund?" should be two
  Nouls combined in code.
- Phrase it so that a high value means yes. "Does the message contain personal data?",
  not "Is the message free of personal data?".
- A statement ("The customer is requesting a refund") works as well as a question. Try
  both on your data.
- Make the boundary unambiguous ("any Python experience"). When it is subtle, add
  `true`/`false` criteria. Test with and without criteria and keep whichever answers
  better.
- Do not invert the criteria (`true` meaning no). The jaggedness page lists this as a
  failure mode.

Source: https://docs.typesafe.ai/primitives/noul, https://docs.typesafe.ai/model-jaggedness/jev-1.13

## Writing questions: the docs' general guidance

### Atomic questions

"Ask for a judgment a knowledgeable person makes in a second given the right context."
"Does this message convey urgency?" is a good question. "Analyze this message and
determine the best course of action" is not. The docs call decomposition "probably the
most important concept" in their build guide: broad questions hide several judgments
behind one answer.

The build guide's own tool-call example makes the point for agent traces. Instead of one
Noul, "Is `trace.tool_calls` correct for `request` and `available_tools`?", it asks one
Noul per property:

```
geocode_tool_is_relevant           Is `trace.tool_calls[0].name` an appropriate tool for resolving `request.location`?
geocode_location_matches           Does `trace.tool_calls[0].arguments.city` match `request.location`?
geocode_arguments_match_schema     Does `trace.tool_calls[0].arguments` conform to `available_tools.geocode_city.parameters`?
geocode_result_matches_call        Does `trace.tool_results[0].tool_call_id` match `trace.tool_calls[0].id`?
weather_tool_is_relevant           Is `trace.tool_calls[1].name` an appropriate tool for answering `request.text`?
weather_arguments_match_schema     Does `trace.tool_calls[1].arguments` conform to `available_tools.get_weather.parameters`?
weather_uses_geocoded_coordinates  Do the coordinates in `trace.tool_calls[1].arguments` match those in `trace.tool_results[0].output`?
weather_date_matches               Does `trace.tool_calls[1].arguments.date` match `request.date`?
weather_unit_matches               Does `trace.tool_calls[1].arguments.unit` match `request.unit`?
```

The state for that example is an object with `request`, `available_tools` and `trace`
(`tool_calls`, `tool_results`). The docs publish the question sets, labelled "bad" and
"good", but no answers for them.

Some of those checks (id equality, exact date or unit match) are the kind of comparison
the jaggedness page says to keep in code. See [limits-and-caveats.md](limits-and-caveats.md).

Source: https://docs.typesafe.ai/primitives#ask-for-one-snap-judgment-per-question,
https://docs.typesafe.ai/concepts/how-to-build-with-system-one#design-a-system-one-workflow

### Decompose, then compose in code

When a judgment depends on several independent factors, ask one question per factor and
combine them with weights in code. When priorities change, change a coefficient instead
of a prompt. More questions cost only their tokens, and add little latency because they
run in parallel.

A second request is justified only when the code cannot build it without the first
answer: when that answer decides what goes into the state, or which options the next
question offers. Otherwise ask everything in one request and ignore what you do not need.

Source: https://docs.typesafe.ai/primitives#split-a-complex-judgment-into-several-questions,
https://docs.typesafe.ai/primitives#when-one-question-depends-on-another

### Structure

- **In the state:** use a JSON object with descriptive keys, and point questions at
  parts of it with backticked paths (`` `support.tickets[0].message` ``). Send only the
  context the questions need.
- **In the questions:** `instructions` and every criterion accept a string, object or
  array. Use an object when the question needs data beside it (a record from your
  database, a schema), when part of it comes from code, or when several questions are
  otherwise too alike. Keep the question text fixed and let the data fields change.
- A short, unambiguous question can stay a string.

Source: https://docs.typesafe.ai/concepts/how-to-build-with-system-one, https://docs.typesafe.ai/primitives/advanced

### Keep constants reviewable

The agent-skill page says to keep all questions and threshold constants in one file,
because those are what humans need to review. It adds that "Agents aren't great at
writing questions, so expect to edit collaboratively with them."

Source: https://docs.typesafe.ai/agent-skill#good-vibe-coding-principles

## Confidence

### What it is

`confidence` is a statistic computed from the `probabilities` of a Choice or Score
answer. It is 1.0 when all the probability sits on one option or level, and it falls as
the distribution flattens. Noul answers have none.

The docs do not publish the exact formula. The interactive demo on the Confidence page
"uses `(3 × largest probability − 1) / 2` to approximate confidence for three options."
That is the three-option case of `(n·p_max − 1) / (n − 1)`, clamped to [0, 1].

*Observation, not a documented fact:* the published examples match the n-option form of
that expression to within 0.01. The published probabilities are themselves rounded, so
an exact match is not expected. Three options at 0.61 give 0.42; four at 0.40 give
0.20; five at 0.74 give 0.67; a three-level Score at 0.57 gives 0.35. If that holds, a
Score's confidence depends only on the peak level's probability and ignores whether the
competing weight sits on an adjacent level or a distant one. Treat this as unverified
until TypeSafe documents it.

The docs call `confidence` "a solid default" and say you are "never locked into our
definition". Full `probabilities` come back so that you can compute another measure.
They promise a separate cookbook on the alternatives, which does not exist yet.

Two cookbooks threshold on something other than `confidence`:

- Self-consistency (choices) uses the **top probability** (≥ 0.60), "not the API's
  separate `confidence` field".
- Classification using confidence argues for `confidence` over the winner's
  probability. A winner at 0.45 with a runner-up at 0.44 is a different situation from
  a winner at 0.45 with the rest spread thinly.

Source: https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook,
https://docs.typesafe.ai/cookbooks/classification_using_confidence

### What low confidence means

| Answer type | Low confidence usually means (per the docs) |
| --- | --- |
| Choice | None of the options is a clear winner. The input may fit two options (the two-team ticket), or none of them. |
| Score | The levels overlap for this state, the question measures more than one thing, or the state does not say enough to place it. |
| Noul | No confidence field. A value near 0.5 is the uncertainty signal. |

Confidence describes the shape of the model's answer. It is **not** a guarantee that
the answer is right: "confidence 1.0 means the returned distribution puts all its
probability on one level. This describes the model's answer, not a guarantee that the
answer is correct."

Source: https://docs.typesafe.ai/confidence, https://docs.typesafe.ai/primitives/score#reading-a-score

### Calibration

Jev is trained with RLCD ("reinforcement learning for calibrated decisions"), whose
target is that outcomes given probability 0.8 happen about 80% of the time. The docs
state plainly that calibration is a property of **groups of predictions** and "does not
guarantee that an individual answer is correct."

Source: https://docs.typesafe.ai/introduction/machine-learning-primer, https://docs.typesafe.ai/concepts/system-one

### Three bands

The Confidence page's starting pattern:

| Band | Behaviour |
| --- | --- |
| High | Act automatically. |
| Medium | Proceed with caution: ask the user to confirm, flag for review, or gather more information. |
| Low | Do not act. Route to a human, ask for clarification, or fall back to another system. |

For Noul, the same three-way split is applied to the value itself. Examples in the docs:
yes > 0.8, no < 0.2, and review in between (Noul page). An `uncertain` band from 0.30 to
0.70 inclusive (Self-consistency: nouls).

Source: https://docs.typesafe.ai/confidence#three-paths-for-using-confidence-in-your-code,
https://docs.typesafe.ai/primitives/noul#handling-multiple-noul-answers-in-code,
https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook

### Thresholds scale with risk

"A confidence threshold is not one number." Different actions in the same system get
different gates, depending on what a wrong action costs. The docs' example (Python):

```python
if confidence < 0.5:
    route_to_human(user_message)            # genuinely unsure, don't guess
elif action.choice == "check_balance":
    show_balance(account_id)                # low stakes, recoverable
elif action.choice == "approve_transfer":
    if confidence > 0.9:
        confirm_then_execute(account_id)    # high stakes, high confidence
    else:
        ask_user_to_confirm(account_id)     # high stakes, moderate confidence
```

For Noul thresholds: use 0.5 when yes and no are equally easy to act on. Raise the
threshold when a false yes is expensive (paging someone, issuing a refund). Lower it
when a missed yes is expensive (failing to flag a safety issue).

Every threshold number in the docs is labelled illustrative. "Start with conservative
thresholds, test with your own data, and adjust." "Test thresholds by plotting
confidence against accuracy on your data." Thresholds tuned on one model version belong
to that version (pin it), and a threshold tuned on a Noul does not carry over to a
Choice.

The agent-skill page adds that when all you need is the best option, take the argmax and
skip the threshold. When you have a specific statistical method in mind, use
`probabilities` rather than `confidence`.

Source: https://docs.typesafe.ai/confidence#thresholds-scale-with-risk,
https://docs.typesafe.ai/primitives/noul#reading-a-noul,
https://docs.typesafe.ai/concepts/how-to-build-with-system-one,
https://docs.typesafe.ai/models#aliases,
https://docs.typesafe.ai/agent-skill#common-issues
