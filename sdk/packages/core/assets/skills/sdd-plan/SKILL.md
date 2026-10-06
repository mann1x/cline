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

Plans the work so that whoever executes it needs nothing but the plan. It works at two levels and does the one that is due: a **milestone** becomes a roadmap of slices; a **slice** becomes tasks. No product code is written here.

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

## Which plan is due

Call `sdd` with action `next`:

- `plan_milestone` → **Part A**.
- `approve_roadmap` → show the roadmap and ask (the end of Part A).
- `plan_slice` → **Part B**, for the slice it names. Slices added by a failed audit are planned the same way.
- `replan_slice` → **Part C**.

If `next` says `discuss_project`, `discuss_milestone` or `approve_requirements`, planning has nothing to stand on yet: say so and go to `sdd-discuss`.

## Part A: The roadmap

Read the milestone's context and the requirements (in the answer of `next`, and in `.sdd/REQUIREMENTS.md`, `.sdd/DECISIONS.md`, `.sdd/KNOWLEDGE.md`), the summaries of earlier milestones, and the code this milestone will touch. Research to the depth the uncertainty deserves: a small feature in a known codebase needs a look at the relevant files; new technology or an unfamiliar system needs the documentation read and the alternatives weighed. With sub-agents, give a broad survey to one and have it report the files, the patterns and the natural seams.

Then cut the milestone into slices, by these rules:

- **Vertical.** Every slice delivers something a person could see working, end to end through whatever layers it needs. Not "the database layer", not "the API": a capability.
- **Risk first.** The earliest slices prove the riskiest assumptions, through real working features and not throwaway spikes.
- **Honest count.** As many slices as the milestone's ambition needs. One for a simple feature; several for something that promises several capabilities.
- **Every active requirement of this milestone lands somewhere:** owned by a slice, or explicitly deferred, blocked with a reason, or moved out of scope. A requirement that silently belongs to nothing is a planning failure.
- **Dependencies are stated**, and nothing depends on a later slice.

Record it with `sdd` action **`plan_milestone`**, `slices` in order, each with:

- `title`;
- `goal`: what is true when the slice is done, the risk it settles (high, medium or low), and what it produces that a later slice consumes;
- `demo`: what a person can see or do when it is done;
- `depends`: the earlier slices it needs, e.g. `["S01"]`;
- `requirements`: the requirement ids it delivers, e.g. `["R001", "R004"]`.

The tool refuses a roadmap in which an active requirement belongs to no slice, or a slice depends on a later one. Fix the roadmap, or with the user's agreement defer the requirement (`update_requirement`), and call again.

Then **show the roadmap to the user** as a table (slice, title, risk, depends on, what can be demonstrated) and ask whether to build it this way. To change it, call `plan_milestone` again: it replaces the roadmap as long as it is not approved. When the user agrees, call **`approve`** with `what: "roadmap"`. Never before.

Record the structural choices (the order and why, technology picked, scope left out) with `add_decision`. If the milestone needs credentials or accounts the user must provide, list them now, with where each is obtained, so they are ready before execution; never invent or write a secret value.

A roadmap with a single slice goes straight on to Part B in the same sitting, once it is approved.

## Part B: One slice

Slices are planned one at a time, when they are due, so that each plan can use what the earlier slices found. The tool refuses to plan a slice before its turn.

### B1. Research

`next` gives the slice's goal, its demo, and the summaries of the slices already done. Read those, the requirements it owns, and then the code. Match the depth to the work:

- **light:** well-understood work on patterns the codebase already has. Fifteen lines saying "this is straightforward, follow the pattern in `<file>`" is the right research.
- **targeted:** known technology that is new to this codebase.
- **deep:** new technology, an unfamiliar API, a risky integration, unclear scope.

Write the research as text, for a planner who has no memory of the exploration: what exists (the specific files and what is in them), the patterns to follow, the seams where the work divides into tasks, what to build or prove first, the pitfalls, and the commands that verify the slice. It goes into `plan_slice` as `research`.

With sub-agents, research is one agent's job: it reads and reports; you record its report.

### B2. Tasks

Break the slice into tasks. Each task is the **whole contract** for whoever executes it: they are given that task and a line about the slice's goal, and nothing else. So everything needed is in it.

- **Size:** two to five steps and three to eight files. Ten steps or twelve files means it is two tasks.
- **Order:** each task's output unblocks the next. If the slice has tests, the first task creates them, failing.
- **Paths are exact,** in backticks. "The auth module" is not a path.
- **Done is checkable:** a command that exits 0, or an observable result. Not "works correctly".
- **Real, not stubbed:** a task that says "create a login endpoint" means one that authenticates against a real store. Mocks belong in tests.

Each task has:

- `title`;
- `steps`: the numbered steps; then **Must have** (the behaviours that have to hold, including the error cases), **Done when** (observable and checkable) and **Out of scope** (what this task must not touch);
- `files`: the files to read first and the files to create or change, exact paths;
- `verify`: the **one command** whose output proves the task. Required: the tool refuses a task without it;
- `expect`: what that output shows when the task is done (exit 0, "12 passed").

### B3. Audit the plan

Before recording it, check, and fix the plan if a check fails:

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

A flag does not block. Write the flagged handling into the `steps` of the task it belongs to.

Then record the plan with `sdd` action **`plan_slice`**: `research` and `tasks`, in order. Record any structural decision with `add_decision`.

## Part C: Replan after a blocker

A blocker is a finding that makes the remaining plan invalid: the API does not do what was assumed, a capability is missing, the architecture cannot take it. A bug or a failing test is not a blocker; that is ordinary work.

`next` gives the blocker as the executor reported it. Read the slice's state. Then call `sdd` action **`replan_slice`** with `reason` (what was found, what changes, why) and the new `tasks`. Tasks already done are kept as they are; the tool replaces only the ones that are not, and numbers the new ones after them.

If `next` says the slice was already replanned once, it needs the user: put the blocker to them before planning again. If the finding changes what the slice can deliver, or touches a requirement, stop and tell the user before going on.

Then say what was planned and what `sdd` says the next step is. Commit `.sdd/` only if the working agreements say to commit.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
