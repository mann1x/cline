# Jev in Cerebriline

How this fork uses Jev (TypeSafe System One). The other files in this folder
describe the service; this one describes the integration.

## Turning it on

Settings → API Configuration → Model tab → **Use Jev for confidence** (below
*Use an endpoint for image generation*). The **Jev** tab that appears holds:

| Setting | Default | What it does |
| --- | --- | --- |
| API key | — | Stored in VS Code secret storage (`jevApiKey`), never sent to the webview. Nothing runs without it. |
| Model | `jev-latest` | Pin a version (e.g. `jev-1.13.0`) once the floors are tuned; `jev-latest` moves with releases. |
| Confidence floor | 0.60 | An answer at or above it counts as confident. |
| High-stakes floor | 0.85 | The bar for a question the model marks `high_stakes`. |
| Timeout | 15 s | For the whole call, retries included. A question to the user waits at most 6 s. |
| Score the options of a question | on | The `ask_question` hook below. |
| Score a task before it is escalated | on | The escalation hook below. |

Stored as `jevEnabled` and `jevSettings` (JSON) in global state. The gate is
`readJevEndpoint()` in `apps/vscode/src/sdk/jev-config.ts`: the box ticked
**and** a key stored.

## What it adds

1. **The `jev` tool** (`sdk/packages/core/src/extensions/tools/jev.ts`). The
   model sends a `context` and 1–10 questions (`yes_no`, `choice`, `score`) in
   one call and gets each answer back as *confident* or *UNSURE* against the
   floor. The tool is added in `vscode-runtime-builder.ts` only when Jev is
   configured. It has a `# tool: jev` section in every template, and
   `default.md` carries the description verbatim.
2. **A system-prompt rule** (`buildJevPromptSection`), present only with the
   tool. It covers: checking the user's request is understood before starting,
   verifying facts against source text, choosing between approaches, and
   scoring complexity before escalating or delegating.
3. **Questions to the user** (`jev-question-ranking.ts`, called from the
   `askQuestion` executor in `SdkController`). Before a model-authored
   `ask_question` is shown, one Choice question ranks its options against the
   user's own words:
   - the top option is marked `(recommended)` if Jev's confidence clears the
     floor, replacing the model's own mark;
   - options under 5% are dropped, never leaving fewer than two;
   - each option's score is shown under the question.

   Escalation and check approvals use a different path (`askUser`) and are
   never ranked. Any failure sends the question out unchanged.
4. **Escalation** (`CoreEscalationConfig.appraise` →
   `appraiseEscalationWithJev`). When the model escalates, one call asks for a
   complexity Score and a "stuck rather than progressing" Noul. The call sees
   the user's task, the model's goal and reason, and the harness's counts. Its
   lines go into the assessment, which both the approval question and the
   expert's brief carry. The call is bounded at 8 s, and a failure costs only
   those lines.

## How confidence is read

Choice and Score answers carry `confidence`. A Noul does not. It is given the
two-outcome form `|2p − 1|`, so one floor reads all three kinds: at 0.6, a
yes/no counts only at p ≥ 0.8 or p ≤ 0.2.

## Data sent

- **The tool:** whatever the model puts in `context`.
- **The question hook:** the user's messages, the model's last three replies,
  and the question itself. Tool output is excluded.
- **The escalation hook:** the task, the goal and reason, and the harness's
  counts.

Everything is capped per part (`JEV_MAX_PART_CHARS`). Zero data retention is
enterprise-only at TypeSafe; see `limits-and-caveats.md`.
