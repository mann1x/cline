---
name: sdd-execute
description: >-
  Executes one planned task of spec-driven work: follows its task plan
  exactly, builds the real thing and its tests, runs the plan's verification,
  and records a summary with the evidence before the task counts as done. With
  sub-agents enabled the task runs in a fresh agent and its changes are
  checked before being adopted; with teammates enabled, independent slices can
  run side by side. Use when sdd-wizard says a task is next, or the user asks
  to execute, implement or resume the next task or a named one.
disabled: true
---

# Skill: Execute

Does one task from a slice plan, proves it, and records what happened. The task is the contract: this skill does not research again and does not redesign.

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

## Which task

Call `sdd` with action `next`.

- `execute_task`: the answer is the task: its steps, its files, its `Verify` command and what to expect from it. Call `sdd` action **`start_task`** before changing anything.
- `resume_task`: the task was started and not finished. Read what is already changed in the workspace before creating anything, and continue it. Do not call `start_task` again.
- anything else: this is not the step that is due. Say which step is, and which skill does it.

Tasks are done in order, one at a time; the tool refuses to start one while another is in progress or an earlier one is not done.

## What the executor is given

Exactly this, and nothing from the conversation:

- the task, in full, as `next` gave it;
- the slice's goal, and the summaries of the tasks already done in this slice (`.sdd/milestones/M###/slices/S##/tasks/`);
- `.sdd/DECISIONS.md` and `.sdd/KNOWLEDGE.md`;
- the working agreements in `.sdd/PROJECT.md`.

## The executor's rules

1. **Read the inputs** the plan lists before changing anything.
2. **Follow the plan.** Correcting a path, a name or a small factual slip in the plan is part of the job; say so in the summary. Changing the approach is not.
3. **Build the real thing.** No stubs, no hard-coded success, no screen that renders invented data. If the plan says an endpoint authenticates, it authenticates.
4. **Tests are part of the task,** written or updated with the code. Errors and edge cases get the same care as the normal path.
5. **Stay inside the task.** Touch the files the task names. Something else that looks wrong is noted in the summary, not fixed.
6. **Verify with the plan's commands,** and read the output. A command that could not run is not a pass.
7. **When verification fails, debug deliberately:** one hypothesis, one change, run again. After three real attempts that did not fix it, stop and report, with what was tried.
8. **A blocker is rare and specific:** a finding that makes the rest of the plan invalid. Say so plainly, with the evidence, and stop. A failing test or a hard bug is not a blocker.
9. **Secrets:** never print, invent or commit one. If a credential is missing, stop and ask.
10. Do not push, publish, open issues or change anything outside the project without the user's explicit yes.

## Git isolation (optional)

A slice can be built in its own git worktree, on its own branch, so the user's working copy stays exactly as it is until the slice is verified. It is optional: when it is not possible, say once why and carry on without it.

**Whether to use it.** Read "Isolation" in the working agreements (`.sdd/PROJECT.md`). If it is not there, ask once, at the first task of the first slice (worktree, or none), and record the answer with `sdd` action `set_project`, giving the agreements again with the answer added. With "none", skip this section.

**Whether it is possible.** Check with git before the slice's first task:

```
git rev-parse --is-inside-work-tree      # must print true
git rev-parse --verify HEAD              # the repository must have a commit
git status --porcelain                   # must list nothing outside .sdd/
git worktree list                        # the git here must know worktrees
```

Uncommitted changes outside `.sdd/` would not be in the worktree, so the slice would be built without them: tell the user and let them commit or stash, or go on without isolation. If the project is not a git repository, or any check fails and cannot be put right by the user, go ahead without isolation and say so. Do not run `git init`, commit the user's changes or stash them yourself.

**Create it** at the slice's first task:

```
git worktree add -b sdd/M001-S01 .sdd/worktrees/M001-S01 HEAD
```

and keep it out of the user's commits by adding the line `.sdd/worktrees/` to `.git/info/exclude` (not to their `.gitignore`). If the branch or the folder already exists, the slice was started before: use it, do not recreate it.

**Work in it.**

