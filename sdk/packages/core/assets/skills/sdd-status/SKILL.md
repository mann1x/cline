---
name: sdd-status
description: >-
  Reports where spec-driven work stands, without changing anything, from the
  sdd tool: the
  milestone and its slices, the slice in progress and its tasks, requirement
  coverage, open blockers and questions, checks waiting for a person, and the
  next step. Use when the user asks for status, progress, what is done, what
  is left, or what is next in a project that has a .sdd folder.
disabled: true
---

# Skill: Status

Read-only. Says where the project stands. It changes nothing, runs nothing that changes anything, and does not start the next step.

Part of the spec-driven set: `sdd-wizard` (where am I, what is next), `sdd-discuss`, `sdd-plan`, `sdd-execute`, `sdd-verify`, `sdd-quick`, `sdd-status`. Each works when the others are off; where this skill hands over to one that is not enabled, do that step directly by the rules given here.

## The `sdd` tool

The plan is kept in a database in the project (`.sdd/sdd.db`), and you reach it only through the **`sdd` tool**. The database is the truth: what is wanted, the milestones, their slices and tasks, what was proved, and which step is due.

- **`sdd` with action `next`** answers with the one step that is due and everything that step needs. Call it when you start and whenever you are unsure. Do not work out the next step yourself, and do not rely on what was said earlier in a conversation.
- Every other action records one thing and answers with the next step. An action out of turn is **refused**, with the reason and what to do instead. Do what it says; do not look for a way round it.
- The markdown under `.sdd/` (`PROJECT.md`, `REQUIREMENTS.md`, `DECISIONS.md`, `KNOWLEDGE.md`, `STATE.md`, and a folder per milestone with its roadmap, plans and summaries) is **written by the tool** from the database, for people to read and review. Read it when it helps. **Never edit it**: an edit is overwritten, and the plan does not change.
- The tool gives the ids: `M001` (milestone), `S01` (slice), `T01` (task), `R001` (requirement), `D001` (decision).
- A **milestone** is a deliverable someone could ship. A **slice** is a vertical piece of it that can be demonstrated on its own. A **task** is one unit of work small enough to do, verify and describe in one sitting.
- Only you, the lead, call `sdd`. An agent or a teammate given a task works on the code and reports; it does not record anything.

If you do not have a tool called `sdd`, this skill cannot run. Say so: the tool is offered when a task starts with a spec-driven skill turned on, so the user starts a new task. Do not imitate the tool by writing the files yourself.

## Ask

Call `sdd` with action `status`, and then with action `next`. These two change nothing. Call no other action from this skill.

If `status` says spec-driven development has not been started in this project, say that, and that `sdd-wizard` starts it. Nothing else.

## Check what the tool cannot see

The tool knows the plan. It does not know git. If the project is a git repository, look at `git worktree list` and report:

- a worktree under `.sdd/worktrees/` for a slice that is already done;
- a done slice whose branch (`sdd/M001-S01`) was never merged;
- a file under `.sdd/` that was edited by hand (`git status` shows it changed although no step ran): it will be overwritten by the next step.

Report these as inconsistencies. Do not repair them here.

## Report

Short, most important first. Start from what `status` printed:

```
M001 <title>: 2 of 5 slices done
  [x] S01 <title>
  [x] S02 <title>
  [ ] S03 <title>: 1 of 4 tasks done     <- now
  [ ] S04 <title>                        (after S03)
  [ ] S05 <title>

Next: <the step from next, in plain words, and the skill that does it>

Requirements: 6 validated, 5 active, 2 deferred
Waiting on you: <an approval, acceptance checks marked for a person, a missing credential>
Blocked: <what, or "no">
Isolation: <the slice's worktree and branch, and whether it has unmerged commits; or "none">
Inconsistencies: <what was found, or "none">
```

Add the last verification in one line (what was run, and how it ended; it is in the newest task summary under `.sdd/milestones/`), and anything a summary lists as a known issue that the user should not be surprised by.

If the user asks about one thing (a slice, a requirement, a decision), answer it from the files under `.sdd/` and name the file it is in.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
