# Patterns

These are the architectural patterns and cookbook recipes from docs.typesafe.ai that
matter most for a confidence or decision helper. Each entry gives the mechanism, the
question shapes, and the thresholds the docs use.

**All example code in the docs' patterns and cookbooks is Python** (`typesafe_sdk`).
The snippets below are cut to the lines that matter. Every threshold quoted is labelled
illustrative in its source; none is a recommended production value.

The four patterns (Speculative fan-out, Confidence-gated routing, Composite scoring,
Intent routing) and the cookbooks share one principle: code owns control flow and side
effects, and Jev answers narrow typed questions inside it. The build guide contrasts this
with "LLM agents", where "every loop introduces another opportunity to go off the rails".

Source: https://docs.typesafe.ai/patterns, https://docs.typesafe.ai/concepts/how-to-build-with-system-one

## Confidence-gated routing

**Mechanism.** The answer says *what*; confidence says *whether to act*. Put a global
confidence floor first, then a per-action threshold that rises with how costly a wrong
action would be.

**Question shape.** One Choice over the actions, with an `other` option:

```json
"intent": {
  "type": "choice",
  "instructions": "What action is the user requesting?",
  "criteria": {
    "check_balance": "Check the balance of an account",
    "approve_transfer": "Approve the pending transfer request",
    "other": "Something else"
  }
}
```

**Thresholds in the docs' example** (voice banking, Python):

| Condition | Action |
| --- | --- |
| confidence < 0.6 (any intent), or `other` | send to a support agent |
| `check_balance`, confidence ≥ 0.6 | act (low stakes) |
| `approve_transfer`, 0.6 to 0.85 | ask the user to confirm |
| `approve_transfer`, > 0.85 | act automatically |

```python
if action.confidence < 0.6:
    route_to_support_agent(account_id)
elif action.choice == "check_balance":
    show_balance(account_id)
elif action.choice == "approve_transfer":
    if action.confidence > 0.85:
        approve_transfer(account_id)
    else:
        ask_user_to_confirm("Just to confirm: you would like to approve this transfer, is that correct?")
```

The Confidence page gives the same structure with a 0.5 floor and 0.9 for the
destructive action. The build guide uses a single gate at 0.8 (`confidence < 0.8`, then
human review).

Source: https://docs.typesafe.ai/patterns/confidence-routing, https://docs.typesafe.ai/confidence,
https://docs.typesafe.ai/concepts/how-to-build-with-system-one#design-a-system-one-workflow

## Intent routing

**Mechanism.** Jev sits in front of the handlers as "a fast, cheap classifier". It
classifies the request, then routes to deterministic code, a specialist LLM or a human.
Expensive handlers run only for requests that need them.

**Question shapes.** A Choice for intent plus a Score for complexity, in one request:

```json
"intent": {
  "type": "choice",
  "instructions": "The primary intent of this customer message",
  "criteria": {
    "order_status": "Asking about an existing order",
    "product_question": "Asking about a product before buying",
    "return_exchange": "Wants to return or exchange something",
    "complaint": "Unhappy with experience, wants resolution"
  }
},
"complexity": {
  "type": "score",
  "instructions": "How complex is this request to resolve",
  "criteria": [
    "Simple lookup or standard procedure",
    "Requires some judgment or multi-step process",
    "Unusual situation, edge case, or escalation needed"
  ]
}
```

**Thresholds in the example** (Python):

```python
if intent.confidence < 0.5:
    return route_to_human_agent(ticket_id)
...
elif intent.choice == "complaint":
    low_confidence = complexity.confidence < 0.5
    if complexity.score > 1 or low_confidence:
        route_to_human_agent(ticket_id)
    else:
        handle_with_llm(ticket_id, COMPLAINT_RESOLUTION)
```

The docs point out the second confidence check, on the Score: a low-confidence
complexity reading is itself a reason to escalate.