- Every product file of the slice is read and changed under `.sdd/worktrees/M001-S01/`, and every build, test and verification command runs from that folder. A task plan's paths are relative to it.
- A fresh worktree has no installed dependencies and no ignored files (no `node_modules`, no virtual environment, no `.env`). Install from the lockfile before the first verification, and tell the user if the project needs a local file that is not in git.
- **The plan is the one in the main checkout.** `sdd` always works on the project you were started in. The worktree may contain an older copy of `.sdd/`; never read it for the plan, and never write it.
- After each task that passed its verification, commit in the worktree: the summary's first line as the message, and a trailer `SDD-Task: M001/S01/T01`. These commits are on the slice's branch and do not touch the user's branch, so they are made whatever the working agreements say about committing.
- With a sub-agent, give it the worktree paths; its changes are adopted into the worktree, and the verification is run again there.
- With teammates running slices side by side, each slice has its own worktree. That is what keeps them apart.

The slice is merged back, and the worktree removed, when it is closed (`sdd-verify`). Never delete a worktree or its branch while it holds work that has not been merged, and never push.

## Who executes

**With sub-agents (you have `spawn_agent`) — preferred.** A task done in a fresh context is done against the plan and nothing else.

**First check that you can take the agent's work back.** An agent works on its own copy, and its changes return as revisions that are adopted with `restore_file`. That tool exists only when Checkpoints or the change protocol is turned on. Look at your tools: if you have `spawn_agent` and do **not** have `restore_file`, do not start. Stop and tell the user:

> Sub-agents are on, but Checkpoints are off, so I could not bring an agent's changes back into your project. Turn on Checkpoints (or the change protocol) in the settings and run this again. Or tell me to go ahead without agents, and I will do the tasks myself in this conversation.

Go on without agents only after they say so; then add "Agents: not used (no checkpoints)" to the working agreements (`sdd` action `set_project`) so the question is not asked at every task.

1. Spawn one agent. Its task is the task as `sdd` gave it, in full, and the rules above; its knowledge files are the task's files plus `.sdd/DECISIONS.md` and `.sdd/KNOWLEDGE.md`. Tell it not to call `sdd` and not to write under `.sdd/`. If the plan's verification is a command, give it as the agent's `check` (`command`, and `expect` when the output must show something), so "done" is tested and not claimed.
2. Ask it to end its report with: files changed, each verification command with its exit code and what the output showed, deviations from the plan, known issues, decisions made, and whether it found a blocker.
3. The agent worked on its own copy of the project. Its changed files come back as revisions. **Read them** (at least the diff of each against what the plan asked for), then adopt them into the workspace with `restore_file`.
4. **Run the plan's verification again in the real workspace.** The agent's check passed on its copy; the task is done when it passes here.
5. You record the task with `sdd`. An agent's files under `.sdd/` are not adopted.

Tasks of one slice run one after another, each seeing the summaries before it. Only tasks that the plan marks as not depending on each other, and that write different files, may run as one batch.

**With teammates as well (you have the `team_*` tools).** Use them for two things only:

- **Independent slices side by side.** When the roadmap has two or more unchecked slices that do not depend on each other and are both planned, spawn one teammate per slice, put each slice's tasks on the board with `team_task` and their `dependsOn`, and run the slices with `team_run_task` in `async` mode. Each teammate does its slice's tasks in order. You adopt and verify each task's result as it is handed back, exactly as in steps 3 to 5, and you mark the board task complete yourself. Slices that touch the same files are not independent, whatever the roadmap says: run those one after the other.
- **A reviewer for the slice.** One teammate, kept for the whole slice, that reads each adopted task against its plan and reports what does not match. It keeps what it learned from the earlier tasks. It reviews; it does not edit.

Shut the teammates down when their slices are closed.

**With neither.** Execute the task yourself, by the rules above. Work from the task as `sdd` gave it, not from what you remember of the planning.

## Record it

When the task's `Verify` command has passed **in the real workspace**, call `sdd` action **`complete_task`** with:

- `summary`: one line saying what now exists (also the commit message, if committing), then what was built, the files changed, any deviation from the plan, and known issues;
- `evidence`: the verification as it ran: the command, its exit code, and what its output showed. Paste the relevant output. Never write it from memory, and never for a command that did not run. The tool refuses a task without it.

A task whose check did not pass is not completed. If it cannot be done as planned, call `sdd` action **`block_task`** with `reason`: what was found, and the evidence. The next step is then a replan (`sdd-plan`), not the next task.

Also:

- record real decisions with `add_decision`, and anything a later task would otherwise trip over with `add_knowledge`;
- commit, if the working agreements say to, with the summary's first line as the message. Never commit secrets or build output.

Report in a few lines: what was built, the evidence, anything that deviated, and the next step as `sdd` gave it.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
