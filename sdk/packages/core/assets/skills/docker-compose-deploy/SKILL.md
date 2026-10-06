---
name: docker-compose-deploy
description: >-
  Deploys the project open in the workspace to local Docker (Docker Desktop or
  a local engine). Covers choosing the deployment method (docker compose up, or
  docker run of an image built from the repo's Dockerfile), running the stack
  or container exactly as the repo's compose file or Dockerfile defines, and
  verifying the deployment. Use when the user asks to deploy, redeploy or tear
  down the project's containers.
disabled: true
---

# Skill: Deploy the Current Project to Docker Desktop

This skill **deploys** the **current project** (whatever repo is open in the workspace) to **local Docker** (Docker Desktop, or a local Docker engine). It is deliberately **project-agnostic**: it first **discovers** how the repo defines its containers (compose file and/or Dockerfile + image), then stands them up and verifies them.

Commands are written once where they are the same in every shell. Where PowerShell and bash differ, both forms are given: use the one for the shell you are in.

> **Two deployment paths (choose based on discovery):**
> 1. **Compose stack** — the repo ships a `docker-compose*.yml` or `compose*.yml`. Use `docker compose up -d` (preferred; the compose file encodes services, build, ports, volumes, env for you).
> 2. **Single container** — the repo has only a Dockerfile. Build the image from it, then use `docker run` with the discovered image name, container name, ports, and env.

> **Related skills** (built in; used when they are enabled, and this skill works without them):
> - `build-project` — build the project + Docker image (the image must exist before a single-container deploy; a compose `up` builds it on demand). If it is not enabled, build the image with the `docker build` command in Step 1, Path B.
> - `run-project` — "run the project" (deploy if needed, then open the app in the default browser). Use that one when the user wants to run/open the app.

---

## When to Use This Skill

- You need to stand the app(s) up on local Docker Desktop the way the repo defines them.
- You need to deploy a specific environment (Development / QA / Staging / Production) that the repo's config supports.
- You need to redeploy after a code change in one command.
- You need to verify the running container(s) (startup logs + HTTP reachability).

---

## Prerequisites

1. **Docker** must be running: `docker info` succeeds. If it does not, say that Docker is not running and stop; do not try to start or install it.
2. The image must exist (build it first if it is missing, see Path B) — or, for a compose stack, the compose file builds it on `up`.
3. The repo must be checked out at the desired branch/tag.

---

## Step 0 -- Discover the Project's Deploy & Container Facts

Do **not** assume any project name, framework, path, image tag, or port. **Discover them from the repo** each time:

| Concern | How to discover | Command |
|---------|-----------------|---------|
| **Compose file** | Find any `docker-compose*.yml`/`.yaml` or `compose*.yml`/`.yaml`. If present, the compose path is preferred. | `list_files` patterns `**/docker-compose*` and `**/compose*.y*ml` |
| **Image name** | A compose `image:`, else the name already built for this repo, else `<repo-folder-name>` in lower case. Written with its tag as `<image-name>:dev`, e.g. `myapp:dev`. | Compose / `docker image ls` |
| **Container name(s)** | Compose service name(s); or your own `<repo-name>-<svc>` convention for a single container. | Compose `services:` keys / derive |
| **Ports / published ports** | Read `ports:` in the compose file, or the Dockerfile `EXPOSE` lines. The **web/front-end port** (the one to open in a browser) is usually the first published port or the service named `web`. | Compose `ports:` / Dockerfile `EXPOSE` |
| **Environment** | Compose `environment:`/`env_file`, or env vars the app reads (`NODE_ENV`, `ASPNETCORE_ENVIRONMENT`, etc.). | Compose / `.env` |
| **Required secrets** | Compose uses `${VAR:?...}` for required secrets. Provide them from the host env / secret manager — never invent or bake them. | Compose `environment:` |

> State the discovered values in your reply (especially **image name**, **container name(s)**, and **web port**): nothing is remembered between skills, so whatever runs next reads them from there.

---

## Step 1 -- Deploy

### Path A: Compose stack (preferred when a compose file exists)

```
# From the directory that contains the compose file (commonly repo-root or docker/),
# or from anywhere with: docker compose -f <path/to/compose-file> up -d
docker compose up -d
```

- `up -d` builds images from `build:` where needed, creates the networks/volumes, and starts the services in dependency order.
- To rebuild images from current source and recreate containers after a code change:
  ```
  docker compose up -d --build
  ```
- To target a single service:
  ```
  docker compose up -d <service-name>
  ```
- If `docker compose` is not a known command, the machine has the older standalone tool: use `docker-compose` with the same arguments.
- **Required secrets:** if the compose file uses `${SOME_VAR:?SOME_VAR is required}`, set `SOME_VAR` in the shell/environment first (or provide an `.env` alongside the compose file). Docker Compose fails fast if a required variable is unset — that is the safety net.

### Path B: Single container (`docker run` of an image built from the Dockerfile)

Use the values discovered in Step 0 (image name, container name, host port, container port, env). Each command is one line, so it is the same in every shell:

```
# Build the image if it does not exist yet, or the source changed
# (the last argument is the build context: the folder COPY paths are relative to)
docker build -f <path/to/Dockerfile> -t <image-name>:dev <build-context>

# Remove an earlier container of the same name. Only one this deployment created:
# if the name belongs to something else, pick another name instead.
docker rm -f <container-name>

# One -e per variable the app needs (environment selection, connection strings, secrets)
docker run -d --name <container-name> -p <hostPort>:<containerPort> -e <KEY>=<value> <image-name>:dev
```

`docker rm -f` prints "No such container" when there was none; that is not a failure.

> Example (repo-root Dockerfile, HTTP port 8080 mapped to host 32798):
> ```
> docker build -t myapp:dev .
> docker rm -f myapp
> docker run -d --name myapp -p 32798:8080 -e NODE_ENV=production myapp:dev
> ```
>
> For a stack with a front-end and backing services, prefer **Path A** (compose) — `docker run` only makes sense for a single self-contained service.

---

## Step 2 -- Verify the Deployment

```
# Compose stack: every service should be "running" (or "healthy")
docker compose ps
docker compose logs --tail 100 <service-name>

# Single container
docker ps --filter "name=<container-name>"
docker logs --tail 100 <container-name>

# Confirm the web server answers from the host
curl -s -o /dev/null -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<hostPort>/      # bash, zsh
curl.exe -s -o NUL -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<hostPort>/        # PowerShell, cmd
```

In PowerShell write `curl.exe`: plain `curl` there can be an alias for a different command that does not take these options. An app needs some seconds after its container starts, and a request sent at once fails: the `--retry` options make curl ask again for up to about half a minute, so run the check as written.

A `200` or `3xx` (e.g. a redirect to login) means the web server is up; a `401` or `403` also means it is answering. Look in the logs for lines like `Now listening on:`, `Server listening on`, or the app's startup banner. Access the app at `http://localhost:<hostPort>/` (and any documented sub-route such as `/login`).

> Background-service connection warnings in the logs are often **non-fatal** — the web server may still run and serve traffic. Confirm reachability over HTTP rather than assuming a log warning means the app is down.

---

## Step 3 -- Make a Change and Redeploy (iterative loop)

```
# Compose stack: rebuild images + recreate containers
docker compose up -d --build

# Single container: rebuild the image, then recreate the container
docker build -f <path/to/Dockerfile> -t <image-name>:dev <build-context>
docker rm -f <container-name>
docker run -d --name <container-name> -p <hostPort>:<containerPort> <image-name>:dev
```

---

## Step 4 -- Tear Down

```
# Compose stack (removes containers/networks; keeps named volumes by default)
docker compose down

# Single container
docker rm -f <container-name>
```

Do not add `-v` / `--volumes` to `down`, and do not prune volumes, unless the user asks: that deletes the stack's data (databases, uploads).

---

## What Does NOT Work -- Universal Lessons

These hold for most containerised apps regardless of framework:

### HTTPS does not work out of the box in a CLI-started container

Many runtime base images (`dotnet/aspnet`, `node:*-slim`) do not include development HTTPS certificates — an IDE's own "run in Docker" injects them via volume mounts, but a CLI `docker run` does not. The container often serves **HTTP only** from the CLI. Use **HTTP** (`http://localhost:<hostPort>`) for a script/CLI deployment, or mount a real certificate for the app's scheme.

### Missing required environment is a silent or immediate failure

If the app needs an env var/secret and it is not provided, it either **fails to start** (compose `${VAR:?}` refuses to run) or **starts but never serves** (the app waits/blocks on a missing config). Always set required env vars from the host env / secret manager before `up`/`run`, and verify over HTTP rather than trusting `docker ps` — a container can look "up" while serving nothing.

### The published port and the container port are different things

`-p <hostPort>:<containerPort>` maps a **host** port to the app's **container** port (the one from `EXPOSE`/the runtime default). Reach the app at the **host port**, not the container port: the host port is what you open in a browser. If the host port is already taken (`port is already allocated`), choose another host port for a single container; for a compose stack, tell the user what holds the port rather than editing the compose file or stopping something this deployment did not start.

### Secrets must never be baked into the image or a committed `.env`

For a production deployment, prefer environment overrides injected at run time. Never commit a new `.env` with real secrets.

---

## Quick Reference -- Full Working Sequence

```
# 0. Discover: compose file? image name? container name? web port? required env?
#    - list_files for docker-compose* / compose*.y*ml / Dockerfile*
docker info                   # Docker must answer

# 1. Deploy
cd <dir-with-compose-or-repo-root>
docker compose up -d          # Path A: compose stack (builds on demand)
# or (single container):
# docker build -f <path/to/Dockerfile> -t <image-name>:dev <build-context>
# docker rm -f <container-name>
# docker run -d --name <container-name> -p <hostPort>:<containerPort> <image-name>:dev

# 2. Verify
docker compose ps             # or: docker ps --filter "name=<container-name>"
docker compose logs --tail 100 <service-name>     # or: docker logs --tail 100 <container-name>
curl -s -o /dev/null -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<hostPort>/     # bash, zsh
curl.exe -s -o NUL -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<hostPort>/       # PowerShell, cmd

# 3. Redeploy after a code change
docker compose up -d --build

# 4. Tear down
docker compose down
```

---

## Discovery Checklist -- Where to Find Each Value

| Value | Where to find it | How to find it |
|-------|------------------|----------------|
| Compose file | `**/docker-compose*.y*ml`, `**/compose*.y*ml` | `list_files` with those patterns |
| Container HTTP/web port | Compose `ports:` (host side) or Dockerfile `EXPOSE` | Read the compose file / Dockerfile |
| Container-internal port | Compose `ports:` (container side) or Dockerfile `EXPOSE` | Read the compose file / Dockerfile |
| Image name | Compose `image:`, or the name the image was built with | Compose / `docker image ls` |
| Required backing services | Compose `services:` / app config binding | Read the compose file / app config |
| Required env/secrets | Compose `environment:` (`${VAR:?...}`) / `.env` | Read the compose file |

---

## Key Files to Check

| File | Role |
|------|------|
| `**/docker-compose*.y*ml`, `**/compose*.y*ml` | Services, build, ports, volumes, env — the primary source of truth for a stack deploy. |
| `**/Dockerfile` | Multi-stage image build; `EXPOSE` ports; `ENTRYPOINT`/`CMD` (used at build time). |
| `.env` (if any) | Environment variables / secrets referenced by the compose file. |
| App manifest / config | Per-environment config and the runtime port/env defaults. |
