---
name: build-project
description: >-
  Builds the project open in the workspace, and its Docker image when the repo
  has a Dockerfile or a compose file. Discovers the build from the repo itself
  (its README, CI workflow, scripts, manifest), runs it, and reports the
  artifacts and the image tag. Use when the user asks to build or compile the
  project or its image, or before a deploy that needs an image.
disabled: true
---

# Skill: Build the Current Project

Builds whatever repository is open in the workspace. Nothing here assumes a language, a framework, a path or a tag: every value is **discovered from the repo first**, and the repo's own way of building always wins over a generic one.

Related skills, used when they are enabled; each also works alone:

- `docker-compose-deploy` runs the image or stack this skill builds.
- `run-project` builds if needed, starts the project and opens it.

## Step 0: Discover how this repo is built

Look, in this order, and stop at the first that answers:

1. **What the repo says.** `README*`, `CONTRIBUTING*`, `docs/`, an `AGENTS.md` or similar. A documented build command is the answer.
2. **What CI runs.** `.github/workflows/*.yml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`. The build job is a build known to work.
3. **Task runners.** `Makefile`, `justfile`, `Taskfile.yml`, the `scripts` in `package.json`.
4. **The manifest**, when nothing above names a command:

| Found | Install | Build |
|---|---|---|
| `package.json` | the manager whose lockfile exists: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile` | the `build` script, with the same manager |
| `*.sln`, `*.csproj` | `dotnet restore` | `dotnet build -c Release` |
| `pyproject.toml`, `requirements.txt` | the tool the repo uses (`uv`, `poetry`, `pip` in a virtual environment) | usually none; `python -m build` only if it ships a package |
| `go.mod` | — | `go build ./...` |
| `Cargo.toml` | — | `cargo build --release` |
| `pom.xml` | — | `mvn -B package` (use `./mvnw` if present) |
| `build.gradle*` | — | `./gradlew build` |

Also find, because the image build needs them:

| Value | Where |
|---|---|
| Dockerfile(s) | any `Dockerfile*`, and a compose service's `build:` (`context`, `dockerfile`, `target`, `args`) |
| Build context | the compose `build.context`, else the folder the Dockerfile's `COPY` paths are relative to; often the repo root even when the Dockerfile is in a subfolder |
| Image name | a compose `image:`, else a name the repo's scripts or CI use, else `<repo-folder-name>` in lower case |
| Build arguments | `ARG` lines with no default in the Dockerfile; compose `build.args` |

If the repo is a monorepo, build the part the user is working on or asked for; ask only when that is not clear.

## Step 1: Build the project

Run the install step, then the build, from the folder the manifest is in.

- Use the lockfile as it is. Do not delete it, regenerate it or upgrade dependencies to get a build through.
- Do not install tools globally or change the machine. If a required tool or version is missing, say which and stop.
- A build that fails on the code is a result to report with its error, not something to work around by disabling checks.

Skip this step when the Dockerfile builds the project itself (a multi-stage Dockerfile that runs the install and build inside the image) and the user asked only for the image.

## Step 2: Build the image

Only when the repo has a Dockerfile or a compose file. First check that Docker answers: `docker info`. If it does not, say that Docker is not running and stop.

**The repo has a compose file with `build:`** — let compose build it, so the context, the Dockerfile, the target and the arguments are the ones the repo defines:

```
docker compose build
docker compose build <service>      # one service
```

Run it from the folder the compose file is in, or pass `-f <path>`.

**Only a Dockerfile:**

```
docker build -f <path/to/Dockerfile> -t <image-name>:dev <build-context>
```

- `<image-name>:dev` is one name and one tag, for example `myapp:dev`. Use the same value everywhere afterwards.
- Pass each required build argument with `--build-arg NAME=value`. Never pass a secret as a build argument; it stays in the image history.
- If `COPY` fails with "not found", the build context is wrong, not the Dockerfile: the paths in `COPY` are relative to the context given as the last argument.

## Step 3: Verify

- The project build: the command exited 0 and the artifact it should produce exists (`dist/`, `bin/Release/`, `target/`, the binary).
- The image: `docker image ls <image-name>` lists the tag just built, with a creation time of now.

## Step 4: Report

Say what was built, in a form the next step can use:

- the build command that was run, and where;
- the artifacts and their path;
- the image as `<image-name>:<tag>`, or the compose services that were built;
- the port the Dockerfile `EXPOSE`s, if any.

## What goes wrong

- **The image build is slow or huge.** There is no `.dockerignore`, so `node_modules`, `.git` and build output are sent as context. Say so; add one only if the user agrees.
- **It builds locally and fails in the image.** A file the build needs is listed in `.dockerignore`, or the image has a different tool version than the machine.
- **A different architecture is needed.** An image built on an Apple Silicon or ARM machine is `arm64`. For an `amd64` target add `--platform linux/amd64`.
- **Compose ignores a code change.** `docker compose up` reuses an existing image; it is `docker compose build` or `up --build` that rebuilds.
