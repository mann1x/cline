---
name: sdd-wizard
description: >-
  The front door of spec-driven development: reads the project's planning
  files, says where the work stands, and runs the next step, whether that is
  discussing a new project or milestone, planning a slice, executing a task or
  verifying. Runs one step at a time by default, or keeps going until the
  milestone is done or blocked when asked for auto mode. Use when the user
  wants to start or continue spec-driven development, says "what's next" or
  "continue", or asks to build something larger than a quick change in a
  planned, verified way.
disabled: true
---

# Skill: Spec-Driven Development

Builds software from an agreed specification, in verified steps: **discuss** what is wanted, **plan** it as a roadmap of slices, and for each slice **plan** its tasks, **execute** them one at a time and **verify** the result, then validate the whole milestone. Every step writes down what it decided and what it proved, so the next one starts from the files and not from memory.

This skill is the entry point. It works out where the project stands and does the next step.

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

## Step 1: Read the state

Read what exists under `.sdd/`: `STATE.md`, `PROJECT.md`, the active milestone's roadmap, and the plan of the slice in progress. Then decide the next step from the files, in this order. Take the first line that matches:

| The files show | Next step | Skill |
|---|---|---|
| no `.sdd/` folder | discuss the project | `sdd-discuss` |
| no milestone, or the newest one is complete and more is wanted | discuss the next milestone | `sdd-discuss` |
| a milestone with `CONTEXT` but no `ROADMAP` | plan the milestone | `sdd-plan` |
| a `ROADMAP`; the first unchecked slice whose dependencies are checked has no `PLAN` | plan that slice | `sdd-plan` |
| that slice has a `PLAN` with an unchecked task | execute the first unchecked task | `sdd-execute` |
| a task has a `PLAN`, edits, and no `SUMMARY` | resume that task | `sdd-execute` |
| every task of the slice is checked; the slice is unchecked in the roadmap | close the slice | `sdd-verify` |
| every slice is checked; no `VALIDATION` | validate the milestone | `sdd-verify` |
| `VALIDATION` says needs-remediation and its slices are not planned | plan the remediation slices | `sdd-plan` |
| `VALIDATION` passed; no milestone `SUMMARY` | complete the milestone | `sdd-verify` |
| a task summary reports a blocker and the slice has not been replanned | replan the slice | `sdd-plan` |

A blocker comes before everything else: if `STATE.md` or the newest task summary names one, deal with it first.

If the user asked for something small and self-contained (a fix, a tweak, a one-file change), that is not a milestone: use `sdd-quick` and leave the roadmap alone.

## Step 2: Say where things stand

Before doing anything, tell the user in a few lines:

- the milestone and how many of its slices are done;
- the slice and how many of its tasks are done;
- the next step, and why it is that one;
- anything waiting on them: an open question, a blocker, an acceptance check marked for a human.

On a first run in a project, also say in three or four lines how this works: the phases, that they approve the requirements and the roadmap before any code is written, and that they can stop after any step.

## Step 3: Run the next step

**Guided (the default).** Do that one step, by its skill. When it ends, report what it produced and what the next step would be, and stop. The user reads, then says to continue.

**Auto.** When the user asks for auto mode ("keep going", "run the milestone", "auto"), repeat Steps 1 to 3 without stopping between them, re-reading the files each time rather than trusting what you remember. Stop only when:

- the milestone is complete;
- a step needs the user: a discussion, a requirements or roadmap approval, an acceptance check only a person can judge, a missing secret or credential, a decision that would change scope;
- a blocker stands after one replan of the same slice;
- verification fails and three real attempts did not fix it;
- the user says stop.

Discussion and approval are never done in auto mode: the user's answers are the specification. Auto mode starts once a roadmap is approved.

A long milestone will outgrow one conversation. That is expected and harmless: the files carry everything. When the conversation has become long, say so at the end of a slice and suggest continuing in a new chat with this skill.

## Agents

The steps are written so that work which should start with a clean context can be given to one:

- **With sub-agents** (you have `spawn_agent`): research, each task, and the plan reviews run in their own agents, as the phase skills describe. You stay the lead: you read the files, hand out the work, and check what comes back.
- **With teammates as well** (you have the `team_*` tools): slices that do not depend on each other can run side by side, one teammate per slice, and a reviewer can stay with a slice. `sdd-execute` says how.
- **With neither**: do each step yourself, one at a time.

Never assume an agent's claim. A task is done when its verification passed in the real workspace, and not before.

## Steering

At any point the user may change direction. A change to what is wanted goes into the files first (the requirement, the context, the roadmap's unchecked slices) and only then into the work. Completed slices and their records are not edited; a change to something already built is new work, planned like any other. A thought that is not for now is added to `.sdd/PROJECT.md` under "Later", so it is not lost.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
