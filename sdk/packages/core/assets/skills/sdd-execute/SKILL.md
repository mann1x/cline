---
name: sdd-execute
description: >-
  Executes one planned task of spec-driven work: follows its task plan
  exactly, builds the real thing and its tests, runs the plan's verification,
  and writes a summary with the evidence before marking the task done. With
  sub-agents enabled the task runs in a fresh agent and its changes are
  checked before being adopted; with teammates enabled, independent slices can
  run side by side. Use when sdd-wizard says a task is next, or the user asks
  to execute, implement or resume the next task or a named one.
disabled: true
---

# Skill: Execute

Does one task from a slice plan, proves it, and records what happened. The task plan is the contract: this skill does not research again and does not redesign.

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

## Which task

The one the user named; otherwise the first unchecked task in the active slice's `S##-PLAN.md` whose dependencies are checked. If that task has edits and no summary, it was interrupted: read what is already there before creating anything, and continue it.

If there is no task plan, the slice has not been planned: stop and say that `sdd-plan` comes first.

## What the executor is given

Exactly this, and nothing from the conversation:

- `tasks/T##-PLAN.md`, in full;
- the slice goal, and the slice's verification section;
- the summaries of the tasks already done in this slice;
- `DECISIONS.md` and `KNOWLEDGE.md`;
- the working agreements in `PROJECT.md`.

## The executor's rules

1. **Read the inputs** the plan lists before changing anything.
2. **Follow the plan.** Correcting a path, a name or a small factual slip in the plan is part of the job; say so in the summary. Changing the approach is not.
3. **Build the real thing.** No stubs, no hard-coded success, no screen that renders invented data. If the plan says an endpoint authenticates, it authenticates.
4. **Tests are part of the task,** written or updated with the code. Errors and edge cases get the same care as the normal path.
5. **Stay inside the task.** Touch what the plan's outputs name. Something else that looks wrong is noted in the summary, not fixed.
6. **Verify with the plan's commands,** and read the output. A command that could not run is not a pass.
7. **When verification fails, debug deliberately:** one hypothesis, one change, run again. After three real attempts that did not fix it, stop and report, with what was tried.
8. **A blocker is rare and specific:** a finding that makes the rest of the plan invalid. Say so plainly, with the evidence, and stop. A failing test or a hard bug is not a blocker.
9. **Secrets:** never print, invent or commit one. If a credential is missing, stop and ask.
10. Do not push, publish, open issues or change anything outside the project without the user's explicit yes.

## Who executes

**With sub-agents (you have `spawn_agent`) — preferred.** A task done in a fresh context is done against the plan and nothing else.

1. Spawn one agent. Its task is the task plan's text and the rules above; its knowledge files are the plan's inputs plus the slice plan, `DECISIONS.md` and `KNOWLEDGE.md`. If the plan's verification is a command, give it as the agent's `check` (`command`, and `expect` when the output must show something), so "done" is tested and not claimed.
2. Ask it to end its report with: files changed, each verification command with its exit code and what the output showed, deviations from the plan, known issues, decisions made, and whether it found a blocker.
3. The agent worked on its own copy of the project. Its changed files come back as revisions. **Read them** (at least the diff of each against what the plan asked for), then adopt them into the workspace with `restore_file`. If you have no tool to adopt revisions, do not use an agent for execution: execute the task yourself.
4. **Run the plan's verification again in the real workspace.** The agent's check passed on its copy; the task is done when it passes here.
5. You write the summary and tick the box. An agent's files under `.sdd/` are not adopted.

Tasks of one slice run one after another, each seeing the summaries before it. Only tasks that the plan marks as not depending on each other, and that write different files, may run as one batch.

**With teammates as well (you have the `team_*` tools).** Use them for two things only:

- **Independent slices side by side.** When the roadmap has two or more unchecked slices that do not depend on each other and are both planned, spawn one teammate per slice, put each slice's tasks on the board with `team_task` and their `dependsOn`, and run the slices with `team_run_task` in `async` mode. Each teammate does its slice's tasks in order. You adopt and verify each task's result as it is handed back, exactly as in steps 3 to 5, and you mark the board task complete yourself. Slices that touch the same files are not independent, whatever the roadmap says: run those one after the other.
- **A reviewer for the slice.** One teammate, kept for the whole slice, that reads each adopted task against its plan and reports what does not match. It keeps what it learned from the earlier tasks. It reviews; it does not edit.

Shut the teammates down when their slices are closed.

**With neither.** Execute the task yourself, by the rules above. Read the task plan again first, and work from it rather than from what you remember of the planning.

## Record it

Write `tasks/T##-SUMMARY.md`. It is permanent, and it is what the next task and the slice's closing read:

```markdown
# T01 <title>: Summary
<one line saying what now exists>            <- also the commit message, if committing
## What was built
## Files changed
## Verification evidence
| Check | Command | Exit | Result |
|---|---|---|---|
| unit tests | `npm test -- user` | 0 | 12 passed |
## Deviations from the plan
## Known issues
## Decisions                                 <- also appended to DECISIONS.md
## Blocker                                   <- "none", or what was found and the evidence
```

Then:

- tick the task in `S##-PLAN.md` — **only if every verification passed in the workspace**. A task whose check did not pass stays unchecked, with the summary saying why;
- append real decisions to `DECISIONS.md`, and anything a later task would otherwise trip over to `KNOWLEDGE.md`;
- commit, if the working agreements say to, with the summary's first line as the message. Never commit secrets or build output.

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

Report in a few lines: what was built, the evidence, anything that deviated, and the next step. If the task found a blocker, the next step is replanning the slice (`sdd-plan`), not the next task. If it was the slice's last task, the next step is closing the slice (`sdd-verify`).

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
