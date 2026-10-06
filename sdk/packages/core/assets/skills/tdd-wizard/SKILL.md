---
name: tdd-wizard
description: >-
  Guides the user into test-driven development from the start: learns about
  the project, takes an existing specification or writes one with the user
  through questions about goals and scope, then develops the test cases with
  them, generates the tests, validates them and writes them to the project.
  Ends by offering to carry on with the implementation, test run and coverage
  phases or to leave those to the user. Use when the user wants to start a
  project or a feature test-first, asks for a TDD wizard, or wants a
  specification turned into tests.
disabled: true
---

# Skill: TDD Wizard

Takes the user from an idea to a specification and a set of tests that describe it, ready for the code to be written against them. It is a guided conversation: the user decides, this skill asks, proposes, writes and checks.

Part of the TDD set: `tdd-gen` (implements from tests), `tdd-test` (runs them), `tdd-coverage` (finds what is untested). The wizard works when those are off.

## How to conduct it

- **One stage at a time, and stop at each gate.** Every stage ends with something the user confirms before the next begins. Do not run ahead.
- **Ask one question at a time**, or a small group about one topic. Where the likely answers are few, offer them as choices, with your recommendation first. Never send a questionnaire.
- **Do not ask what the repo can answer.** Read first.
- **Propose, do not interrogate.** When the user is unsure, suggest a concrete answer for them to accept or change.
- **Write no implementation code** in this skill. Its output is the specification and the tests.
- If the user wants to skip a stage or already has its result, take what they have and move on.

Say at the start, in two or three lines, what the stages are and that they can stop after any of them.

## Stage 1: The project

Read before asking: the README, the manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`, ...), the folder layout, the existing tests and their config.

Establish:

- **new or existing:** an empty or near-empty repo, or a feature for a project that already has code;
- **language and test framework.** Existing project: the ones it uses, and how its tests are named, placed and written. New project: ask for the language, then propose the framework that is the default for it (Vitest for TypeScript or JavaScript, pytest for Python, the built-in runner for Go and Rust, xUnit for .NET, JUnit for Java);
- **where tests go**, by the project's convention or the framework's;
- **what this session is about:** the whole project, or one feature of it.

**Gate:** state what you found in a few lines and have the user confirm or correct it.

## Stage 2: The specification

Ask first: **is there a specification already?** A file in the repo, a document to paste, an issue or a ticket.

**There is one.** Read it. Check it against the list below and ask only about what is missing or ambiguous. Offer to save an updated copy; do not rewrite the user's document unasked.

**There is none.** Build it with the user, a topic at a time:

1. **Goal:** what this is for, in a sentence or two. Who or what uses it.
2. **Scope:** what it does. Get this as concrete behaviours ("a user can reset a password by email"), not qualities ("secure", "fast").
3. **Out of scope:** what it deliberately does not do. This is as valuable as the scope; ask for it explicitly.
4. **Interfaces:** how it is used: functions, a command line, HTTP endpoints, a screen. The inputs and outputs of each.
5. **Rules:** validation, limits, calculations, states and what moves between them.
6. **Errors:** what can go wrong, and what must happen when it does.
7. **Constraints:** platform, dependencies it must or must not use, performance or data limits that are real requirements.

Do not go deeper than the user's project needs: a small utility has a short specification.

Then write the specification file. Default path `docs/SPEC.md`, or beside the feature for a single feature; ask if the repo suggests another place. Use this shape:

```markdown
# <Project or feature>: Specification

