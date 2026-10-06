---
name: run-project
description: >-
  Runs the project open in the workspace and opens it: starts it the way the
  repo defines (its Docker compose stack or image, or its own start or dev
  command), waits until it answers, and opens the app in the default browser.
  Use when the user asks to run, start, launch or open the project or the app.
disabled: true
---

# Skill: Run the Current Project

"Run the project" means: get it running the way this repo intends, confirm it answers, and put it in front of the user. Every value is **discovered from the repo**; none is assumed.

Related skills, used when they are enabled; each also works alone:

- `build-project` builds the project and its image.
- `docker-compose-deploy` starts and verifies the containers.

## Step 0: Decide how this repo runs

Look, in this order, and take the first that applies:

1. **What the repo says.** `README*`, `docs/`, an `AGENTS.md` or similar. A documented way to run it is the answer, including when it is not Docker.
2. **A compose file** (`docker-compose*.yml`, `compose*.yml`) → run it as containers.
3. **A Dockerfile and no compose file** → run the image as one container.
4. **No Docker files** → run it natively, with the repo's own command:

| Found | Start command |
|---|---|
| `package.json` | the `dev` script, else `start`, with the manager whose lockfile exists |
| `*.csproj` of a web or console app | `dotnet run --project <path>` |
| `manage.py` | `python manage.py runserver` |
| a Python app with `uvicorn`, `flask` or `streamlit` in its dependencies | that tool's run command, on the app module the repo names |
| `go.mod` with a `main` package | `go run .` or `go run ./cmd/<name>` |
| `Cargo.toml` with a binary | `cargo run` |
| `pom.xml` / `build.gradle*` with Spring Boot | `./mvnw spring-boot:run` / `./gradlew bootRun` |

If the project is not something that serves a page (a library, a command-line tool, a batch job), run it the way the repo documents, show its output, and skip the browser steps. If there is nothing to run, say so.

## Step 1: Start it

**Containers (cases 2 and 3).** Follow the `docker-compose-deploy` skill if it is enabled. Otherwise:

```
docker info                                   # Docker must answer first
docker compose up -d                          # compose stack; builds what is missing
# or, one container from a Dockerfile:
docker build -t <image-name>:dev <build-context>
docker rm -f <container-name>                 # only a container this skill created earlier
docker run -d --name <container-name> -p <host-port>:<container-port> <image-name>:dev
```

Add `--build` to `docker compose up -d` when the source changed since the image was built.

**Natively (case 4).** Install dependencies first if they are missing (`node_modules` absent, no virtual environment), with the lockfile as it is. Then start the command **so that it keeps running**: a dev server never exits, so start it in the background or detached and do not wait for it to finish. Keep its output where it can be read back.

In both cases, if the project needs configuration it does not have (a required variable in the compose file, a `.env.example` with no `.env`), say what is missing and ask. Do not invent secrets.

## Step 2: Find the address

| Running as | Where the port is |
|---|---|
| compose | the **host** side of the service's `ports:` (`"8080:80"` → 8080); `docker compose port <service> <container-port>` prints the real one |
| one container | the host port given to `-p` |
| natively | the line the server prints on start (`Local: http://localhost:5173`, `Now listening on: ...`), else the framework's default, else the repo's config |

With several services, the one to open is the web front end: the service named `web`, `frontend`, `app` or `ui`, or the one whose port the README names. Open the path the README names if it is not `/`.

## Step 3: Wait until it answers

Starting is not running: a request sent the moment the process starts fails. Ask until it answers; the `--retry` options make curl do that for up to about half a minute:

```
curl -s -o /dev/null -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<port>/          # bash, zsh
curl.exe -s -o NUL -w "%{http_code}" --retry 15 --retry-delay 2 --retry-all-errors http://localhost:<port>/            # PowerShell, cmd
```

Any `2xx` or `3xx` is up; `401` and `403` also mean a server is answering. If nothing answers, read the output (`docker compose logs --tail 100 <service>`, `docker logs --tail 100 <container-name>`, or the dev server's output), report the error and stop. Do not open a browser on an address that does not answer.

## Step 4: Open it

| System | Command |
|---|---|
| Windows (PowerShell) | `Start-Process "http://localhost:<port>/"` |
| Windows (cmd) | `start "" "http://localhost:<port>/"` |
| macOS | `open "http://localhost:<port>/"` |
| Linux desktop | `xdg-open "http://localhost:<port>/"` |

When there is no desktop to open a browser on (an SSH session, a container, a remote workspace), do not try: give the URL, and say that the port may need forwarding.

## Step 5: Report

- the URL;
- how it was started, and how to stop it: `docker compose down`, `docker rm -f <container-name>`, or how to end the background command;
- anything in the startup output the user should know.

## What goes wrong

- **The port is taken.** The start fails with "address already in use" or "port is already allocated". Find what holds it and tell the user; do not stop a process or container this skill did not start. For a single container, another host port is a fine answer.
- **It was already running.** Then say so and open it; restart only if the source changed or the user asks.
- **The page is HTTPS-only in the README.** A container started from the command line usually has no development certificate and serves HTTP only. Use the `http://` address.
- **A container is "up" and serves nothing.** `docker ps` shows a started process, not a working app. Step 3 is the check that counts.
