---
name: sdd-wizard
description: >-
  The front door of spec-driven development: asks the sdd tool where the
  work stands, says so, and runs the next step, whether that is
  discussing a new project or milestone, planning a slice, executing a task or
  verifying. Runs one step at a time by default, or keeps going until the
  milestone is done or blocked when asked for auto mode. Use when the user
  wants to start or continue spec-driven development, says "what's next" or
  "continue", or asks to build something larger than a quick change in a
  planned, verified way.
disabled: true
---

# Skill: Spec-Driven Development

Builds software from an agreed specification, in verified steps: **discuss** what is wanted, **plan** it as a roadmap of slices, and for each slice **plan** its tasks, **execute** them one at a time and **verify** the result, then validate the whole milestone. Every step records what it decided and what it proved, so the next one starts from the record and not from memory.

This skill is the entry point. It asks where the project stands and does the next step.

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

## Step 1: Ask what is due

Call `sdd` with action `next`. The answer names the step:

| `next` says | What it is | Skill |
|---|---|---|
| `discuss_project` | nothing is recorded yet | `sdd-discuss` |
| `discuss_milestone` | every milestone is complete; what comes next? | `sdd-discuss` |
| `approve_requirements` | the user has to agree to the requirements | `sdd-discuss` |
| `plan_milestone` | cut the milestone into slices | `sdd-plan` |
| `approve_roadmap` | the user has to agree to the roadmap | `sdd-plan` |
| `plan_slice` | break the slice that is due into tasks | `sdd-plan` |
| `execute_task` | do the task that is due | `sdd-execute` |
| `resume_task` | a task was started and not finished | `sdd-execute` |
| `replan_slice` | a task is blocked | `sdd-plan` |
| `close_slice` | every task of the slice is done | `sdd-verify` |
| `validate_milestone` | every slice is done; audit the milestone | `sdd-verify` |
| `complete_milestone` | the audit passed | `sdd-verify` |
| `stuck` | no slice can start | put it to the user |

The instruction that comes with the step is specific to this project: the task's steps, its files, its verification command. Follow it together with the skill for that step.

If the user asked for something small and self-contained (a fix, a tweak, a one-file change), that is not a milestone: use `sdd-quick` and leave the plan alone.

## Step 2: Say where things stand

Before doing anything, call `sdd` with action `status` and tell the user in a few lines:

- the milestone and how many of its slices are done;
- the slice and how many of its tasks are done;
- the next step, and why it is that one;
- anything waiting on them: an approval, a blocker, an acceptance check marked for a person.

On a first run in a project, also say in three or four lines how this works: the phases, that they approve the requirements and the roadmap before any code is written, and that they can stop after any step.

## Step 3: Run the next step

**Guided (the default).** Do that one step, by its skill. When it ends, report what it produced and what `sdd` says the next step is, and stop. The user reads, then says to continue.

**Auto.** When the user asks for auto mode ("keep going", "run the milestone", "auto"), repeat: call `next`, do the step, record it. Call `next` every time; do not trust what you remember. Stop only when:

- `next` says the step **needs the user** (a discussion, an approval, a blocker that survived a replan, a slice that cannot start);
- the milestone is complete;
- a step needs something only the user has: an acceptance check only a person can judge, a missing secret or credential, a decision that would change scope;
- verification fails and three real attempts did not fix it;
- the user says stop.

Discussion and approval are never done in auto mode: the user's answers are the specification. Never call `approve` for them.

A long milestone will outgrow one conversation. That is expected and harmless: the database carries everything. When the conversation has become long, say so at the end of a slice and suggest continuing in a new chat with this skill.

## Agents

The steps are written so that work which should start with a clean context can be given to one:

- **With sub-agents** (you have `spawn_agent`): research, each task, and the plan reviews run in their own agents, as the phase skills describe. You stay the lead: you call `sdd`, hand out the work, and check what comes back. An agent's changes can only be brought back with `restore_file`, which exists when Checkpoints or the change protocol is on. If you have `spawn_agent` and not `restore_file`, say so before the first task is executed, and do not execute with agents until the user has turned Checkpoints on or told you to work without agents.
- **With teammates as well** (you have the `team_*` tools): slices that do not depend on each other can run side by side, one teammate per slice, and a reviewer can stay with a slice. `sdd-execute` says how.
- **With neither**: do each step yourself, one at a time.

With git available, a slice can also be built in its own worktree and merged when it is verified (`sdd-execute` and `sdd-verify` say how). It is optional, and skipped when the project is not a git repository.

Never assume an agent's claim. A task is done when its verification passed in the real workspace, and not before.

## Steering

At any point the user may change direction. A change to what is wanted goes into the plan first and only then into the work: `add_requirement` or `update_requirement`, `update_milestone` for the context, `add_slices` or `remove_slice` for the slices not yet built. A new requirement takes back the approval of the requirements, so the user is asked again. Completed slices and their records are not changed; a change to something already built is new work, planned like any other. A thought that is not for now is kept with `sdd` action `capture`, so it is not lost.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
