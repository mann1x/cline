---
name: sdd-plan
description: >-
  Plans spec-driven work at whichever level is next: turns an approved
  milestone context into a roadmap of demoable slices ordered by risk, or
  researches one slice and breaks it into small, fully specified tasks, each
  with its files, steps and a verification command, then audits the plan.
  Also replans a slice after a blocker and plans remediation slices after a
  failed validation. Use after sdd-discuss, when sdd-wizard says a milestone
  or slice needs planning, or when the user asks to plan, replan or break
  down the work.
disabled: true
---

# Skill: Plan

Plans the work so that whoever executes it needs nothing but the plan. It works at two levels and picks the one that is due: a **milestone** becomes a roadmap of slices; a **slice** becomes tasks. No product code is written here.

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

## Which plan is due

- The milestone has a `CONTEXT` and no `ROADMAP` → **Part A**.
- There is a roadmap, and the first unchecked slice whose dependencies are checked has no `PLAN` → **Part B** for that slice.
- A task summary reports a blocker → **Part C**.
- The validation says needs-remediation → **Part A**, for the remediation slices only.

If there is no approved context yet, planning has nothing to stand on: say so and send the user to `sdd-discuss`.

## Part A: The roadmap

Read `M###-CONTEXT.md`, `REQUIREMENTS.md`, `DECISIONS.md`, `KNOWLEDGE.md`, the summaries of earlier milestones, and the code this milestone will touch. Research to the depth the uncertainty deserves: a small feature in a known codebase needs a look at the relevant files; new technology or an unfamiliar system needs the documentation read and the alternatives weighed. With sub-agents, give a broad survey to one and have it report the files, the patterns and the natural seams.

Then cut the milestone into slices, by these rules:

- **Vertical.** Every slice delivers something a person could see working, end to end through whatever layers it needs. Not "the database layer", not "the API": a capability.
- **Risk first.** The earliest slices prove the riskiest assumptions, through real working features and not throwaway spikes.
- **Honest count.** As many slices as the milestone's ambition needs. One for a simple feature; several for something that promises several capabilities.
- **Every active requirement of this milestone lands somewhere:** owned by a slice, or explicitly deferred, blocked with a reason, or moved out of scope. A requirement that silently belongs to nothing is a planning failure.
- **Dependencies are stated**, and nothing depends on a later slice.

Show the roadmap in the chat as a table (slice, title, risk, depends on, what can be demonstrated) and **get the user's approval before writing it**. Then write `.sdd/milestones/M###/M###-ROADMAP.md`:

```markdown
# M001 <title>: Roadmap
## Success criteria          <- from the context; each observable
- <criterion>
## Slices
- [ ] **S01 <title>**  risk: high | medium | low; depends: none
  Demo: <what a person can see or do when it is done>
  Proves: <the risk or requirements this slice settles>  (R001, R004)
- [ ] **S02 <title>**  risk: medium; depends: S01
  Demo: ...
## Boundaries                <- what each slice produces that a later one consumes
- S01 produces: <interface, table, module>; consumed by: S02
## Verification
- Contract: <unit tests, types, lint: the command>
- Integration: <what proves the parts work together>
- Operational: <build, start, the end-to-end flow>
## Definition of done
## Requirement coverage      <- every active R id → its slice, or deferred/blocked/out with the reason
```

Record the structural choices (the order and why, technology picked, scope left out) in `DECISIONS.md`. If the milestone needs credentials or accounts the user must provide, list them now, with where each is obtained, so they are ready before execution; never invent or write a secret value.

A roadmap with a single slice goes straight on to Part B in the same sitting.

## Part B: One slice

Slices are planned one at a time, when they are due, so that each plan can use what the earlier slices found.

### B1. Research

Read the slice's roadmap entry, the summaries of the slices it depends on (their **Forward intelligence** above all), the context, and the requirements it owns. Then look at the code. Match the depth to the work:

