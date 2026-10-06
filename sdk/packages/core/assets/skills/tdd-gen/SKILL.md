---
name: tdd-gen
description: >-
  Writes the implementation that makes existing tests pass, test-first: reads
  a test file, confirms the tests fail, writes the least code that satisfies
  them, runs them until green, then tidies up with the tests still passing.
  Never changes the tests. Use when the user has tests, or a test file from
  tdd-wizard, and asks to implement the code, make the tests pass, or do TDD.
disabled: true
---

# Skill: Implement from Tests

The tests are the specification. This skill turns a test file into the implementation it describes, in the red, green, refactor order. The user names the test file or folder; if they did not, ask which.

Part of the TDD set with `tdd-wizard`, `tdd-test` and `tdd-coverage`; it works on its own.

## The rule that makes this TDD

**Do not edit the tests.** Not to fix them, not to loosen an assertion, not to skip one. If a test looks wrong, contradicts another test, or cannot be satisfied, stop and show the user that test and why. They decide.

And the implementation must be real: it works for inputs the tests did not think of. Code that recognises the tests' own values and returns the expected answers for them passes and implements nothing.

## Phase 1: Read the tests

Read the whole file, and anything it imports from the project. Work out:

- what is under test: the modules, classes and functions, and **the import paths the tests use**, since those fix where the code must live and what it must export;
- each behaviour asserted, including the edge cases and the errors (the exact messages and types, if the tests check them);
- what is mocked or injected: those are the dependencies the code must accept, in the shape the mocks have;
- the framework, and how this repo runs its tests (the `tdd-test` skill if it is enabled; otherwise the repo's `test` script or the framework's run-once command).

## Phase 2: Red

Run the tests before writing anything, and check **why** they fail.

- Failing because the code does not exist yet, or does not do the thing: this is the expected start.
- Failing for another reason (a syntax error in the test, a missing test dependency, a broken config): that is not red, that is a broken test run. Report it; fix it only if it is outside the test file and plainly an environment matter.
- **Already passing:** say which. There is nothing to implement for those; do not rewrite working code.

## Phase 3: Where the code goes

If the file the tests import exists, read it and extend it. If not, create it at the path the import names, following how the rest of the project is laid out and written (naming, module style, error handling, typing).

## Phase 4: Green

Write the least code that makes the tests pass:

1. the shapes first: the exports, signatures and types the tests use;
2. then the behaviour, one group of tests at a time;
3. the edge cases and errors the tests cover.

Add nothing the tests do not ask for: no extra options, no speculative features. If something obviously needed is not tested (for example input the code would crash on), do not build it silently; mention it at the end as a test worth adding.

## Phase 5: Run until green

Run the tests. For each failure, read expected against actual, fix the implementation, run again. Run only the file being worked on while iterating.

If the same test still fails after three real attempts, stop and show the user the test, the current code and the failure. Do not keep trying variations, and do not reach for the test file.

When the file is green, **run the whole suite once**: new code must not break what was passing before.

## Phase 6: Refactor

Only on green. Remove duplication, improve names, simplify what is tangled, add types where the project uses them. One change at a time, with the tests run after each; if one goes red, undo that change.

Do not refactor code that this session did not write, beyond what the change needs.

## Report

- the test file, and how many tests it holds;
- the first run: how many failed, and that they failed for the right reason;
- the files created or changed;
- the final run: the counts for this file and for the whole suite;
- what was refactored;
- anything untested that the user should know about, as suggested tests.

If `tdd-coverage` is enabled, offer it as the next step.

## Credits

Adapted from the `/tdd` command in "[Test-Driven Development with Claude Code: Practical Guide](https://aiskill.market/blog/tdd-with-claude-code)" by Duke Harewood (aiskill.market, January 28, 2026): the six phases are that article's. The rule against editing the tests, the check on why a test fails and the stop after three attempts were added here.