The Example use cases page lists "Model routing" with Jev in the same shape: choose which
LLM receives each prompt, classify intent and domain, estimate difficulty and risk, and
escalate requests that need a more expensive model.

Source: https://docs.typesafe.ai/patterns/intent-routing, https://docs.typesafe.ai/concepts/use-case-map

## Composite scoring

**Mechanism.** Split a complex judgment into independent Scores, normalise each to 0–1,
and combine them with weights kept in code. The same answers can serve several weightings.

**Question shapes.** Several Scores, one dimension each. The resume example uses four
5-level Scores (Python depth, team leadership, system design, generalist):

```python
py      = response.answers["python_depth"].score / 4
lead    = response.answers["team_leadership"].score / 4
arch    = response.answers["system_design"].score / 4
general = response.answers["generalist"].score / 4

ic_score = (0.40 * py) + (0.10 * lead) + (0.40 * arch) + (0.10 * general)
em_score = (0.15 * py) + (0.40 * lead) + (0.20 * arch) + (0.25 * general)
```

With scales of different lengths, divide each score by its own `len(criteria) - 1`. The
Score page's ticket-priority example is `0.6·severity + 0.3·frustration +
0.1·report_quality`.

The build guide applies the same idea to Nouls:
`0.4·answers_request + 0.4·citations_are_supported + 0.2·(1 − contradicts_context)`.
It also suggests using the probabilities as features in a classical ML model (the
AutoResearch cookbook), with labels from an ensemble of reasoning models if you have
none.

Source: https://docs.typesafe.ai/patterns/composite-scoring,
https://docs.typesafe.ai/primitives/score#splitting-a-complex-judgment-into-several-score-questions,
https://docs.typesafe.ai/concepts/how-to-build-with-system-one

## Speculative fan-out

**Mechanism.** Put every question the code might need into one request, including ones
that matter only on some paths. The code reads the relevant answers and ignores the
rest. Questions run in parallel, so extra ones "usually have little effect on response
time". They cost only their own tokens: the state is sent and billed once.

**Question shapes.** A classifying Choice plus conditional follow-ups. In the docs'
example, a ticket gets a `category` Choice, a `bug_severity` Score and
`has_reproducible_steps` Noul (used only for bug reports), a `refund_requested` Noul
(used only for billing), and a `frustration` Score (always used).

```python
if category.choice == "bug_report":
    if bug_severity.score > 1.5 and bug_repro.noul > 0.6:
        escalate_to_engineering(ticket_id, severity="high")
    else:
        add_to_bug_backlog(ticket_id)
elif category.choice == "billing":
    if refund.noul > 0.7:
        route_to_billing_with_flag(ticket_id, refund_likely=True)
...
if frustration.score > 1.5:
    flag_for_priority_response(ticket_id)
