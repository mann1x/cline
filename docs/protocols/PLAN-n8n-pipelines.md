# Plan: pipelines on the task graph (native, preview, off by default)

Status 2026-11-26: approved by the owner 2026-11-26; phases 0, 1 and 2 built. Tracked as ol-173.
Replaces the 2026-11-25 draft, which drove a user's n8n server over MCP. The
owner ruled that out: there is no n8n server and none will be added, and an
n8n reached through MCP would be a thin slice of n8n at a large price in tool
schemas. **Direction (a)**, chosen 2026-11-26: Cerebriline runs pipelines
itself, on the task graph, adapting the designs of n8n, Node-RED and the
code-first engines. Nothing is installed beside the extension, and no
container or server is needed.

**Sources:**
- n8n 2.49 (docs.n8n.io, the npm package, the instance MCP server's tool
  reference: 68 tools in nine groups) and `@n8n/workflow-sdk` 0.42.
- Node-RED 4 (Apache-2.0, embeddable): flows, wires, `msg`, subflows,
  link nodes, catch and status nodes, context.
- Code-first engines read for their execution model, not as dependencies:
  Mastra workflows (Apache-2.0), LangGraph.js (MIT), xstate 5 (MIT),
  `@effect/workflow`. Rejected as runtimes because they need a server or a
  build step: Temporal, Restate, Inngest, Trigger.dev, Hatchet (servers),
  DBOS (Postgres), Workflow DevKit (a compiler transform).
- The owner's colleague's n8n board (screenshot, 2026-11-26), for the viewer.
- Cerebriline: the task graph (`PLAN-task-graph.md`, phases 0–5 built), its
  gates, claims and templates; `spawn_agent`, `spawn_swarm`, configured
  agents, teams; the per-provider tool selection (`shared/tool-selection.ts`);
  Features.

**Licences.** Designs are adapted, code is not copied. n8n is under the
Sustainable Use License, so none of its code comes in. Node-RED (Apache-2.0)
and LangGraph.js (MIT) code could be adapted with its notice kept; the plan
does not need to.

## What a single native tool gives up, and what it does not

The owner asked what offering one tool loses against n8n's raw surface. n8n's
MCP server has 68 tools; the table maps each group onto this plan.

| n8n group (tools) | here | notes |
|---|---|---|
| workflows (13): list, get, create, update, archive, publish, activate… | `pipeline list / show / save / validate`, files in Git | publishing is the person's approval (section 7); archiving is deleting a file |
| builder (11): SDK reference, validate, create from code, test… | `pipeline catalog / validate / test` | JSON, not SDK code: a schema the model already writes well |
| executions (2): execute, get | `pipeline run / status / stop / resume / runs` | runs are tasks on the board |
| credentials (2) | none | nodes use what the session already has: providers, MCP servers, `gh`, the shell's environment. No credential store |
| agents (17) | `agent` and `swarm` nodes | Cerebriline's own agents, teams and swarms |
| skills (8) | `tool` node calling `skills` | Cerebriline's skills |
| data tables (7) | items between nodes; run journals | no table store in this plan |
| instance (4), preferences (4) | none | there is no instance |

**What is lost:** n8n's ~400 integration nodes (Slack, Sheets, CRMs…) and its
credential vault. Cerebriline reaches outside systems through MCP servers,
`http` nodes and the shell; an integration n8n ships as a node is here an MCP
server or a command. Its webhook triggers are lost too: they need a listening
server.

**What is kept:** DAGs with branches, merges, loops and sub-pipelines; items
flowing between nodes; expressions; retries and error routes; waits for time,
people and events; pinned test data; a run history with every node's input and
output; versions; a canvas. The model writes one schema, not 68.

## Design

### 1. The switches

- **Features → "Pipelines (preview)"**, off by default, like Teammates and
  for the same reason: a schema on every request and a surface that only
  strong models use well.
