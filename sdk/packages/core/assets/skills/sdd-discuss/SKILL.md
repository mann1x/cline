---
name: sdd-discuss
description: >-
  Turns an idea into an agreed specification, by conversation: asks for the
  vision, reflects it back, reads the codebase, asks focused rounds of
  questions until the goals, scope, users, definition of done, risks and
  external systems are clear, then records the project brief, the numbered
  requirements and the milestone context for the user to approve. Use at the
  start of a project or of a new milestone, when the user wants to discuss or
  change what is being built, or when sdd-wizard finds nothing planned yet.
disabled: true
---

# Skill: Discuss

The first phase of spec-driven development. Its product is agreement, on the record: what is being built, for whom, and what "done" means. Everything later is planned and checked against what this records. No code is written here.

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

## How to hold the conversation

- **Reflect before asking.** Show that you understood before you ask for more.
- **Investigate before asking.** Do not ask what the repository or the documentation can answer.
- **Ask in small rounds:** one to three questions on one topic, with choices where the likely answers are few and your recommendation first. Use the question tool if you have one. Never a questionnaire.
- **Use the user's words** in what you record. Later steps see only the record; a paraphrase loses what the user stressed.
- **Do not shrink the vision.** Do not ask for "the minimum version" or talk the user down. What is large or risky is placed in a later milestone, not cut.
- **A missing answer is not a yes.** The two approvals below cannot be skipped or assumed.

## Stage 1: The vision

Ask what they want to build, or what this milestone is for. Then reflect it back concretely:

- what you understood, in a few sentences;
- the main capabilities, as a list;
- an honest size: roughly how many milestones, and roughly how many slices in the first.

Have them confirm or correct it before going on.

For a vision that is clearly several milestones, map them first: a name, one line of intent and the dependencies for each. Then discuss the first in depth; the others are kept one line each (`sdd` action `capture`) and are discussed when their turn comes.

## Stage 2: Investigate

Before the first question round, look:

- **an existing project:** its README, manifest, layout, tests, the code this work will touch, and what earlier milestones recorded (`.sdd/DECISIONS.md` and `.sdd/KNOWLEDGE.md` above all);
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

Ask about what is out of scope as deliberately as about what is in. Do not ask "shall we wrap up?" after each round; go on until the six are covered or the user wants to stop. As soon as the first of these is confirmed, record the project with `sdd` action `set_project`, and call it again as more becomes clear: it replaces what was recorded, so an interrupted conversation loses nothing.

## Stage 4: Depth check

Print a structured summary of the six points, in the user's terms, and ask them to confirm that it is right and complete. **This is the first approval.** If they correct something, take it in and show the summary again.

## Stage 5: Requirements

Research briefly what such a thing normally needs that nobody mentioned: the behaviours users will expect, the standard pitfalls of the domain, what is commonly forgotten (errors, empty states, permissions, limits). Offer these as candidates; the user decides which are in.

Then draft the requirements and show the whole table in the chat **before recording any**:

| Requirement | Source | Status |
|---|---|---|
| one behaviour, stated so it can be proved | user / research / inferred | active / deferred / out of scope |

Each requirement is one testable behaviour: a situation and an observable result. "Fast" is not a requirement; "the list of 10,000 rows appears within one second" is.

**This is the second approval.** The user confirms, changes or adds.

## Stage 6: Record

Recheck the size estimate from Stage 1 against everything learned, and say so if it changed. Ask once, for the working agreements, whether they want a commit after each completed task. Then record, in this order, one `sdd` call each:

1. **`set_project`** with `name`, `description` (what it is, who it is for, and what exists and works today), and `agreements` (commit after each task: yes or no; the test command; isolation, asked at the first slice; anything else the user asked for).
2. **`add_requirement`** once per requirement: `title` (the behaviour, in one line), `description` (the situation and the observable result, and where it came from), and `status` when it is not active (`deferred`, `out_of_scope`). The tool numbers them.
3. **`add_decision`** once per choice made in the discussion: `title`, `choice`, and `why` (including what was set aside).
4. **`add_milestone`** with `title` and `context`. The context is the brief for everything that follows; write it with these headings, in the user's words:

```markdown
## Goal
## Why
## Who it is for
## In scope
## Out of scope
## Done looks like         <- success criteria, each one observable
## Unknowns and risks
## External systems        <- including any credential that will be needed, and who provides it
## Constraints
## Open questions
```

5. **`approve`** with `what: "requirements"` — only because the user approved them in Stage 5. If they have not, do not call it; `next` will ask for it.

Later milestones that were mapped in Stage 1 are kept with `capture`, one line each. Only one milestone is open at a time.

Then say what was recorded and what `sdd` says is next, which is planning the milestone (`sdd-plan`). Commit `.sdd/` only if the working agreements say to commit.

## Changing course later

When the user comes back to change what is wanted mid-project, run the same conversation, shorter: reflect, ask only what the change leaves unclear, show the changed requirements, get approval. Then record it: `add_requirement` and `update_requirement` (a requirement no longer wanted becomes `deferred` or `out_of_scope`; it is not deleted), `update_milestone` for the context, and `add_decision` for the change itself. A new active requirement takes back the approval, so call `approve` again once the user agrees. Slices already completed are not changed. The slices still to be built are then revised by `sdd-plan`.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