```

**Measured effect** (Parallel questions cookbook): 13 questions over the ~54,000-character
GDPR article cost $0.000497 and took 0.27 s in one call. As 13 single-question calls they
cost $0.006090 and took 2.71 s, summed sequentially. That is 12.2× cheaper and 10.0×
faster, with no change in the answers. The Primitives page quotes 11.5× and 9.6× for the
same cookbook. The two pages disagree, apparently from different runs.

The docs add that coding agents "fall into the one question per call habit more than
people do".

Source: https://docs.typesafe.ai/patterns/fan-out, https://docs.typesafe.ai/cookbooks/parallel_questions,
https://docs.typesafe.ai/primitives#ask-speculative-questions

## Self-consistency (repeatability and an explicit "uncertain" outcome)

Two cookbooks run the same rubric 15 times on the same input and measure how far the
answers move. Both used `jev-latest` (it answered as `jev-1.13.0`) on 2026-09-11, adding
a throwaway `uid` field to the state on each call.

**Nouls** (a 14-Noul insurance-claim rubric):

- The mean per-question standard deviation was 0.0102, lower than every LLM probability
  condition tested.
- Jev is not fixed across runs. Its `covered` answer ranged from 0.43 to 0.53, crossing
  a 0.5 threshold, and `exclusion` ranged from 0.53 to 0.62.
- Mechanism: map `noul < 0.30` to no, `0.30–0.70` (inclusive) to `uncertain` (human
  review), and `> 0.70` to yes. This is application logic with no extra call. "The band
  is illustrative; it is neither a calibrated guarantee nor an optimized threshold."
- Mean round trip: 111 ms, against 1.1–13.9 s for the LLM conditions.

**Choices** (an 8-Choice moderation rubric on a borderline post):

- Raw agreement across repeats was 90.8%. Jev's top label flipped on 2 of the 8
  questions (for example Harassment 11 times and Violence 4 times).
- Mechanism: return `uncertain` when the **top probability** is below 0.60 (this uses
  probabilities, "not the API's separate `confidence` field"). Agreement then rose to
  99.2%, with 25.8% of answers uncertain and 74.2% automatic.
- Mean probability std dev was 0.0098. Claude Haiku 4.5 at temperature 0 was more
  repeatable in this run (0.0012, 100% agreement). The docs say outright that these
  figures measure "repeatability only", not accuracy or superiority.
- Mean round trip: 114 ms.

Both cookbooks warn that a band does not make the model deterministic. A value near a
band edge can still move across it.

The cookbooks' cost columns use "historical price assumptions", not verified current
prices.

Source: https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook,
https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook

## Guardrails for LLMs

**Mechanism.** One request screens each message, on the way into an LLM and again on the
way out. A set of Nouls gives one probability per hazard, and a Score rates how much harm
complying would do. Code maps these to `pass`, `review`, `block` or `support` under a
named policy. The docs present this as an alternative to a guard LLM, which "an attacker
can talk ... past too".

**Question shapes** (Python helper `noul(instructions, yes, no)` builds a Noul with
`true`/`false` criteria):

- Input side: `jailbreak` ("... try to get the assistant to ignore, override, or reveal
  its instructions, or to role-play as an AI with no rules?"), `harmful_request`,
  `medical_advice`, `self_harm`.
- Output side: `broke_policy` ("Does this reply comply with a request the assistant
  should have refused ..."), plus reply-side versions of the other three.
- Both sides: `severity`, a 4-level Score from "No harm" to "Severe: complying causes
  serious physical harm or serious illegal harm."

**Thresholds** (`jev-1.12`, 2026-08-15):

```python
POLICIES = {
    "strict":     {"review_threshold": 0.35, "action_threshold": 0.70, "severity_block": 2.0},
    "permissive": {"review_threshold": 0.35, "action_threshold": 0.85, "severity_block": 2.0},
}
PRECEDENCE = ["support", "block", "review", "pass"]
```

A Noul at or above `action_threshold` triggers its hazard's action. A Noul at or above
`review_threshold` sends the message to review. A severity at or above `severity_block`
turns a review into a block. In the example, the same jailbreak (`jailbreak=0.74`) is
blocked under `strict` and sent to review under `permissive`. The probabilities are the
same; only the policy differs.

**Caveat from another page.** The jaggedness page says Jev "does not treat [state] as
hostile by default". Injected instructions or text that argues for its own
classification "can move the answer". Guardrail thresholds need adversarial testing.

Source: https://docs.typesafe.ai/cookbooks/llm_guardrails,
https://docs.typesafe.ai/model-jaggedness/jev-1.13#adversarial-content

## Citation checking / fact verification

**Mechanism.** Two steps. First a deterministic string match: normalise whitespace and
curly quotes, then search for the quote. A quote that is not in the source is
`fabricated`, and no model call is made. Then one Choice per surviving citation reads the
section the quote came from, or the named section when the citation has no quote, and
decides how that section relates to the claim.

**Question shape:**

```python
"relation": Choice(
    instructions="How does the section relate to the claim?",
    criteria={
        "supports": "The section states the claim or directly implies that it is true",
        "contradicts": "The section states the opposite of the claim or implies it is false",
        "says_nothing": "The section does not address what the claim asserts, either way",
    },
)
# state={"claim": claim, "section": section}
```

**Threshold.** `AUTO_ACCEPT = 0.8`: confidence ≥ 0.8 lets the verdict stand; below that,
a human confirms. "Start high, and lower the threshold as you see how the model does on
your own documents."

**Result** (8 citations against RFC 7519, `jev-1.12`, 2026-08-16): the four accurate
citations came back `verified` at 0.93–0.99. `exp_required` came back `contradicted` at
0.99. The two `unsupported` citations came back at 0.27 and 0.56 and went to review. One
of those two quoted the source word for word, which shows why the string match alone is
not enough.

Limitation stated in the docs: the match is exact after normalisation, so a truncated or
lightly reworded quote is reported as `fabricated`.

A related shape appears under "Universal Verification" and "LLM guardrails" on the Example
use cases page: verify prompts, extractions, reasoning traces and tool calls; detect
citation errors, hallucinations and tool-call errors. See the tool-call trace
decomposition in [primitives-and-confidence.md](primitives-and-confidence.md#atomic-questions).

Source: https://docs.typesafe.ai/cookbooks/citation_check, https://docs.typesafe.ai/concepts/use-case-map

## Classification using confidence

**Mechanism.** One Choice over a flat taxonomy. When confidence is high, report the leaf.
When it is low, report the leaf's **parent** in the hierarchy. The parent follows from
the leaf in code, so there is no second call.

**Question shape.** One Choice with 75 options (SIC major groups). Each option is
described by up to 8 of the industries it contains, and the state is the filing's
"Item 1. Business" text (700–2,200 words).

**Threshold.** `CONFIDENT = 0.9`.

```python
sure = answer["confidence"] >= CONFIDENT
return {
    "level": "group" if sure else "division",
    "label": answer["group"] if sure else division(answer["group"]),
}
```

**Result** (60 filings, `jev-1.12`, 2026-08-12): the 0.9 cutoff split the set in half.
The confident half was right 27 of 30 times (90%); the other half 12 of 30 (40%). Reported
one level up, the unsure half was 70% right. Overall, 48 of 60 answers were useful,
against 39 of 60 when a group was forced every time. The low-confidence cases were
readable in the text: development-stage companies, and a company that had just sold one
of its two segments.

The cookbook argues for `confidence` over the winner's probability here (a close
runner-up and a thin spread are different situations). It also notes "a Choice works
reliably up to roughly 240 options".

Source: https://docs.typesafe.ai/cookbooks/classification_using_confidence

## Also relevant to an agent harness

- **Skill suggestion** (Python, `jev-1.12`): two requests per agent turn. Request 1 is a
  Choice over all 182 skills plus three Nouls on whether the turn needs an action at all
  (their mean below 0.30 means suggest nothing). Request 2 re-reads the top 3 with full
  descriptions and may reject all of them. The winner is injected as one system-prompt
  line after the roster, so prefix caching still holds. With Claude Haiku 4.5, wrong
  skill loads fell from 16.8% to 7.3%, and needless loads from 9.8% to 4.0%, over 488
  requests. The cookbook's advice: to decide whether a skill is needed, ask whether an
  *action* is wanted; a question about subject matter does not separate the cases.
- **Function calling** (Python): one Choice (`__tool__`) picks the function. Each
  closed-set argument gets a Choice (for a `Literal`), one Noul per member (for a
  `list[Literal]`), or a Noul (for a `bool`), plus an optional "stated?" Noul that falls
  back to the default when the user says nothing about that argument. Free text, numbers
  and dates get no question; the function's default stands. All 54 questions go in one
  request per command. The call's reported confidence is "the least certain judgement
  behind that call".

Source: https://docs.typesafe.ai/cookbooks/skill_suggestion, https://docs.typesafe.ai/cookbooks/function_calling
