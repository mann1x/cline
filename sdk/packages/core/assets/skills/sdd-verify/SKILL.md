---
name: sdd-verify
description: >-
  Verifies spec-driven work at the level that is due: closes a finished slice
  by running its verification, writing its summary and an acceptance script,
  running the acceptance checks and reassessing the rest of the roadmap; or
  audits a finished milestone against its success criteria and requirements
  and completes it only when everything is proved. Use when every task of a
  slice is done, when every slice of a milestone is done, when sdd-wizard says
  verification is next, or when the user asks to verify, validate or accept
  the work.
disabled: true
---

# Skill: Verify

Checks that what was built is what was promised. Tasks passing one by one does not show that the slice works, and slices passing does not show that the milestone delivers; this skill is where the assembled thing is tested against the plan and the result written down.

Part of the spec-driven set: `sdd-wizard` (where am I, what is next), `sdd-discuss`, `sdd-plan`, `sdd-execute`, `sdd-verify`, `sdd-quick`, `sdd-status`. Each works when the others are off; where this skill hands over to one that is not enabled, do that step directly by the rules given here.

## The `.sdd/` folder

Everything this workflow knows is in files under `.sdd/` in the project. There is no other memory: a new chat, or an agent given one task, knows only what these files say. Read them; do not rely on what was said earlier in a conversation.

```
.sdd/
  PROJECT.md        what the project is and how it stands now; the working agreements
  REQUIREMENTS.md   the requirements, R001...: active, validated, deferred, out of scope
  DECISIONS.md      decisions, D001...: what was chosen and why; only ever added to
  KNOWLEDGE.md      project rules, gotchas and patterns found along the way
  STATE.md          where the work stands and what the next step is
  quick/Q001-SUMMARY.md
  milestones/M001/
    M001-CONTEXT.md      the agreed scope and goals of the milestone
    M001-ROADMAP.md      its slices, as a checklist
    M001-VALIDATION.md   the audit at its end
    M001-SUMMARY.md      written when it is complete
    slices/S01/
      S01-RESEARCH.md  S01-PLAN.md  S01-REPLAN.md
      S01-SUMMARY.md   S01-UAT.md   S01-UAT-RESULT.md
      tasks/T01-PLAN.md  tasks/T01-SUMMARY.md
```

- A **milestone** is a deliverable someone could ship. A **slice** is a vertical piece of it that can be demonstrated on its own. A **task** is one unit of work small enough to do, verify and describe in one sitting.
- Ids are fixed once given: `M001`, `S01`, `T01`, `R001`, `D001`. Never renumber.
- A checked box (`- [x]`) in a roadmap or a slice plan means done **and** verified. Summaries, validations and checked items are the record: never rewrite them.
- `STATE.md` is a convenience and can be stale. The files that exist and the boxes that are checked are the truth; when they disagree with `STATE.md`, they win and `STATE.md` is corrected.

## Which verification is due

- Every task of the active slice is checked, and the slice is unchecked in the roadmap → **Part A**.
- Every slice of the milestone is checked, and there is no `VALIDATION`, or the last one asked for remediation that is now done → **Part B**.
- The validation passed and there is no milestone `SUMMARY` → **Part C**.

## The three levels of proof

- **Contract:** unit tests, types, lint. Each piece does what it says, alone.
- **Integration:** the pieces work together across their boundaries.
- **Operational:** it builds, starts, and the flow a user follows works end to end.

Passing one level says nothing about the next. A slice is closed on the first two; a milestone needs all three.

## Evidence, not opinion

Every check is recorded with what was run and what was seen. For each, choose the lightest thing that honestly proves it: a command and its exit code, a file's content, a request and its response, the running app. Verdicts are **PASS**, **FAIL** or **NEEDS-HUMAN**. What only a person can judge (how it looks, how it feels, whether the wording is right) is marked NEEDS-HUMAN with everything prepared for them; never invent a pass for it.

## Part A: Close a slice

1. **Run the slice verification** from `S##-PLAN.md`, all of it, in the workspace. If a check fails, fix it and run again; a fix here is small and within the slice. If it cannot be fixed within the slice's plan, stop: the slice is not done, and the task that owns the failure is reopened or the slice replanned (`sdd-plan`).
2. **Check the goal, not the tasks:** is the slice's goal now true, end to end? Is each requirement it owns demonstrably met?
3. **Write `S##-SUMMARY.md`**, compressing the task summaries. It is read by whoever plans the slices after this one:

