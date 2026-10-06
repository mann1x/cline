---
name: sdd-discuss
description: >-
  Turns an idea into an agreed specification, by conversation: asks for the
  vision, reflects it back, reads the codebase, asks focused rounds of
  questions until the goals, scope, users, definition of done, risks and
  external systems are clear, then writes the project brief, the numbered
  requirements and the milestone context for the user to approve. Use at the
  start of a project or of a new milestone, when the user wants to discuss or
  change what is being built, or when sdd-wizard finds nothing planned yet.
disabled: true
---

# Skill: Discuss

The first phase of spec-driven development. Its product is agreement, written down: what is being built, for whom, and what "done" means. Everything later is planned and checked against what this writes. No code is written here.

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

## How to hold the conversation

- **Reflect before asking.** Show that you understood before you ask for more.
- **Investigate before asking.** Do not ask what the repository or the documentation can answer.
- **Ask in small rounds:** one to three questions on one topic, with choices where the likely answers are few and your recommendation first. Use the question tool if you have one. Never a questionnaire.
- **Use the user's words** in what you write down. Downstream steps see only the files; a paraphrase loses what the user stressed.
- **Do not shrink the vision.** Do not ask for "the minimum version" or talk the user down. What is large or risky is placed in a later milestone, not cut.
- **A missing answer is not a yes.** The two approvals below cannot be skipped or assumed.

## Stage 1: The vision

Ask what they want to build, or what this milestone is for. Then reflect it back concretely:

- what you understood, in a few sentences;
- the main capabilities, as a list;
- an honest size: roughly how many milestones, and roughly how many slices in the first.

Have them confirm or correct it before going on.

For a vision that is clearly several milestones, map them first: a name, one line of intent and the dependencies for each. Then discuss the first in depth; the others get one line each in `PROJECT.md` and are discussed when their turn comes.

## Stage 2: Investigate

Before the first question round, look:

- **an existing project:** its README, manifest, layout, tests, the code this work will touch, and any `.sdd/` files from earlier milestones (`DECISIONS.md` and `KNOWLEDGE.md` above all);
- **an unfamiliar library or service:** its documentation, not your memory of it;
- **a new project:** what the user already has, and the usual shape of this kind of thing.

With sub-agents available, a broad or unfamiliar codebase is a job for one: have it map the relevant area and report the files, the patterns in use and the constraints. It reads and reports only.

## Stage 3: Question rounds

Continue until all six are clear enough to explain to a stranger:

1. **What** is being built: concrete behaviours, not qualities.
2. **Why** it needs to exist.
3. **Who** it is for, and how they will use it.
4. **What "done" looks like:** what someone could see or do that proves it.
5. **The biggest unknowns and risks:** technical, and otherwise.
6. **What it touches outside itself:** services, APIs, data, credentials, other systems.

Ask about what is out of scope as deliberately as about what is in. Do not ask "shall we wrap up?" after each round; go on until the six are covered or the user wants to stop. After every second round, save what is confirmed so far to `.sdd/milestones/M###/M###-CONTEXT-DRAFT.md`, so an interrupted conversation loses nothing.

## Stage 4: Depth check

Print a structured summary of the six points, in the user's terms, and ask them to confirm that it is right and complete. **This is the first approval.** If they correct something, take it in and show the summary again.

## Stage 5: Requirements

Research briefly what such a thing normally needs that nobody mentioned: the behaviours users will expect, the standard pitfalls of the domain, what is commonly forgotten (errors, empty states, permissions, limits). Offer these as candidates; the user decides which are in.

Then draft the requirements and show the whole table in the chat **before writing the file**:

| ID | Requirement | Source | Status |
|---|---|---|---|
| R001 | one behaviour, stated so it can be proved | user / research / inferred | active / deferred / out of scope |

Each requirement is one testable behaviour: a situation and an observable result. "Fast" is not a requirement; "the list of 10,000 rows appears within one second" is.

**This is the second approval.** The user confirms, changes or adds. Only then write.

## Stage 6: Write

Recheck the size estimate from Stage 1 against everything learned, and say so if it changed. Then write:

**`.sdd/PROJECT.md`** (create, or refresh the whole file):

```markdown
# <Project>
## What it is
## Who it is for
## Current state            <- what exists and works today
## Milestones               <- M001 <title>: <one line> (status); later ones as one line each
## Working agreements       <- e.g. commit after each task: yes/no; test command; anything the user asked for
## Later                    <- ideas set aside, so they are not lost
```

Ask once, for the working agreements, whether they want a commit after each completed task. Record the answer; do not commit otherwise.

**`.sdd/REQUIREMENTS.md`:**

```markdown
# Requirements
## Active
- **R001** <requirement>  (source: user; milestone: M001; slice: unassigned)
## Validated               <- moved here, with the evidence, when proved
## Deferred
## Out of scope
```

**`.sdd/DECISIONS.md`** (append, never rewrite), for each choice made in the discussion:

```markdown
## D001 <short title>  (<date>, scope: project | M001 | S02)
Chose: <what>
Because: <why>
Instead of: <what was set aside>
```

**`.sdd/milestones/M###/M###-CONTEXT.md`**, the authoritative brief for everything that follows, then delete the draft:

```markdown
# M001 <title>: Context
## Goal                    <- in the user's words
## Why
## Who it is for
## In scope
## Out of scope
## Done looks like         <- success criteria, each one observable
## Unknowns and risks
## External systems        <- including any credential that will be needed, and who provides it
## Constraints
## Requirements covered    <- R ids
## Open questions
```

Create `.sdd/KNOWLEDGE.md` with a heading if it does not exist.

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

Then say what was written and that the next step is planning the milestone (`sdd-plan`). Commit `.sdd/` only if the working agreements say to commit.

## Changing course later

When the user comes back to change what is wanted mid-project, run the same conversation, shorter: reflect, ask only what the change leaves unclear, show the changed requirements, get approval, update `REQUIREMENTS.md`, the context and a `DECISIONS.md` entry. Slices already completed are not edited. The roadmap's remaining slices are then revised by `sdd-plan`.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
