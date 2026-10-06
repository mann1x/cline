---
name: sdd-status
description: >-
  Reports where spec-driven work stands, without changing anything: the
  milestone and its slices, the slice in progress and its tasks, requirement
  coverage, open blockers and questions, checks waiting for a person, and the
  next step. Use when the user asks for status, progress, what is done, what
  is left, or what is next in a project that has a .sdd folder.
disabled: true
---

# Skill: Status

Read-only. Says where the project stands, from the files. It changes nothing, runs nothing that changes anything, and does not start the next step.

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

## Read

`PROJECT.md`, `STATE.md`, `REQUIREMENTS.md`, the active milestone's roadmap, the plan of the slice in progress, the newest task and slice summaries, and the newest acceptance result and validation, if there are any.

If there is no `.sdd/` folder, say that spec-driven development has not been started in this project and that `sdd-wizard` starts it. Nothing else.

## Check the state against the files

`STATE.md` may be stale. Compare it with what the boxes and the files say:

- a task ticked with no summary, or a summary with the task unticked;
- a slice ticked whose tasks are not all ticked, or with no slice summary;
- a slice in progress whose dependency is unchecked;
- an active requirement that no slice of the roadmap owns;
- a worktree under `.sdd/worktrees/` (see `git worktree list`) for a slice that is already ticked, or a ticked slice whose branch was never merged.

Report any of these as an inconsistency. Do not repair them here.

## Report

Short, most important first:

```
M001 <title>: executing, 2 of 5 slices done
  [x] S01 <title>
  [x] S02 <title>
  [ ] S03 <title>: 1 of 4 tasks done     <- in progress
  [ ] S04 <title>                        (depends: S03)
  [ ] S05 <title>

Now: S03 / T02 <title>
Next: execute T02 (sdd-execute)

Requirements: 6 validated, 5 active, 2 deferred
Waiting on you: <acceptance checks marked NEEDS-HUMAN, open questions, a missing credential>
Blocked: <what, or "no">
Isolation: <the slice's worktree and branch, and whether it has unmerged commits; or "none">
Inconsistencies: <what was found, or "none">
```

Add the last verification result in one line (what was run, and how it ended), and anything under "Known issues" in the newest summaries that the user should not be surprised by.

If the user asks about one thing (a slice, a requirement, a decision), answer that from the files and cite the file it is in.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