```markdown
# S01 <title>: Summary
<one line: what a user can now do>
## Delivered
## Requirements                 <- R ids advanced or validated, with the evidence
## Verification evidence
| Check | Command | Exit | Result |
## Forward intelligence         <- for the slices after this one
- Fragile: <what will break if touched carelessly>
- Changed: <where the result differs from what the roadmap assumed>
- Watch out: <gotchas a later slice will meet>
## Known issues and follow-ups
```

4. **Write `S##-UAT.md`**: the acceptance script for this slice, specific to what it built. Numbered cases, each with its preconditions, steps and expected result. Not a generic template.
5. **Run the acceptance script** and write `S##-UAT-RESULT.md`: per case, how it was checked, what was observed, and the verdict; then the overall verdict: PASS if every required case passed, FAIL if any failed, PARTIAL if some need a human or could not be run. With FAIL, the slice is not closed: go back to step 1. With PARTIAL, list exactly what the user needs to try, and how.
6. **Update the register:** move each requirement this slice proved to "Validated" in `REQUIREMENTS.md` with its evidence; append decisions to `DECISIONS.md` and lessons to `KNOWLEDGE.md`, only where they would save a later step real work; refresh "Current state" in `PROJECT.md`.
7. **Tick the slice** in the roadmap. Only now.
8. **Reassess the roadmap.** Read the summary just written against the slices still unchecked:

   - did this slice settle the risk it was meant to?
   - did a new risk appear that should change the order?
   - are the boundaries between slices still what the roadmap says?
   - does every success criterion still belong to some unchecked slice, or is it already proved?

   The usual answer is that the roadmap stands, and one line saying so is the right output. Change it only on evidence. When it must change, rewrite only unchecked slices, never completed ones, and tell the user what changed and why; a change to scope or to a requirement needs their agreement first.

With sub-agents, steps 1 and 5 can each be given to an agent with a fresh context, which is a better witness than whoever built the slice. With a slice reviewer teammate, ask it for its findings before step 2.

## Part B: Validate the milestone

An audit, not a rerun. Read the roadmap, every slice summary and acceptance result, the requirements and the decisions, and check:

1. **Success criteria:** for each one in the roadmap, the evidence that it is met, from summaries, acceptance results or by running it now. No evidence means not met.
2. **Slice delivery:** for each slice, does its summary show what its "Demo" line promised?
3. **Integration:** do the boundaries line up? What one slice produces, the next actually consumes?
4. **Requirements:** every active requirement of the milestone is validated, or explicitly deferred with a reason.
5. **Operational proof:** build it, start it, and walk the main flow end to end, now.
6. **Real change:** the milestone produced code, not only planning files.

Write `M###-VALIDATION.md` with the checklist, a table of slices against their claims, the integration findings, the requirement coverage, and a verdict:

- **pass:** everything is proved;
- **needs-attention:** small gaps that do not block; they are listed and carried into the summary;
- **needs-remediation:** something promised is not delivered. Add the remediation slices to the roadmap as new unchecked slices, tell the user, and the next step is planning them (`sdd-plan`). Validation runs again after they are done.

## Part C: Complete the milestone

Only with a passing validation. If any success criterion is unmet, any slice unchecked, or no code was changed, the milestone is **not** complete: say exactly that, list what is missing, and stop. There is no override.

Otherwise write `M###-SUMMARY.md`:

```markdown
# M001 <title>: Summary
<one line>
## What was built
## Success criteria             <- each, with its evidence
## Requirements                 <- validated, deferred, changed
## Key decisions                <- and whether each still looks right
## Key files
## Lessons                      <- the cross-cutting ones also go to KNOWLEDGE.md
## Follow-ups
```

Then refresh `PROJECT.md` as a whole (current state, the milestone marked complete, what comes next), and tell the user what they now have and how to try it. Commit only if the working agreements say to. Never push, tag or publish without their explicit yes.

Finish by rewriting `.sdd/STATE.md` (short, whole file):

```markdown
# State
Updated: <date>
Milestone: M001 <title>, <phase: discussing | planning | executing | validating | complete>
Slice: S02 <title>, <planning | executing | closing>      (or: none)
Task: T03 <title>                                          (or: none)
Next: <the one next step, and the skill that does it>
Blocked: <what, or "no">
```

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
