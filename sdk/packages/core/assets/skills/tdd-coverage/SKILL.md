---
name: tdd-coverage
description: >-
  Measures test coverage and finds what is untested: runs the project's tests
  with coverage, lists the files, functions and branches below the threshold
  (80% unless the repo sets its own), and proposes a specific test for each
  gap, written out on request. Use when the user asks about coverage, missing
  tests, or what else should be tested before committing.
disabled: true
---

# Skill: Coverage and Missing Tests

Finds what the tests do not exercise and says which tests would close the gap. The user may name a file or folder to look at; with nothing named, the whole project.

Part of the TDD set with `tdd-wizard`, `tdd-gen` and `tdd-test`; it works on its own.

## Step 1: Run the tests with coverage

Use the repo's own coverage command if it has one (a `coverage` or `test:coverage` script, a Makefile target, the CI workflow). Otherwise:

| Framework | Command |
|---|---|
| Vitest | `npx vitest run --coverage` |
| Jest | `npx jest --coverage` |
| pytest | `pytest --cov=<package> --cov-branch --cov-report=term-missing` |
| go | `go test ./... -coverprofile=coverage.out` then `go tool cover -func=coverage.out` |
| cargo | `cargo llvm-cov` (or `cargo tarpaulin`) |
| dotnet | `dotnet test --collect:"XPlat Code Coverage"` |
| Maven / Gradle | the JaCoCo report task, if the build configures it |

- If the coverage tool is not installed (`@vitest/coverage-v8`, `pytest-cov`, `cargo-llvm-cov`), say which one is missing and ask before adding a dependency to the project.
- If tests fail, report that first. Coverage of a failing run is not worth analysing; the failures come before the gaps.
- Coverage output (`coverage/`, `htmlcov/`, `coverage.out`) is build output. Do not commit it; if the repo does not ignore it yet, say so.

## Step 2: Read the result

The threshold is the one the repo configures (the coverage section of its test config, or CI), and **80%** when it sets none. Find:

- files below the threshold, lowest first;
- functions and methods never called by any test;
- branches not taken: the `else`, the early return, the `catch`, the default case;
- from reading the code beside the report, cases a line count cannot show: boundaries (empty, zero, one, maximum), invalid input, the error paths.

Leave out what should not be counted: generated code, type-only files, configuration, the tests themselves. Say what was left out.

A high percentage is not the goal. A line that runs inside a test that asserts nothing about it is covered and untested; say so where you see it.

## Step 3: Propose the tests

For each gap, a test specific enough to write:

- what is untested, with the file and the lines;
- the behaviour the test would pin down, in one sentence;
- the test itself, in the project's framework and in the style of its existing tests.

Order them by what matters: untested error handling and core logic before getters and trivial branches. Group them by file.

Propose tests of **behaviour** through the public interface. Do not suggest reaching into private state to make a line turn green.

## Step 4: Report

```
Coverage: 73% lines, 61% branches (threshold 80%)

Below the threshold:
  src/services/payment.ts    45%
  src/utils/validation.ts    62%

Untested:
  payment.refund()             never called
  validation.isValidPhone()    empty input, international formats
```

followed by the proposed tests.

## Step 5: Write them, if asked

Do not write test files unasked. When the user says yes:

1. add the tests to the existing test file for that module, or create one where the project keeps its tests;
2. run them;
3. a new test for existing code should **pass**. If one fails, the code may have a real defect: show the user the test and the failure rather than changing either to agree;
4. run coverage again and report the new figures.

## Credits

Adapted from the `/coverage` command in "[Test-Driven Development with Claude Code: Practical Guide](https://aiskill.market/blog/tdd-with-claude-code)" by Duke Harewood (aiskill.market, January 28, 2026), including its 80% threshold and its report layout.
