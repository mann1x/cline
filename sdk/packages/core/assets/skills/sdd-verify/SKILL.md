---
name: sdd-verify
description: >-
  Verifies spec-driven work at the level that is due: closes a finished slice
  by running its verification and its acceptance checks, recording its
  summary and reassessing the rest of the roadmap; or
  audits a finished milestone against its success criteria and requirements
  and completes it only when everything is proved. Use when every task of a
  slice is done, when every slice of a milestone is done, when sdd-wizard says
  verification is next, or when the user asks to verify, validate or accept
  the work.
disabled: true
---

# Skill: Verify

Checks that what was built is what was promised. Tasks passing one by one does not show that the slice works, and slices passing does not show that the milestone delivers; this skill is where the assembled thing is tested against the plan and the result recorded.

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

## Which verification is due

Call `sdd` with action `next`:

- `close_slice` → **Part A**.
- `validate_milestone` → **Part B**.
- `complete_milestone` → **Part C**.

## The three levels of proof

- **Contract:** unit tests, types, lint. Each piece does what it says, alone.
- **Integration:** the pieces work together across their boundaries.
- **Operational:** it builds, starts, and the flow a user follows works end to end.

Passing one level says nothing about the next. A slice is closed on the first two; a milestone needs all three.

## Evidence, not opinion

Every check is recorded with what was run and what was seen. For each, choose the lightest thing that honestly proves it: a command and its exit code, a file's content, a request and its response, the running app. Verdicts are **PASS**, **FAIL** or **NEEDS-HUMAN**. What only a person can judge (how it looks, how it feels, whether the wording is right) is marked NEEDS-HUMAN with everything prepared for them; never invent a pass for it.

## Part A: Close a slice

1. **Run the slice's verification**, all of it, in the workspace (in the slice's worktree, if it was built in one; see "Merging an isolated slice" below): the project's tests, and each task's `Verify` command again now that they are all in. If a check fails, fix it and run again; a fix here is small and within the slice. If it cannot be fixed within the slice's plan, stop: the slice is not done, and it is replanned (`sdd-plan`).
2. **Check the goal, not the tasks:** is the slice's goal now true, end to end? Is each requirement it owns demonstrably met?
3. **Run the acceptance checks.** Write the cases for this slice, specific to what it built: each with its preconditions, its steps and the expected result, starting from the slice's demo. Run each, and note how it was checked and what was observed. Each ends as `pass`, `fail` or `needs_human`.
4. **Close it** with `sdd` action **`complete_slice`**:
   - `summary`: one line saying what a user can now do; what was delivered; the requirements met, with the evidence; and **forward intelligence** for the slices after this one — what is fragile, where the result differs from what the roadmap assumed, and what a later slice will trip over;
   - `uat`: one entry per acceptance check, `{check, result, note}`.

   The tool refuses to close a slice with a task not done, with no acceptance checks, or with a check that failed. A failed check means new tasks: `replan_slice`, execute them, and close again. A `needs_human` check does not stop the slice; tell the user exactly what to try, and how.

   Closing the slice marks the requirements it owns as validated.
5. **Record what was learned:** decisions with `add_decision`, lessons with `add_knowledge`, only where they would save a later step real work.
6. **Reassess the roadmap.** Read the summary just recorded against the slices still to be built:

   - did this slice settle the risk it was meant to?
   - did a new risk appear that should change the order?
   - are the boundaries between slices still what the roadmap says?

   The usual answer is that the roadmap stands, and one line saying so is the right output. Change it only on evidence, and only with the user's agreement: `add_slices` for new ones, `remove_slice` for one that is no longer needed and has no work in it. Completed slices are never changed.

### Merging an isolated slice

When the slice was built in a worktree (`.sdd/worktrees/M001-S01/`, branch `sdd/M001-S01`), steps 1 to 3 are run there. After the slice is closed:

1. Make sure everything in the worktree is committed on its branch.
2. In the main checkout, on the branch the user was on, check `git status --porcelain`: if they have uncommitted changes outside `.sdd/`, stop and ask before merging.
3. The first time, ask whether to merge verified slices without asking again, and record the answer under "Isolation" in the working agreements (`sdd` action `set_project`). Then:

```
git merge --squash sdd/M001-S01
git commit -m "<the slice summary's first line>"
```

4. **If the merge conflicts, stop.** Show the conflicting files and what each side changed. Do not resolve by taking one side wholesale, and do not abort the user's own work. Resolve with the user, or leave the slice unmerged, say so, and keep it with `sdd` action `capture` so it is not forgotten.
5. If the user's branch had moved since the worktree was created, run the slice verification once more on the merged result. A failure here is fixed before going on.
6. Only when the merge commit exists: `git worktree remove .sdd/worktrees/M001-S01` and `git branch -D sdd/M001-S01`. If the removal is refused because something is uncommitted there, look at what it is; do not force it.

Slices that ran side by side are merged one after another, each verified on the result of the one before. Never push.

With sub-agents, steps 1 and 3 can each be given to an agent with a fresh context, which is a better witness than whoever built the slice. With a slice reviewer teammate, ask it for its findings before step 2.

## Part B: Validate the milestone

An audit, not a rerun. `next` lists the requirements the milestone promised. Read the roadmap, every slice summary and acceptance result (under `.sdd/milestones/M###/`), the requirements and the decisions, and check:

1. **Success criteria:** for each one in the milestone's context, the evidence that it is met, from summaries, acceptance results or by running it now. No evidence means not met.
2. **Slice delivery:** for each slice, does its summary show what its demo promised?
3. **Integration:** do the boundaries line up? What one slice produces, the next actually consumes?
4. **Requirements:** every requirement of the milestone is validated, or explicitly deferred with a reason.
5. **Operational proof:** build it, start it, and walk the main flow end to end, now.
6. **Real change:** the milestone produced code, not only a plan.

Record it with `sdd` action **`validate_milestone`**: `findings` (the checklist, each slice against its claim, the integration findings, the requirement coverage) and a `verdict`:

- **`pass`:** everything is proved. Small gaps that do not block are listed in the findings and carried into the summary.
- **`needs_remediation`:** something promised is not delivered. Give `remediation`: the slices that fix it, in the form of a roadmap's slices. They are added to the roadmap, the next step is planning them (`sdd-plan`), and the audit runs again when they are done. Tell the user.

## Part C: Complete the milestone

Only with a passing audit; the tool refuses otherwise, and there is no override. If no code was changed, the milestone is **not** complete: say exactly that, and stop.

Call `sdd` action **`complete_milestone`** with `summary`: one line; what was built; each success criterion with its evidence; the requirements validated, deferred and changed; the key decisions and whether each still looks right; the key files; the lessons; the follow-ups.

Then tell the user what they now have and how to try it. Commit only if the working agreements say to. Never push, tag or publish without their explicit yes.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the order of the phases, and keeping the plan in a database that says which step is due are GSD's. These skills use their own engine and their own folder (`.sdd/`), and are not compatible with a `.gsd/` folder.
