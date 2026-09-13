---
name: docker-compose-deploy
description: >-
  Deploys the current project to local Docker Desktop. Covers choosing the
  deployment method (docker compose up, or docker run of a pre-built image from
  the build-project skill), running the stack/container exactly as the repo's
  compose file or Dockerfile defines, and verifying the deployment.
disabled: true
---

# Skill: Deploy the Current Project to Docker Desktop

This skill **deploys** the **current project** (whatever repo is open in the workspace) to **local Docker Desktop**. It is deliberately **project-agnostic**: it first **discovers** how the repo defines its containers (compose file and/or Dockerfile + image), then stands them up and verifies them. It builds on the **build-project** skill, which produces the image.

> **Two deployment paths (choose based on discovery):**
> 1. **Compose stack** — the repo ships a `docker-compose*.yml`. Use `docker compose up -d` (preferred; the compose file encodes services, build, ports, volumes, env for you).
> 2. **Single container** — the repo has only a Dockerfile and an image built by the **build-project** skill. Use `docker run` with the discovered image tag, container name, ports, and env.

> **Related skills:**
> - `build-project` — build the project + Docker image (prerequisite: the image must exist before a single-container deploy; a compose `up` will build it on demand).
> - `run-project` — "run the project" (deploy if needed, then open the app in the default browser). Use this when the user wants to run/open the app.

---

## When to Use This Skill

- You need to stand the app(s) up on local Docker Desktop the way the repo defines them.
- You need to deploy a specific environment (Development / QA / Staging / Production) that the repo's config supports.
- You need to redeploy after a code change in one command.
- You need to verify the running container(s) (startup logs + HTTP reachability).

---

## Prerequisites

1. **Docker Desktop** must be running (`docker info` succeeds).
2. The image must exist (build it with the **build-project** skill if it is missing) — or, for a compose stack, the compose file builds it on `up`.
3. The repo must be checked out at the desired branch/tag.

---

## Step 0 -- Discover the Project's Deploy & Container Facts

Do **not** assume any project name, framework, path, image tag, or port. **Discover them from the repo** each time:

| Concern | How to discover | Command |
|---------|-----------------|---------|
| **Compose file** | Find any `docker-compose*.yml`/`docker-compose*.yaml`. If present, the compose path is preferred. | `list_files` pattern `**/docker-compose*` |
| **Image tag** | Reuse the tag chosen in the **build-project** skill (e.g. `<repo-name>:dev`), or the compose `image:`/service name. | See build-project / compose |
| **Container name(s)** | Compose service name(s); or your own `<repo-name>-<svc>` convention for a single container. | Compose `services:` keys / derive |
| **Ports / published ports** | Read `ports:` in the compose file, or the Dockerfile `EXPOSE` lines. The **web/front-end port** (the one to open in a browser) is usually the first published port or the service named `web`. | Compose `ports:` / Dockerfile `EXPOSE` |
| **Environment** | Compose `environment:`/`env_file`, or env vars the app reads (`NODE_ENV`, `ASPNETCORE_ENVIRONMENT`, etc.). | Compose / `.env` |
| **Required secrets** | Compose uses `${VAR:?...}` for required secrets. Provide them from the host env / secret manager — never invent or bake them. | Compose `environment:` |

> Record the discovered values (especially **image tag**, **container name(s)**, and **web port**) — the **run-project** skill reuses them.

---

## Step 1 -- Deploy

### Path A: Compose stack (preferred when a compose file exists)

```powershell
# From the directory that contains the compose file (commonly repo-root or docker/)
docker compose up -d
```

- `up -d` builds images from `build:` where needed, creates the networks/volumes, and starts the services in dependency order.
- To rebuild images from current source and recreate containers after a code change:
  ```powershell
  docker compose up -d --build
  ```
- To target a single service:
  ```powershell
  docker compose up -d <service-name>
  ```
- **Required secrets:** if the compose file uses `${SOME_VAR:?SOME_VAR is required}`, set `SOME_VAR` in the shell/environment first (or provide an `.env` alongside the compose file). Docker Compose fails fast if a required variable is unset — that is the safety net.

### Path B: Single container (`docker run` of a pre-built image)

Use the values discovered in Step 0 (image tag, container name, host port, container port, env):

```powershell
# Stop/remove any existing container with the same name first
docker rm -f <container-name> 2>&1

docker run -d `
  --name <container-name> `
  -p <hostPort>:<containerPort> `
  -e <KEY>=<value> `      # any env vars the app needs (env selection, connection strings, secrets)
  <image-tag>:dev
```

> Example (repo-root Dockerfile, HTTP port 8080 mapped to host 32798):
> ```powershell
> docker rm -f myapp 2>&1
> docker run -d --name myapp -p 32798:8080 -e NODE_ENV=production myrepo:dev
> ```
>
> For a stack with a front-end and backing services, prefer **Path A** (compose) — `docker run` only makes sense for a single self-contained service.