- **Each provider's Tools section → "Pipeline"**, on by default. It lets the
  feature be enabled globally and then dropped for a provider that cannot
  handle it (a small local model) while a cloud model or qwen3.x 27B dense
  keeps it.
  - `tool-selection.ts` deliberately lists no tool that depends on another
    switch, because such an entry "does nothing until the first is on" and
    so misleads. This one is listed anyway, as the owner asked, and is drawn
    **disabled, with "needs Features → Pipelines"**, while the feature is off,
    so it never claims to do something it does not.
- **Off at either level means nothing pipeline-related reaches the model:**
  no `pipeline` tool, no pipeline rules in the system prompt, no `pipeline:`
  gate in the gate description, and runs shown on the board as ordinary
  tasks. The task graph is unchanged when pipelines are off.
- **CLI:** `--pipelines` / `CLINE_PIPELINES=1`; the provider's tool selection
  applies the same way.

### 2. A pipeline is a JSON file in the workspace

`.cerebriline/pipelines/<name>.pipeline.json`, versioned by the workspace's
Git: reviewed in pull requests, diffed, branched and reverted like code. No
paid source control.

```json
{
  "name": "review-and-ship",
  "description": "Three reviewers, merge findings, test, ask, ship",
  "inputs": { "branch": { "type": "string" } },
  "nodes": [
    { "id": "review", "type": "loop", "over": "{{ ['security','perf','api'] }}", "parallel": 3,
      "body": { "type": "agent", "agent": "reviewer", "task": "Review {{ $vars.branch }} for {{ $item }}" } },
    { "id": "merge", "type": "merge", "after": ["review"], "mode": "append" },
    { "id": "test", "type": "command", "after": ["merge"], "command": "bun test", "retry": { "max": 1 } },
    { "id": "ok", "type": "if", "after": ["test"], "when": "{{ $node.test.exit == 0 }}" },
    { "id": "ask", "type": "approval", "after": ["ok.true"], "message": "Ship {{ $vars.branch }}?" },
    { "id": "ship", "type": "command", "after": ["ask"], "command": "git push origin {{ $vars.branch }}" },
    { "id": "fix", "type": "agent", "after": ["ok.false"], "task": "Fix the failing tests: {{ $node.test.stderr }}" }
  ]
}
```

- **Edges are `after`**, which is the task graph's `depends`: a node's
  readiness is the board's readiness. A branch node's outputs are named ports
  (`ok.true`, `sw.<case>`, `x.error`), as in n8n.
- **Items, as in n8n.** Every node outputs `items` (a list of JSON values);
  the next node runs once per call with all of them, or once per item inside
  a `loop`. Node-RED's single `msg` is the one-item case.
- **Expressions** `{{ … }}` read `$vars`, `$item`, `$node.<id>` (items,
  `exit`, `stdout`, `text`), `$run` and `$env` (an allow-listed few). They are
  a small evaluator, not JavaScript: member access, indexing, comparison,
  boolean logic, arithmetic, string and list literals, and a fixed set of
  functions (`len`, `join`, `split`, `json`, `default`, `contains`). No
  `eval`, no `vm`, nothing a pipeline file can use to run code outside a
  `command` node, which goes through the shell's approval like any other.

### 3. The nodes

| type | does | from |
|---|---|---|
| `tool` | calls any tool the session offers, with its input; same approval and policies as the model's call | n8n's app nodes, through Cerebriline's tools and MCP |
| `agent` | a configured agent or an open spawn with a task; returns its report (text, or JSON when asked) | n8n's AI agent node; Mastra agent steps |
| `swarm` | `spawn_swarm` with members; returns each report | |
| `command` | a shell command (exit, stdout, stderr); approval as the shell's | n8n Execute Command; Node-RED exec |
| `http` | a request (method, url, headers, body); approval unless allow-listed | n8n HTTP Request |
| `set` | builds items from expressions | n8n Edit Fields; Node-RED change |
| `if` / `switch` | routes to named ports | n8n IF / Switch; LangGraph conditional edges |
| `merge` | waits for its inputs: `all` (default), `first`, `append`, `by-key` | n8n Merge |
| `loop` | runs its body per item, `parallel` at a time, collecting outputs | n8n Loop Over Items; Mastra `foreach` |
| `wait` | a task-graph gate: `timer:`, `human:`, `commit:`, `gh-pr:`, `gh-run:`, `run:` | n8n Wait; LangGraph interrupts |
| `approval` | a `human:` gate with a message and Approve / Reject ports | n8n's approval forms |
| `pipeline` | runs another pipeline with inputs; its output is the node's | n8n Execute Workflow; Node-RED subflows |
| `check` | an acceptance check (a command's exit, or an expression) that fails the node | the task graph's acceptance |

Per node: `retry {max, backoff}`; `onError`: `stop` (default), `continue`, or
`route` (to its `error` port); `timeout`. A pipeline-level `onFailure`
pipeline runs with the failed run's journal (n8n's error workflow; Node-RED's
catch node).

