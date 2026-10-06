---
name: tdd-test
description: >-
  Runs the project's tests the way the repo defines: finds the test framework
  and the repo's own test command, runs everything or just a given file,
  folder or test name, and reports what passed and what failed with expected
  against actual. Use when the user asks to run the tests, or to check whether
  a change broke anything.
disabled: true
---

# Skill: Run the Tests

Runs the tests of the repository open in the workspace and reports the result. The user may name a file, a folder or a test; with nothing named, run the whole suite.

Part of the TDD set with `tdd-wizard`, `tdd-gen` and `tdd-coverage`; it works on its own.

## Step 1: Find how this repo runs its tests

Take the first that answers:

1. **The repo's own command.** A `test` script in `package.json`, a `test` target in a `Makefile` / `justfile` / `Taskfile.yml`, a command in the README or in the CI workflow. This wins: it carries the flags and the setup the project needs.
2. **The framework, from its config:**

| Found | Framework | Run all | Run one file | Run one test by name |
|---|---|---|---|---|
| `vitest` in `package.json` | Vitest | `npx vitest run` | `npx vitest run <file>` | `npx vitest run -t "<name>"` |
| `jest` in `package.json` | Jest | `npx jest` | `npx jest <file>` | `npx jest -t "<name>"` |
| `mocha` in `package.json` | Mocha | `npx mocha` | `npx mocha <file>` | `npx mocha -g "<name>"` |
| `pytest.ini`, `[tool.pytest]` in `pyproject.toml`, `conftest.py` | pytest | `pytest` | `pytest <file>` | `pytest -k "<name>"` |
| `Cargo.toml` | cargo | `cargo test` | `cargo test --test <name>` | `cargo test <name>` |
| `go.mod` | go | `go test ./...` | `go test ./<package>/` | `go test ./... -run '<Name>'` |
| `*.csproj` with a test SDK | dotnet | `dotnet test` | `dotnet test <project>` | `dotnet test --filter "<name>"` |
| `pom.xml` | Maven | `mvn -B test` | `mvn -B test -Dtest=<Class>` | `mvn -B test -Dtest=<Class>#<method>` |
| `build.gradle*` | Gradle | `./gradlew test` | `./gradlew test --tests <Class>` | `./gradlew test --tests "<Class>.<method>"` |

With a `package.json`, run through the manager whose lockfile exists (`npm`, `pnpm`, `yarn`, `bun`). In a monorepo, run from the package the tests belong to.

If no framework can be found, say so and stop. Do not install one unasked.

## Step 2: Run

- **Run once, not in watch mode.** Several runners watch by default when started interactively (Vitest, Jest with `--watch`); a watching run never ends and the result never comes back. Use the run-once form (`vitest run`, `jest --watchAll=false`, `CI=true`). If the user asks for watch mode, give them the command to run in their own terminal.
- Run exactly what was asked for: the named file or test, else everything.
- If the run cannot start (a missing dependency, a syntax error, a config error), that is not a test failure: report it as what it is.

## Step 3: Report

Lead with the counts: passed, failed, skipped, and how long it took. Then, for each failure:

- the test's name and its file;
- expected against actual, or the error message;
- the line of the stack trace that is in the project's own code.

Do not paste the whole output when a few lines carry it. Report skipped and disabled tests as skipped; they are not passes.

**Do not fix anything.** This skill runs and reports. If the user then asks for a fix, the tests are the specification: change the code under test, not the test, unless the user says the test is the thing that is wrong.

## Credits

Adapted from the `/test` command in "[Test-Driven Development with Claude Code: Practical Guide](https://aiskill.market/blog/tdd-with-claude-code)" by Duke Harewood (aiskill.market, January 28, 2026).