- **light:** well-understood work on patterns the codebase already has. Fifteen lines saying "this is straightforward, follow the pattern in `<file>`" is the right research document.
- **targeted:** known technology that is new to this codebase.
- **deep:** new technology, an unfamiliar API, a risky integration, unclear scope.

Write `S##-RESEARCH.md` for the planner, who may have no memory of the exploration:

```markdown
# S01 Research
## What exists               <- the specific files and what is in them
## Patterns to follow
## Seams                     <- where the work naturally divides into tasks
## Build or prove first
## Pitfalls and constraints
## How to verify the slice   <- the commands
```

With sub-agents, research is one agent's job: it reads and reports; you write the file from its report.

### B2. Tasks

Break the slice into tasks. Each task plan is the **whole contract** for whoever executes it: they will see that file and a line about the slice's goal, and nothing else. So everything needed is in it.

- **Size:** two to five steps and three to eight files. Ten steps or twelve files means it is two tasks.
- **Order:** each task's output unblocks the next. If the slice has tests, the first task creates them, failing.
- **Paths are exact,** in backticks. "The auth module" is not a path.
- **Done is checkable:** a command that exits 0, or an observable result. Not "works correctly".
- **Real, not stubbed:** a task that says "create a login endpoint" means one that authenticates against a real store. Mocks belong in tests.

Write `S##-PLAN.md`:

```markdown
# S01 <title>: Plan
Goal: <what is true when this slice is done>
Requirements: R001, R004
## Tasks
- [ ] **T01 <title>**: <one line>  (depends: none)
- [ ] **T02 <title>**: <one line>  (depends: T01)
## Slice verification        <- run when every task is done
- `<command>` exits 0
- <observable check>
## Acceptance                <- what a person will be shown or asked to try
```

and one `tasks/T##-PLAN.md` per task:

```markdown
# T01 <title>
Slice goal: <one line>
## Inputs                    <- files to read first, exact paths
## Outputs                   <- files to create or change, exact paths
## Steps
1. ...
## Must have                 <- behaviours that have to hold, including the error cases
## Verify
- `<command>`  → expect: exit 0, <what the output shows>
## Done when                 <- observable and checkable
## Out of scope              <- what this task must not touch
```

### B3. Audit the plan

Before finishing, check, and fix the plan files if a check fails:

1. **If every task were done exactly as written, would the slice goal be true?**
2. Every requirement the slice owns has a task that advances it, and a verification that would prove it.
3. The order respects the dependencies; no task reads a file a later task creates.
4. Every task is within the size limits and has a real verification.
5. Nothing reaches outside the slice.

Then review the plan for what plans usually miss. With sub-agents, run these as one batch of reviewers, each given the slice plan and one question; otherwise answer them yourself. Each answer is **pass**, **flag** (a concern, with what to do) or **not applicable**:

- **Security:** does the slice touch authentication, permissions, input from outside, secrets or personal data, and does the plan handle it?
- **Failure modes:** what happens when each external call, file or input fails? Is that in a task's "Must have"?
- **Load:** is there a volume or timing the plan ignores?
- **Negative tests:** do the tests cover what must be refused, not only what must work?

A flag does not block. Write the flagged handling into the task plan it belongs to, and note the review's results at the end of `S##-PLAN.md`.

Record any structural decision in `DECISIONS.md`.

## Part C: Replan after a blocker

A blocker is a finding that makes the remaining plan invalid: the API does not do what was assumed, a capability is missing, the architecture cannot take it. A bug or a failing test is not a blocker; that is ordinary work.

Read the blocker in the task summary and the slice's state. Completed tasks are history: do not touch them. Rewrite only the unchecked tasks, giving new tasks ids that continue from the highest existing one. Write `S##-REPLAN.md` (what was found, what changes, why) and update `S##-PLAN.md`. If the finding changes what the slice can deliver, or touches a requirement, stop and tell the user before going on.

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

Then say what was planned and what the next step is. Commit `.sdd/` only if the working agreements say to commit.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