### 4. A run is a task on the board

- **`pipeline run` creates one task on the conversation's board**,
  "▶ review-and-ship #4", held by `pipeline:<run>` while the run is live:
  the model's status changes to it are refused (unless forced), it does not
  stop the model's own auto-start, and the close-out guard does not ask the
  model to close it. The run closes it: done with "7 nodes done, 2 skipped",
  cancelled with the error, or waiting when stopped.
- **The nodes are tasks on the run's own board** (a `TaskGraphStore` per
  run, rebuilt from the journal), one per node, `after` as `depends`, started
  and closed by the run with each node's output summary. Layers, Mermaid and
  the Graph tab work on it unchanged, and the viewer draws it.
  - *Changed while building phase 0 (2026-11-26):* the first design put the
    node tasks on the conversation's board as subtasks of the run's task.
    About 48 readers of that board (its text and counts, auto-start, Ready,
    the S3/S5 and close-out nudges, the team's claimable list, templates,
    memory export) would each have needed to filter them out. A board per
    run keeps that cost at zero.
- **Async.** `run` returns at once with the run id. A task the model is
  working can wait on it with the new gate `pipeline:<run>`, which opens when
  the run ends (and fails with its error), the same way `run:` waits on an
  agent.
- **Durable.** Each run appends to `.cerebriline/pipeline-runs/<run>.jsonl`
  (node started, items in, items out, error, attempt). A reload resumes from
  the journal: finished nodes keep their output; a node in flight is re-run
  when it is marked `idempotent`, and otherwise fails as "interrupted" and
  takes its `onError` (Temporal's lesson: replay what is safe, never guess).
  Runs live with the extension host, so a run pauses while VS Code is
  closed.
- **Concurrency.** Ready nodes run side by side up to `maxParallel` (default
  4; agent and swarm nodes also take the provider's parallel-session limit).

### 5. Testing and the run history

- **`pipeline test`** runs with pinned data: a node with `pin` returns it
  without running (n8n's pinned data), and `--until <node>` stops after a
  node. Side-effecting nodes (`command`, `http`, `tool` writes, `agent`) need
  a pin or an explicit `allowSideEffects` in a test run.
- **Partial re-run** from a node, reusing the journal's outputs before it
  (n8n's partial executions).
- **`pipeline runs`** lists past runs with status, duration and the failing
  node; `status <run>` shows one node's items in and out, bounded.

### 6. What the model calls: `pipeline`, one native tool

Native, not MCP: a single tool offered over MCP would add a server for no
gain, and native it shares the session's approvals, tools and board.

| action | does |
|---|---|
| `list` | pipelines with their approved version, last run, and whether the file differs from the approved version |
| `catalog` | the node types and their fields (so the schema need not carry them) |
| `show` | one pipeline, as JSON and as layers |
| `save` | writes a pipeline from JSON; validated (shape, unknown types, cycles, dangling `after`, expression syntax), and saved as a **proposed** version |
| `validate` | the same checks, without saving |
| `run` | starts the approved version with inputs; optional `task` to gate on it |
| `test` | a pinned, side-effect-safe run of the proposed or approved version |
| `status` / `stop` / `resume` / `runs` | one run; stop; resume a stopped or failed run from its failing node; the history |

The tool's description is short and points at `catalog`; the system prompt
gets a pipeline paragraph only when the tool is on.

### 7. Versions and approval

From the screenshot: plan versions, one marked approved, and changes the
model makes arrive as proposals.

- `save` by the model writes the file and records a **proposed** version.
  The person approves it in the viewer (diff against the approved version);
  approval records the file's hash in
  `.cerebriline/pipelines/approved.json`. Edits made by the person are
  approved as they save.
- **`run` uses the approved version only**; a file whose hash is not approved
  runs only through `test`, or after approval. Git keeps the history; the
  approval record says which version may run.
- `command`, `http` and `tool` nodes keep the session's own approvals at run
  time: approving a pipeline does not pre-approve a destructive command
  inside it, unless the person ticks "approve its commands for this run".

### 8. Board and pipeline, both ways

- **Board → pipeline.** "Save as a pipeline" on a board (or a branch of it):
  each task becomes an `agent` node with the task as its prompt, or a
  `command` node when its acceptance is a command; `depends` becomes
  `after`; gates become `wait` nodes. A plan worked out once becomes a
  reviewed, repeatable pipeline.
- **Pipeline → template.** A pipeline's layers become a task template
  (phase 3's templates), for work that should be done by the model rather
  than run.

### 9. The viewer and inspector

The owner's colleague's n8n board is the model: phase columns of step cards,
edges between them, a chat with the agent beside the canvas, versions with
an approved badge, and tabs. **One canvas for task boards and pipelines.**

- **Where:** an editor-area webview panel ("Open board", from the task panel
  and from a pipeline file), not the sidebar, which is too narrow for
  columns. The conversation stays in the sidebar beside it and serves as the
  agent chat.
- **Canvas:** columns are layers (the board's `layers`), cards show the
  node or task: type, target (file, agent, command), status chip, attempts,
  time; edges are `after`, colored by state; gates are small nodes on the
  edge. **Fit**, zoom, pan, minimap; **Auto-layout**. Built on
  `@xyflow/react` (MIT, React ≥18; the webview has 18.3), pinned at 12.12.1
  because 13.0 was ten days old when phase 3 was built, with
  `@dagrejs/dagre` 3.1.3 (MIT) for the layered layout. elkjs was rejected:
  EPL-2.0/GPL and 8 MB.
- **Inspector** (right pane, the selected card): its fields, editable for a
  pipeline node (validated as you type) and for a task (title, acceptance,
  gates, links, as the panel does today); its items in and out, logs and
  attempts from the journal; Retry, Skip, Re-run from here; for a task,
  Start / Done / Cancel / Resolve.
- **Editing:** drag a node type from the catalog, wire ports, delete;
  every edit goes to the file and is validated; the person's edits approve
  as they save, the model's arrive as proposals with Approve / Reject.
- **Tabs:**
  - Definition: the JSON, with validation errors;
  - Plan: the task board in list form;
  - Workflow: the canvas;
  - Run monitor: the live run, as a per-node timeline with a status for
    each node;
  - Activity: the journal and the board's events;
  - Report: a run's summary, with outputs and failures, to save or copy.

  The screenshot's Findings and Chains tabs belong to its domain (security
  findings, attack chains). Here a Findings-like view comes from the
  outcomes and notes of `check` and `agent` nodes, shown in Report.
- **Versions bar:** the approved version, proposals with their author and
  diff, and Approve / Reject.

## Phases

Each phase ends green (core, tools, webview, CLI suites), is deployed to
pandorum as a local vsix, and keeps the feature off by default.

0. **Engine core in `@cline/core` (`extensions/pipelines/`), no tool, no
   UI. Built 2026-11-26.** Format and validator, the expression evaluator, and the executor
   for `tool`, `command`, `set`, `if`, `switch`, `merge`, `loop`, `wait`,
   `approval` and `check` nodes. Also the journal with resume, runs as tasks
   on the board (one line on the model's board), and the `pipeline:` gate.
   Tests drive pipelines against a fake tool host.
1. **The switches and the tool.** Features → Pipelines, the per-provider
   Tools entry (disabled with its reason while the feature is off), the
   `pipeline` tool and its system-prompt paragraph, approval records, CLI
   `--pipelines` and `/pipelines`. The task panel shows run tasks. **Built
   2026-11-26.** As built:
   - Approval is the **Cerebriline: Approve Pipeline** command (quick pick,
     opens the file, modal confirm) and `/pipelines approve <name>`; never a
     tool. `/pipelines` also lists files and runs; both are in the CLI's
     command palette.
   - The `pipeline` tool has no tool policy of its own: a run needs the
     approved version, and every node is asked for under the session's
     policies and approval callback, so gating the tool would ask twice.
   - A Tools entry behind an off feature is drawn off and disabled with
     "Needs Features → Pipelines", and is left out of the header's count and
     token total.
   - A run's task shows in the task panel as held by `pipeline:<run>`, with
     its gates; a dedicated run row waits for the viewer (phase 3).
   - A reload does not resume runs by itself: `pipeline resume <run>` does,
     from the journal. Automatic pick-up on session start is left for
     phase 2, with the failure handling.
2. **Agents and failure handling.** `agent`, `swarm`, `pipeline` (sub-runs)
   and `http` nodes; retries, error routes, `onFailure`; `test` with pins and
   `--until`; partial re-run. **Built 2026-11-26.** As built:
   - `agent` calls the session's own `spawn_agent` (open spawn: `task`,
     `instructions`) or a configured agent's `subagent_<name>` tool (`agent`),
     waiting for it; `json: true` reads the answer (or its first fenced or
     bracketed block) as the items. `swarm` calls `spawn_swarm` (`instructions`,
     `tasks` as a list or an expression, or `task` with `count`); one item per
     worker's report. Both go through `callTool`, so a session without those
     tools fails the node saying so, and their approvals are the session's.
   - `http` (`url`, `method`, `headers`, `body`, `allowFailure`) asks the
     person for each request unless the `pipeline_http` policy auto-approves
     it (yolo's `*` does); a status outside 2xx fails it. Items: a JSON list
     as it is, otherwise `[{status, headers, body}]`.
   - `pipeline` runs another pipeline's approved version to its end (a test's
     sub-run is a test); its items are what its last nodes gave. Refused at
     save when it names itself, and at run time when the name is already on
     the stack or the stack is five deep. Stopping the parent stops it.
   - Every node: `retry {max, wait (1 s), backoff (2)}` (never after a stop);
     `onError`: `stop` (default), `continue` (items `[{error}]` on `out`) or
     `route` (`[{error, input}]` on the node's `error` output, which only
     then exists, so `"x.error"` is checked at save). An interruption found
     after a reload follows `onError` too.
   - `onFailure` (top level) starts that pipeline's approved version when a
     run fails, with `run`, `pipeline`, `node` and `error` as inputs; not for
     a stop or a test, and not for a pipeline already in the chain.
   - `test` takes `until`: nothing starts after that node, and the run ends
     done. `rerun` (run, node) is a new run that reuses every node's output
     from the old run except that node, the nodes whose JSON changed since
     (the journal now records the definition), and everything after either.
   - Pick-up after a reload: the session that started a run picks it up
     when the conversation starts again (`recoverInterrupted`, journals carry
     `session`); another conversation's runs and tests are left alone; a
     sub-run is closed as stopped, since its parent's node decides.
3. **The viewer, read-only.** The editor-area panel with the canvas for
   boards and pipelines, Run monitor, Activity, Report, and the inspector
   (read). **Built 2026-11-26.** As built:
   - **Cerebriline: Open Board** (palette; the title bar of a
     `*.pipeline.json`, which opens on that pipeline; **Open board** in the
     task panel's footer, through the board RPC's `open-viewer` op). One
     panel per window, an editor tab; the chat stays in the sidebar.
   - The panel is the chat's own webview bundle with `data-view="board"` on
     its root. The extension reads the data (`hosts/vscode/board-viewer/`):
     pipelines with `listPipelines`, the newest 40 journals folded with
     `foldJournal` (their last 500 events each, with the total), and the
     conversation's latest `task_graph` row, which the webview reads with the
     task panel's own parser. Pipeline runs never reach the chat webview, so
     the files are the record. Shapes in `src/shared/board-viewer.ts`.
   - It re-reads on a watcher over `.cerebriline/{pipelines,pipeline-runs}`,
     on every board change (core's `onTaskGraphChange`, through
     `board-viewer-hooks`), and when the tab comes back into view; 250 ms
     debounce, posted only while visible.
   - The rail lists the board, the pipelines (approved / changed since
     approval / not approved / does not validate, with their run counts) and
     the runs. Tabs by what is shown: the board has Workflow and Plan; a
     pipeline Workflow, Definition and Runs; a run Workflow, Run monitor,
     Activity, Report and Definition (the definition the run used, with a
     note when the file has changed since).
   - Canvas: dagre left to right; cards show type (or task id), status
     chip, target, attempts, time, priority / later / reused. Edges take
     their source's state: done, active (into a running node, animated),
     untaken (the branch the run did not fire), failed, skipped, pending.
     Gates are small nodes feeding their task. Fit, zoom, pan, minimap; the
     view refits for a new graph and when the inspector opens or closes.
   - Inspector, read-only: a node's state, fields, output (items, stdout,
     stderr, text) and its journal lines; a task's fields, acceptance,
     gates, links, files, notes, outcome, and the run that holds it.
   - Report is Markdown (nodes table, failures, what `check` and `agent`
     nodes found), copied or saved through a save dialog.
   - Colours are the VS Code theme's own variables, so light, dark and
     high-contrast follow the editor; below 760 px the rail becomes a picker
     and the inspector goes under the canvas.
4. **Editing and versions.** Canvas editing, the inspector's edits,
   proposals and approval, board → pipeline and pipeline → template.
5. **Measured.** A tg-bench-like set of pipeline tasks (write a pipeline from
   a description; run, fix and re-run a failing one; gate a task on a run),
   on qwen3.6 27B dense and on a cloud model. A model that fails it gets the
   per-provider switch off by default, as guidance.

## To decide

1. **Native engine on the task graph; no n8n, no server, no container.**
   (Decided 2026-11-26.)
2. **Gating:** Features off by default; per-provider Tools on by default,
   drawn disabled while the feature is off. (Decided 2026-11-26.)
3. **Pipelines are JSON** (`.pipeline.json`), not TypeScript code: a schema
   the model writes, validated before it is saved, with no compiler or AST
   interpreter.
4. **Expressions are a small evaluator, not JavaScript.** Code runs only in
   `command` nodes, under the shell's approval.
5. **The conversation's board holds a run as one task**; its node tasks are
   on the run's own board, for the viewer and `pipeline status`.
6. **Only an approved version runs**, outside `test`; nodes keep the
   session's own approvals at run time.
7. **The viewer is an editor-area panel** built on `@xyflow/react` and
   `@dagrejs/dagre`, shared by task boards and pipelines.
8. **No triggers beyond manual and the board in this plan.** Timers and cron
   while the extension runs are a later phase; webhooks need a listening
   server and are out.

## Risks

- **Surface on weaker models.** One tool with ten actions and a node catalog
  is a lot for a small model; the per-provider switch is the answer, and
  phase 5 says where to set it.
- **Side effects.** A pipeline can push, deploy or delete. Approved versions
  only, per-node approvals at run time, and side-effect-safe tests are the
  guard.
- **The board's cost.** Runs are one line on the model's board; the node
  tasks are not rendered to it.
- **Resume correctness.** A node in flight at a reload is re-run only when
  it says it is idempotent; otherwise it fails visibly.
- **Two editors of one file** (the model's `save` and the person's canvas).
  Each save validates against the file's current hash and is refused on a
  mismatch, as the editor tool refuses a stale read.