---

## Step 2 -- Verify the Deployment

```powershell
# List the running container(s)
docker ps --filter "name=<container-name>"

# Stream the logs and look for successful startup lines
docker logs --tail 100 <container-name>

# Confirm the web server is listening from the host
curl -s -o NUL -w "%{http_code}`n" http://localhost:<hostPort>/
```

A `200` or `3xx` (e.g. a redirect to login) means the web server is up. Look in the logs for lines like `Now listening on:`, `Server listening on`, or the app's startup banner. Access the app at `http://localhost:<hostPort>/` (and any documented sub-route such as `/login`).

> Background-service connection warnings in the logs are often **non-fatal** — the web server may still run and serve traffic. Confirm reachability over HTTP rather than assuming a log warning means the app is down.

---

## Step 3 -- Make a Change and Redeploy (iterative loop)

```powershell
# Compose stack: rebuild images + recreate containers
docker compose up -d --build

# Single container: rebuild image (build-project skill) then recreate the container
docker build -f <Dockerfile> -t <image-tag>:dev .
docker rm -f <container-name>
docker run -d --name <container-name> -p <hostPort>:<containerPort> <image-tag>:dev
```

---

## Step 4 -- Tear Down

```powershell
# Compose stack (removes containers/networks; keeps named volumes by default)
docker compose down

# Single container
docker rm -f <container-name>
```

---

## What Does NOT Work -- Universal Lessons

These hold for most containerised apps regardless of framework:

### HTTPS does not work out of the box in a CLI-started container

Many runtime base images (`dotnet/aspnet`, `node:*-slim`) do not include development HTTPS certificates — the IDE injects them via volume mounts, but a CLI `docker run` does not. The container often serves **HTTP only** from the CLI. Use **HTTP** (`http://localhost:<hostPort>`) for a script/CLI deployment, or mount a real certificate for the app's scheme.

### Missing required environment is a silent or immediate failure

If the app needs an env var/secret and it is not provided, it either **fails to start** (compose `${VAR:?}` refuses to run) or **starts but never serves** (the app waits/blocks on a missing config). Always set required env vars from the host env / secret manager before `up`/`run`, and verify over HTTP rather than trusting `docker ps` — a container can look "up" while serving nothing.

### The published port and the container port are different things

`-p <hostPort>:<containerPort>` maps a **host** port to the app's **container** port (the one from `EXPOSE`/the runtime default). Reach the app at the **host port**, not the container port. On Docker Desktop the host port is what you open in a browser.

### Secrets must never be baked into the image or a committed `.env`

For a production deployment, prefer environment overrides injected at run time. Never commit a new `.env` with real secrets.

---

## Quick Reference -- Full Working Sequence

```powershell
# 0. Discover: compose file? image tag? container name? web port? required env?
#    - list_files for docker-compose* / Dockerfile*

# 1. Deploy
cd <dir-with-compose-or-repo-root>
docker compose up -d          # Path A: compose stack (builds on demand)
# or (single container):
# docker rm -f <container-name> 2>&1
# docker run -d --name <container-name> -p <hostPort>:<containerPort> <image-tag>:dev

# 2. Verify
docker ps --filter "name=<container-name>"
docker logs --tail 100 <container-name>
curl -s -o NUL -w "%{http_code}`n" http://localhost:<hostPort>/

# 3. Redeploy after a code change
docker compose up -d --build

# 4. Tear down
docker compose down
```

---

## Discovery Checklist -- Where to Find Each Value

| Value | Where to find it | How to find it |
|-------|------------------|----------------|
| Compose file | `**/docker-compose*.yml` | `list_files` pattern `**/docker-compose*` |
| Container HTTP/web port | Compose `ports:` (host side) or Dockerfile `EXPOSE` | Read the compose file / Dockerfile |
| Container-internal port | Compose `ports:` (container side) or Dockerfile `EXPOSE` | Read the compose file / Dockerfile |
| Image tag | Compose `image:`/service name, or the tag chosen in build-project | Compose / build-project skill |
| Required backing services | Compose `services:` / app config binding | Read the compose file / app config |
| Required env/secrets | Compose `environment:` (`${VAR:?...}`) / `.env` | Read the compose file |

---

## Key Files to Check

| File | Role |
|------|------|
| `**/docker-compose*.yml` | Services, build, ports, volumes, env — the primary source of truth for a stack deploy. |
| `**/Dockerfile` | Multi-stage image build; `EXPOSE` ports; `ENTRYPOINT`/`CMD` (used at build time; see build-project skill). |
| `.env` (if any) | Environment variables / secrets referenced by the compose file. |
| App manifest / config | Per-environment config and the runtime port/env defaults. |