## Goal
## Scope
## Out of scope
## Interfaces
## Requirements
- **R1** <one behaviour, stated so that a test can prove it>
- **R2** ...
## Errors
- **E1** <condition> → <what must happen>
## Constraints
## Open questions
```

Each requirement:

- is one behaviour, not several joined by "and";
- is **testable**: it names an input or situation and an observable result. "Handles large files well" is not a requirement; "reads a 1 GB file without holding it in memory" is;
- has an id (`R1`, `E1`) that the tests will refer to.

Anything the user could not decide goes under **Open questions**, not into a requirement as a guess.

**Gate:** show the specification and have the user approve it or change it. Tests are written against the approved text.

## Stage 3: The test cases

Derive the cases from the specification, not from imagined code. For each requirement and each error:

- the **normal case**: typical input, the expected result;
- the **boundaries**: empty, zero, one, the maximum, the first and the last, exactly at a limit and just past it;
- the **invalid input** and the **error path** the specification names;
- for anything with state: the order of operations, and doing the same thing twice.

Present them as a table before writing any test code:

| ID | Requirement | Case | Input / situation | Expected |
|---|---|---|---|---|
| T1 | R1 | valid data | name and email given | user returned with an id |
| T2 | R1 | empty name | name is `""` | rejected: "Name is required" |

Then go through it with the user: is a case missing, is one wrong, is one not worth having? Ask in particular about expected values you had to assume, such as an exact error message, a rounding rule or an ordering. A specification gap found here goes back into the specification file.

Also settle with the user:

- **the interface the tests will call:** the names and signatures of the functions, classes or endpoints. The tests fix these, so they are a design decision; propose them and let the user adjust;
- **what is faked:** the clock, the network, the database, the file system. Prefer passing dependencies in over patching them.

**Gate:** the user approves the table and the interface.

## Stage 4: Generate the tests

Write the tests in the project's framework and in the style of its existing tests.

- One test per row of the table, named for the behaviour ("rejects an empty name"), with the requirement id in the name or in a comment so each test traces back to the specification.
- **Test behaviour through the public interface.** Assert on results and on what a caller can observe, never on private fields or on how the code is built inside.
- Arrange, act, assert; one behaviour per test. Rows that differ only in data become one table-driven or parameterised test.
- **Deterministic:** no sleeping, no real clock, no real network, no dependence on test order or on the machine.
- Import from where the implementation will live, following the project's layout. The file need not exist yet.
- Do not write the implementation, and do not write tests for behaviour the specification does not contain.

## Stage 5: Validate, then write

Before calling the tests done, check them:

1. **Trace:** every requirement and every error in the specification has at least one test; every test points to a requirement. List anything uncovered.
2. **They load:** run the test command (the `tdd-test` skill if it is enabled, else the framework's run-once form). The tests must be found and counted. A syntax error, a wrong import of the test framework itself or a config error is a defect in the tests: fix it.
3. **They fail for the right reason.** With no implementation, each test should fail because the code under test is missing or does not yet do the thing. That is the correct result here, and it is the "red" that test-driven development starts from.
4. **None passes already.** A test that passes with nothing implemented asserts nothing, or tests the wrong thing. Fix or remove it. (In an existing project a test may pass because the behaviour is already there; say which, and keep it.)
5. **Expected values match the specification**, row by row. Do not validate tests by adjusting them until they agree with something else.

In some languages the test file cannot even compile until the names it uses exist (Go, Rust, Java, C#, TypeScript with type-checking in the test run). Then say so, and ask before creating the minimum that lets it compile: the declarations with bodies that only raise "not implemented". That is scaffolding, not implementation.

If a framework has to be installed or configured first, say what will be added and ask before changing the project.

Write the test files, then report:

- the specification file;
- the test files, with the number of tests in each;
- the trace: requirements to tests, and anything left open;
- the result of the run: how many were found, and that they fail because the implementation is missing.

## Stage 6: What next

Offer the choice plainly:

1. **Continue now:** implement against these tests (`tdd-gen`), run the whole suite (`tdd-test`), then check coverage (`tdd-coverage`). Stop after each for the user to look, unless they say to go straight through.
2. **Take it from here themselves:** give the commands for each phase, so they can run them when they choose: implement from a test file with `tdd-gen` on that file, run tests with `tdd-test`, check coverage with `tdd-coverage`.
3. **Stop here:** the specification and the tests are the deliverable.

If the user continues and one of those skills is not enabled, do the phase directly by the same rules: write the least code that makes the tests pass **without changing the tests**, run them until green, tidy up on green, then measure coverage and propose tests for what is below 80%.

When requirements change later, the order stays the same: the specification first, then the tests, then the code.

## Credits

Written for Cerebriline, as the front end to the workflow described in "[Test-Driven Development with Claude Code: Practical Guide](https://aiskill.market/blog/tdd-with-claude-code)" by Duke Harewood (aiskill.market, January 28, 2026), whose `/tdd`, `/test` and `/coverage` commands are the basis of `tdd-gen`, `tdd-test` and `tdd-coverage`. The test-writing guidance in Stage 4 (behaviour over implementation, table-driven cases, injected dependencies, no timing) follows that article's patterns.
