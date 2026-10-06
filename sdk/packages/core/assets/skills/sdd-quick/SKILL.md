---
name: sdd-quick
description: >-
  Does a small, self-contained change without the planning ceremony of
  spec-driven development: reads the relevant code, makes the change properly
  with its tests and error cases, verifies it, and leaves a short written
  record. Does not touch the roadmap. Use for a targeted bug fix, a small
  tweak or a one-off change in a project that uses spec-driven development,
  or when the user asks for a quick task.
disabled: true
---

# Skill: Quick Task

For work that does not deserve a milestone: a targeted fix, a small change, a short exploration. No discussion rounds, no roadmap, no slice. The standard of the work is the same as for any planned task.

Part of the spec-driven set: `sdd-wizard` (where am I, what is next), `sdd-discuss`, `sdd-plan`, `sdd-execute`, `sdd-verify`, `sdd-quick`, `sdd-status`. Each works when the others are off; where this skill hands over to one that is not enabled, do that step directly by the rules given here.

## Is it quick?

Yes, when it is one clear change that can be done and verified in one sitting and touches a handful of files.

No, when it needs a design decision, changes what the product does for its users, spans several parts of the system, or the user cannot say what "done" is. Then say so and suggest `sdd-discuss`; do not grow a quick task into an unplanned feature.

## Do it

1. **Restate the task** in one line, and what will show it is done. Ask only if that is genuinely unclear.
2. **Read before changing:** the code involved, and if the project has a `.sdd/` folder, its `DECISIONS.md` and `KNOWLEDGE.md`, so the change follows what was already decided.
3. **Make the real change.** No placeholders. Error cases and edge cases get the same care as the normal path. Add or update a test when the code has tests.
4. **Stay on the task.** Something else that looks wrong is mentioned, not fixed.
5. **Verify:** run the relevant tests and whatever shows the change works. When a check fails, one hypothesis and one change at a time; after three attempts that did not fix it, stop and report.
6. **Record it** in `.sdd/quick/Q###-SUMMARY.md`, with the next free number (create the folder if needed; in a project without `.sdd/`, give the same summary in the reply instead):

```markdown
# Q001 <title>
<one line: what changed>
## Why
## Files changed
## Verification                <- command, exit code, what it showed
## Noticed but not changed
```

7. If the change taught something a later task would trip over, add a line to `KNOWLEDGE.md`. If it contradicts a recorded decision, stop and ask before making it.
8. Commit only if the project's working agreements (in `.sdd/PROJECT.md`) or the user say to: one commit, with the summary's first line as its message. Never commit secrets or build output, and never push without an explicit yes.

The roadmap, the requirements and the slice plans are not touched by a quick task. If the change does affect a requirement or a planned slice, it was not quick: say so.

## Credits

Adapted from [Get Shit Done (GSD 2)](https://getshitdone.help/), source at [gsd-build/GSD-2](https://github.com/gsd-build/GSD-2). The milestone, slice and task hierarchy, the planning files and the order of the phases are GSD's. GSD is a program that keeps its state in a database and dispatches each step itself; these skills keep the state in the files alone, in a folder of their own (`.sdd/`), and are not compatible with a `.gsd/` folder.
