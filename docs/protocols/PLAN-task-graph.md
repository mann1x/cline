# Plan: a task graph per conversation (replaces `task_progress`)

Status 2026-11-20: decisions taken (see [Decided](#decided)), not started.
Tracked as claude-hooks task ol-162. Sources:

- claude-hooks' task system as of `f81e77e` (`docs/tasks.md`,
  `docs/PLAN-task-graph.md`, `claude_hooks/tasks/`), which took its graph
  model from [beads](https://github.com/gastownhall/beads).
- beads' README, for what claude-hooks deliberately left out.
- Cerebriline's own checklist: `sdk/packages/core/src/extensions/tools/task-progress.ts`,
  the tracker and guards in `local-runtime-host.ts`, `TaskProgressPanel.tsx`.
- The upstream agent-teams board: `team_task` in `extensions/tools/team/`.
- Not to be confused with upstream's `tasks` tool (`core/src/tasks/`): durable
  cross-session Todos and scheduled runs in SQLite. It is unrelated, stays as it
  is, and the new tools are named so they cannot be mistaken for it.

**Two goals, equal weight:** a better structure, *and* models actually using
it. The checklist's real failure is usage. 66% of sessions never write one,
and the rest stop updating it. The structure is worth little if the harness
does not get models to work the board, solo or in a team, which is why
nudges and their measurement are a phase of their own (section 10).

## Why

The checklist is a flat list of lines, re-sent in full on any tool call and
replaced whole each time. It does what it was built for, keeping a plan in front of
the model, but it cannot hold long work:

- **No structure.** It has no ids, no dependencies, no sub-steps, no notes and
  no outcome. "Fix the parser, then the renderer, which needs the parser"
  cannot be said, so the model re-derives the order every turn.
- **It is short and it rarely changes.** Pandorum archive, 262 sessions and
  13,650 tool calls:
  - 90 sessions (34%) kept a checklist.
  - The median list has 3 items (p90 5, max 10).
  - The median session sent its list 9 times but changed it only twice. Most
    sends are output tokens spent re-sending an unchanged list.
- **It costs on every request.** The parameter is added to every tool's schema:
  about 625 characters, roughly 174 tokens, per tool. At about 30 tools that is
  about 5k tokens of fixed price on every request (to be measured, phase 0),
  on a 65k window where tool schemas are already the largest fixed cost.
- **It does not survive compaction by itself.** The durable copy is the
  transcript (`findLatestTaskProgress`). After a full compaction the list
  exists only if the summarizer copied it verbatim, which
  `full-compaction.ts` has to ask for in capital letters.
- **Agent teams have a second, separate board.** `team_task` has
  `dependsOn`, claim, complete and block, and was **never called**: 0 calls
  in 13,650, including the 18 sessions with teams enabled.

## Scope

**One conversation**, with everything that belongs to it:

- its compactions;
- reloads and resumes;
- edit-and-resend, which starts a new session from a truncated history;
- its subagents and teammates.

**Not** a project's task list that outlives conversations; claude-hooks
already does that for Claude Code sessions. Hence no project prefixes, no
cross-project index, no worktree ownership, no embeddings or prompt recall,
and no mailbox.

## What carries over from claude-hooks

| claude-hooks feature | Here | Why |
|---|---|---|
| Task: title, description, acceptance checklist, priority, status, log | **Keep** | The core of it. The log is where results go. |
| Statuses pending / active / waiting / done / cancelled | **Keep** | Blocked is computed, never stored. |
| `depends`, cycle refusal, "unresolved blocks" | **Keep** | The graph. Cycles are refused on every write. |
| `task-ready` with an urgency order | **Keep, simplified** | Priority, active, blocking others, creation order. No age or due date: a conversation is hours, not months. |
| `task-graph` layers (layer 0 can start now; a layer can run in parallel) and the blocked view | **Keep** | This is what lets a lead hand layer 0 to teammates at once. |
| Typed links: parent, discovered-from, related, caused-by, supersedes, duplicate-of | **Keep** | `parent` becomes the hierarchy (below). supersedes / duplicate-of close the replaced task. |
| Attachments (commit, file, url, plan) | **Keep, plus `message`** | A link to a chat message lets the panel jump to where the work happened. |
| Gates | **Adapt** to what a conversation waits on | Below. `mail:` goes; `run:`, `command:` and `human:` arrive. |
| Closing a task reports "Ready now: …" | **Keep** | In the tool result, and to a teammate holding the unblocked task. |
| Claims | **Keep, for subagents and teammates** | One conversation can have several agents working the same board. |
| Defer to a date | **Adapt** to `later` | Out of `ready`, with its children, until un-parked. Dates mean little within a conversation. |
| Session-start block, prompt mentions, Stop nudge | **Adapt** | They become the board injection, and the guards Cerebriline already has (below). |
| Files as the record, hand edits win | **Adapt** | The record is an event log in the session folder. The person edits from the panel, not in a file. |
| Mirror of Claude Code's TaskCreate, transcript importer | **Adapt** | Becomes a one-time import of an old session's `task_progress` checklist. |
| Index, prefixes, embeddings, recall, cross-project, worktrees | **Drop** | Out of scope by design. |

From beads, not in claude-hooks:

- **Hierarchical ids.** Epic `T3`, steps `T3.1` and `T3.2`, sub-step `T3.1.1`.
  The id says where a task sits without a lookup. A small model reads `T3.2`
  more reliably than a `parent` field.
- **Memory decay for closed tasks.** In the board the model sees, a closed task
  shrinks to one line with its outcome. Past a count, closed tasks shrink to a
  number. The full record stays a `show` away.
- **`prime`.** One block that says how to work the board *and* what is on it.
  It is re-injected after every compaction and on resume.
- **Atomic claim.** Claiming sets the owner and makes the task active in one
  step, so two teammates cannot start the same task.

## Design

### 1. The task

```text
T3.2  "Wire the board into the reminder"
  status: active          # pending | active | waiting | done | cancelled
  priority: H             # H | M | L
  depends: [T2]           # blocks until each is done or cancelled
  links: {discovered-from: T3.1, file: [src/x.ts], message: [1795…]}
  gates: [run:r-7]        # blocks until it opens
  claimed_by: lead        # or a teammate / subagent id
  later: false
  acceptance: [x] reminder shows active + ready, [ ] cost under 300 tokens
  log: turn 41 pending → active; turn 44 note "…"; turn 52 done "…"
```

- **Ids are `T<n>`, children `T<n>.<m>`.** They are never renumbered or reused
  within a session, a cancelled task included.
- **Blocked is derived:** an open dependency, an open gate, or a `later`
  ancestor.
- **`done` takes an outcome note.** It is asked for, not refused: the note is
  what the board shows when the task decays to one line.

### 2. Storage: an event log beside the session

- **The log.** `<session>.tasks.jsonl` sits next to `<session>.json` and
  `<session>.messages.json`. It holds one event per change (create, status,
  note, link, gate, check, edit). Each event carries its author (`model`,
  `user`, or an agent id) and the **message it was made in**. The state is the
  fold of the events.
- **Rewind and fork.** Edit-and-resend and checkpoint restore start the new
  session from a truncated history. The new session gets the events up to that
  message, and the board matches the conversation the model now sees. A plain
  file overwritten in place could not do this.
- **Compaction never touches it.** The board is re-injected after every
  compaction, so the summarizer no longer has to carry the list. The
  "copy checklists verbatim" clause can stay for everything else.
- **Resume** folds the log. **Old sessions** with no log import their latest
  `task_progress` checklist once, as top-level tasks, keeping the ticks.
- **Teams.** Teammates and subagents write to the lead's log through the host,
  never into a file of their own. One board, one order of events.

### 3. What the model calls: three tools, and nothing on every tool

claude-hooks has 13 task tools. On the models Cerebriline targets, each schema
is fixed price on every request and one more name to confuse. Three tools,
shaped by what models already send:

| tool | input | does |
|---|---|---|
| `task_plan` | `tasks: [{title, description?, acceptance?, depends?, parent?, priority?, start?}]` | Creates one or many tasks in one call. Inside a batch, `depends: ["#1"]` and `parent: "#1"` refer to earlier items, so the whole plan, with its order, goes in one call before any id exists. Returns the ids and the layers. |
| `task_update` | `updates: [{id, status?, note?, check?, uncheck?, depends_add?, depends_remove?, link?, gate?, priority?, title?, description?, later?}]` | Changes one or many tasks in one call. Start, wait, done and cancel are `status`. Returns what changed, plus "Ready now: …" when a close unblocked something. |
| `task_view` | `view?: ready \| show \| graph \| blocked`, `id?` | Read-only. Defaults to `ready`. |

- **Readers are lenient on purpose**, as the checklist's became over the
  archive:
  - a single object where an array is expected;
  - `"done"` / `"completed"` / `"in_progress"` mapped to our statuses;
  - an id written `t3` or `#3`.
  The archive showed a strict reader silently drops a third of what models send.
- **The `task_progress` parameter is removed from every tool schema, and the
  standalone `task_progress` tool is removed.** The parameter made every call
  bigger and harder to form, and it was re-sent unchanged most of the time.
  Keeping the board current becomes the harness's job: it asks at the moment
  an update is due (section 10), not on every call.
- **A habitual send is still read, never advertised.** A model trained on the
  old shape, or a stale user template, may still send `task_progress`. The
  capture decorator reads it from the raw input before the tool strips unknown
  keys, and maps it onto the graph: an item matched by title updates that task,
  an unmatched one creates a top-level task. Phase 3 counts these sends; the
  reader goes once they reach zero.

### 4. What the model sees: the board

- **Content.** One block, capped at about 300 tokens:
  - counts;
  - the active tasks;
  - the top 5 ready ones, each with what it unblocks;
  - blocked ones as `T4 after T3.2`;
  - closed ones decayed to `T1 done: <outcome>`, then to a number.
- **When it is sent:**
  - always after a compaction, on resume, and when the person changed the
    board;
  - otherwise only with a nudge that needs it (section 10). The fixed
    every-6-calls reminder goes: an unchanged board re-sent on a timer is the
    same waste as an unchanged checklist re-sent on every call.
- **Edits from the person.** After a turn in which the person edited the board
  from the panel, the next request says what they changed ("You cancelled T5;
  added T7 under T3"), so the model is not left working from a stale plan.

### 5. Guards: the ones that exist, pointed at the graph

- **Close-out** (`createTaskProgressCompletionGuard`, two different asks): a
  run that ends with active or ready tasks open is asked to close them (done
  with an outcome, or cancelled with a reason), or to say why they stay open.
  Same budget of two.
- **Untracked edit** (`buildUntrackedEditNudge`): the workspace changed while
  no task is active. "Missing" becomes "no task is active"; "finished" becomes
  "every task is closed".
- **Done with unticked acceptance.** The result names the unticked items. It
  does not refuse, because the model may know better; the item stays visible.

Per the standing rule, none of these guards is tightened without archive data
first.

### 6. Gates: what a conversation waits on

| gate | opens when | checked |
|---|---|---|
| `run:<id>` | a teammate run or subagent finishes (`team_run_task`, delegated agents) | as it ends |
| `command:<id>` | a background command exits, on hosts that run them | as it ends |
| `human:<what>` | the person answers: a reply to the question that named it, or "Resolve" in the panel | as it happens |
| `commit:<sha>@<branch>` | the branch contains the commit | before each request (cheap: `merge-base`) |
| `timer:<ISO time>` | the time passes | before each request |
| `gh-pr:` / `gh-run:` | merged / succeeded | on `task_view` only; never on the request path |

A gate that can no longer open (the run failed, the PR was closed) is logged
once and stays, for the model or the person to remove.

### 7. Subagents and teammates: one board

- **Claims.** `task_update {status: active}` from a teammate is an atomic
  claim. A task held by a live run is refused to anyone else unless forced; the
  force is logged. A claim ends with its run.
- **Handing work out.** The lead hands layer 0 of `task_view graph` to
  teammates. Each finish reports "Ready now: …" to the lead, and to the
  teammate holding a newly unblocked task through the team mailbox the SDK
  already has.
- **`team_task` stays a separate tool, on the graph's store.** Its schema and
  actions (create, list, claim, complete, block) are unchanged for a lead and
  its teammates. Its runtime methods (`createTask`, `claimTask`, `completeTask`,
  `blockTask`, `listTaskItems`) read and write the conversation's graph instead
  of the team envelope's own task array. A task created with `team_task` is a
  `T<n>` on the board and in the panel; a task planned with `task_plan` can be
  claimed with `team_task`.
  - Its statuses map one to one: pending, in_progress → active,
    blocked → waiting with a `human:` or note reason, completed → done.
  - `dependsOn` is `depends`.
  - The team envelope keeps everything else: members, runs, mailbox, outcomes.
  - One store, so the two can never disagree.

### 8. The panel

`TaskProgressPanel` becomes the task panel:

- **Header:** `Tasks 3/7 · 1 active · 2 blocked`.
- **List:** a tree by hierarchy, with status chips, `after T3` for blocked
  tasks, a ready marker, and the claimant's name on teammate work.
- **Graph tab:** the layers, with an optional Mermaid drawing.
- **Detail:** description, acceptance, log, and links. A link to a message
  scrolls the chat to it; a link to a file opens it.
- **No editing in phase 1.** The panel shows the board. Editing arrives in
  phase 2: add, rename, re-prioritise, cancel, mark done, park / un-park,
  resolve a `human:` gate. Each is an event authored by `user`, and the model
  is told (section 4).
- **Export to memory, phase 2, when Memory is configured.** Section 11.
- **Chat rows:** one compact row per task change, as the `task_progress` row
  is today.

### 9. Everything else a new tool touches

- **SDK.** New module `@cline/core` `extensions/tools/task-graph/`, containing
  the store (log + fold + rewind), the tools, the board renderer and the guards.
  `TaskGraphTracker` replaces `TaskProgressTracker` in `local-runtime-host.ts`.
  The SDK option is `taskGraph: {enabled, reminderInterval, writeInterval}`,
  with the plugin's defaults: an SDK session runs what the plugin runs.
- **CLI.** A `/tasks` command prints the board.
- **Setting.** "Task graph" replaces the checklist switch. The intervals keep
  their current values.
- **Prompt templates.** `default.md` gets a `# tool:` section for each of the
  three tools; then all 11 built-in templates. Then the drift and audit
  scripts: sync, generate, audit.
  - automaticum now compares `request.tools` against a template's sections at
    the first request (D157). On 4.100.288 it found `task_progress` and
    `restore_file` without a section in every built-in.
  - Removing the `task_progress` tool ends half of that. The three new tools
    must not repeat it, so the shipped-templates test gains "every live tool
    has a section in every built-in".
- **The six lists** a new tool has to reach:
  - definitions, types and constants;
  - routing (`TOOL_NAME_TO_FLAG`);
  - presets (every `enable*` defaults to true, so set them deliberately);
  - the plan-mode guard (the graph tools are allowed in plan mode: planning is
    their point);
  - shipped signatures;
  - `LIVE_TOOLS`.
- **Release notes** in each phase's commit.

### 10. Getting models to use it: nudges

The harness decides when the board needs attention and says so at that
moment, rather than asking for a list on every call. Two channels, chosen by
what the nudge is about:

- **In the tool's own result** when the nudge is about the call just made: a
  write, a passing test, a close. It is read right where the work is, and it
  costs no extra turn.
- **As a system message** when there is no call to attach it to: the start of
  work, the end of a run, after a compaction.

Each nudge fires **once per situation**, keyed like claude-hooks' Stop nudge
(the active ids plus what changed), with at most two differently worded
attempts. A repeated identical nudge was measured to do nothing. There is a
shared cap of one nudge per three tool calls, so a busy run is never nagged
twice in a row. Every fire is logged as an event (`nudge: <id>`) with whether
the model's next call followed it, which is what section 12 measures.

**Solo**

| id | when | channel | says |
|---|---|---|---|
| S1 plan | no task exists, and the run has made its first workspace change or its 4th tool call | system | List the work as tasks in one `task_plan` call, with the order between them. |
| S2 untracked | a write while no task is active | tool result | This change is not under a task: start one (`task_update`) or add one (`task_plan`). Today's untracked-edit nudge, re-pointed. |
| S3 stale | 3 writes since the active task was last touched | tool result | Names the task and the files: done (with the outcome), or a note on where it stands. |
| S4 verified | a test or build command passes while a task is active | tool result | If this checks T3.2's acceptance, tick it and close the task. |
| S5 ready | a close unblocked tasks | tool result of `task_update` | Ready now: T4, T5. Start the next one. |
| S6 struggle | the struggle detector fires on a task | system, joined to its message | Note what failed on the task; split it, or park it with a `human:` gate if you are stuck. |
| S7 resume | after a compaction or resume | system, with the board | You are on T3.2, ready next T4. |
| S8 close-out | the run ends with active or ready tasks | completion guard | Today's two-step close-out, on tasks. |

**Team** (lead and teammates on one board)

| id | when | to | says |
|---|---|---|---|
| T1 parallel | a plan has 2+ tasks in layer 0 and teams are on | lead, in `task_plan`'s result | T2 and T3 can run in parallel: hand them to teammates (`team_run_task`). |
| T2 claim | a teammate's run starts without a claimed task | teammate, first tool result | Claim your task (`team_task claim`) before working. |
| T3 report | a teammate's run is ending with its task still active | teammate, completion guard | Complete it with a summary, or block it with the reason. |
| T4 idle ready | the lead waits on runs (`team_await_runs`) while ready tasks have no claimant | lead, that tool's result | T6 is ready and unassigned. |
| T5 unblocked | a close unblocked a task a teammate holds or waits for | teammate, team mailbox | T4 is ready: its dependency closed. |

The wording of each nudge is part of the template work, per family, and is
tuned from section 12's compliance numbers, not guessed.

### 10b. Round trips (phase 1c, 2026-11-20)

The phase 1 A/B (tg-bench, qwen36 27b on eleven2go, 15 runs an arm) scored
the same in all arms (108, 109, 109 of 110) and moved planning first from 4 to
11 of 15 runs, but total input per run went from 504k (checklist) to 799k (B)
and 741k (C), wall +20%. The models never make two calls in one turn, so each
`task_update` (6.7-7.8 a run) re-sent the whole context; the checklist rode on
calls already being made. Two cuts:

- **Auto-start.** After a plan or a close, with nothing active, the first
  ready task (priority, then creation order) is started on the same call and
  the result says so. 29 of C's 101 updates only started a task.
- **`task_done` on working calls.** `editor`, `apply_patch`, `run_commands`
  and `check_file` carry an optional `task_done` ("T3: outcome"). Applied
  after the call, only if it succeeded: done, note as outcome, acceptance
  ticked, then auto-start. Refused calls and unknown ids are reported with the
  next reminder. A fork replay applies it as sent (results are not in the
  call). S3/S4 now point at it instead of a `task_update`.

Re-run of arm C on 57669d5a7d plus these changes only (the editor rename kept
out) decides whether phase 1 is complete.

### 10c. What the re-run left (phase 1d, 2026-11-21)

Arm C2 (auto-start + `task_done`) scored 108/110; total input 976k mean, 571k
median, the mean carried by two ledger runs of 74-79 requests in test-debug
loops. Counted by what each request carried, graph-only requests were 6.0 a
run (164k, 17% of input) against 7.8 (184k, 25%) in C and 8.6 (211k, 26%) in
B; a task-graph call shared a turn with work 0.1 times a run. What was left:

- **Quoted `task_done`.** 24 of 55 values came as `"T1: …"` (qwen3.6 writes
  the nudge's example with its quotes) and were refused as naming no task;
  the model then closed the task with a `task_update`. Values and task ids are
  now read with wrapping quotes, backticks or a JSON string literal removed.
- **One edit finishing several tasks.** `task_done` took one id, so closes of
  T2-T7 went to `task_update`. It now reads several ids before the note ("T2,
  T3: …", "T2 and T3 …", "T2-T5: …", ranges up to 20); ids after the first
  need their `T`, so "T3, 2 tests added" closes T3 alone.
- **A tick request after a close.** A `task_update` close left the acceptance
  unticked and said so; a request that only ticked followed 23, 8 and 14 times
  against 74, 64 and 59 closing calls (B, C, C2). A done close now ticks what
  is open unless the call sends `check` or `uncheck`.

Arm C3 re-runs C2 with these on the same base: 109/110, plan before write
10/15, graph-only requests 2.8 a run (54k, 8% of input), no `task_done`
refused (63 sent), input median 491k (A 438k, C 693k), wall median 202 s (A
169 s). Left: 3 of 5 textkit runs alternated an edit and a `task_update`
close and never used `task_done`. S9 answers that once per session, with the
close's own reply (no request): the close could have ridden on the call before
it. Phase 1 declared complete 2026-11-21.

### 11. Export to memory (phase 2)

When Memory is configured, the board can be kept in a memory, one of the
named memories the Memory panel already manages (main, per workspace, per
client), chosen by the person:

- **Export.** The panel's "Save to memory" writes the board into the chosen
  memory as one note of a new kind, `taskboard`:
  - the open tasks in full, with their dependencies, gates, acceptance and the
    last log lines;
  - closed tasks as one line with their outcome;
  - a header naming the conversation and the time.
  The Memory panel lists it like any other note, and it can be forgotten or
  exported like one.
- **Use it in a new conversation.** A new conversation can start from a saved
  board: from the panel, or by the person asking. The board is imported as
  the conversation's starting events, ids kept, each event authored
  `memory:<note id>`, so the panel shows where each task came from.
- **Keep it current (optional, per board).** With "keep updated" on, every
  change in the conversation rewrites the note. Two conversations working from
  the same saved board each update it, and the note records which one wrote
  last.
- **Model access.** None in phase 2: saving and loading are the person's
  actions. The model sees the imported board like any other, through the board
  injection.

## Phases

Each phase ends green (core, tools, webview, config suites) and deployed to
pandorum. Phases 1–3 are what replaces the checklist; 4–5 build on it.

**0. Measure. Done 2026-11-20.** eleven2go's 3090, qwen36-base-mtp_tb:27b-q4km-128k
on xOllama, build 1067a476de, checklist as shipped (reminder interval 6).
- **Fixed price of the `task_progress` parameter:** first-request prompt
  tokens 12,785 off vs 15,105 on, so +2,320 a request (+18%), about 145 per
  tool on 15 tools. The system prompt was the same size; the difference is
  the schemas.
- **Baseline runs on tg-bench**, not manic_miner (the owner's call: too big
  to exercise a checklist). `spool/tg-bench`: three small Python tasks with
  hidden oracles, each checked both ways (untouched repo fails, a reference
  solution passes): `ledger` (9 requirements in four dependency layers),
  `textkit` (6 independent bugs), `shop` (a strict 5-step chain). 5 runs each.
  - Scores: textkit 35/35, shop 30/30 (both at the ceiling, process
    measurements only); ledger re-run with a fixed oracle (its R3 tested an
    internal API).
  - The list is written after the work: before the first edit in 3 of 15
    runs (textkit 0/5, shop 0/5, ledger 3/5); textkit's first send at call
    8-15, after edits at call 3-4.
  - Most sends repeat an unchanged list (textkit 3 sends : 1 change).
  - The standalone tool is mostly the last tick after the close-out nudge
    (used in 11 of 15 runs; the nudge fired in 7).
  - The untracked-edit nudges were mostly ignored (19 fired).
  - Every final list was fully ticked, including a run that failed a
    requirement: ticks do not mean verified.
  - Writing the list is cheap (800-3,300 characters a run); the fixed price
    is the cost.

**1. Core. Done 2026-11-20 (preview, off by default).**
- `@cline/core` `extensions/tools/task-graph/`: `model.ts` (task, fold,
  ready / blocked / layers, cycle check), `readers.ts` (lenient readers),
  `board.ts`, `store.ts` (log, reconcile, operations), `tools.ts`,
  `tracker.ts` (untracked-edit nudge, close-out guard, board after
  compaction).
- Wired in `local-runtime-host.ts` behind `taskGraph: {enabled}`; with it on,
  the checklist is off (no parameter, no tool) whatever `taskProgress` says.
- Plugin: "Task Graph (preview)" switch (a field of `FocusChainSettings`),
  board snapshots as `say: "task_graph"` rows, read-only `TaskGraphPanel`
  (tree, details, Graph tab). CLI: `--task-graph`, `CLINE_TASK_GRAPH=1`.
- Decided while building:
  - a subtask waits on what its parent waits on (otherwise it is offered as
    ready under a parent that cannot start), so a subtask may not depend on
    its own ancestor;
  - the reconcile rule: keep the log up to the last event whose tool call is
    still in the history; none present means summarised away (after a
    compaction, keep all) or cut back to before the plan (otherwise, keep
    only imports); no log means replay the history's task calls (a fork);
  - the close-out budget is per session, as the checklist's was.
- Not in phase 1: templates (phase 3), the habitual `task_progress` reader
  (phase 3), gates (phase 5), teams (phase 4).

**1b. Nudges. Solo set written 2026-11-20** (S1, S2, S3, S4, S5, S7, S8 in
`tracker.ts`; S6 waits on the struggle detector). Keyed once per situation,
two attempts worded differently, one nudge per three calls; each fire logged
as `[task-graph] nudge <id> (<key>)`. S1's call-count trigger tells a run that
only answers a question to carry on. The team set (T1-T5) is phase 4.
Compliance is measured on tg-bench: arm B (graph, 72f69ec47a/8597c7d02c,
before 1b) against arm C (graph with 1b), both against the phase 0 baseline.

**2. Panel and memory.** The tree, detail, graph tab, chat rows, the person's
edits with the model being told, and export to memory with use and
keep-updated (section 11).
- **Edits, 2026-11-21.** `TaskGraphTracker.edit()` applies a `task_update` or
  `task_plan` input with `by: "user"` and queues "[SYSTEM] The person changed
  the task board: …". It is delivered once: with the after-tools reminder
  when a run is under way, or as the next run's start context (a `beforeRun`
  hook) when the session is idle. The host hands the extension a
  `CoreTaskGraphControl` (`taskGraph.onAttach`, with the session id); the
  panel calls `StateService.taskGraphAction` (JSON in, `{ok, lines}` out),
  which edits only the active session's board. Panel: Start, Done… (outcome
  optional), Cancel… (reason required), Reopen, acceptance ticks, + Add task.
- **Export to memory, 2026-11-21.** A saved board is a Memory document with
  source `taskboard:<session>:<time>` and `metadata.board` (format
  `cerebriline-taskboard`, session, title, savedAt, keepUpdated, counts, the
  events without call ids); its text is `renderSavedBoard` (header, open tasks
  in full via `renderTask`, closed as one line with the outcome), cut to a
  note's 4,000 characters. `Memory.saveBoard` (add, or `replaces` in place),
  `readBoard`, `setBoardKeepUpdated`; `recall`, `list({boards:"exclude"})`
  (the model's listing), `forget({keepBoards})` (the model's), `consolidate`
  (notes are `memory:` sources) and `exportMemory` leave boards out. Use:
  `taskGraph.seed {events, by: "memory:<id>"}` seeds a session with no log
  and no task calls (`reconcile` → "seeded", events authored by the memory,
  made by no call so a cut-back keeps them; the board is shown with the first
  look). Extension: `TaskBoardMemory` (`src/sdk/task-board-memory.ts`) holds
  the seed the Memory panel picked until the next new task (`initTask`
  without a history item), ties the session to the saved board, and on
  every board change rewrites it after 1.5 s when that board says
  keepUpdated (read at write time, so the Memory panel's switch takes effect
  mid-conversation). Task panel: "Save to memory…" (memory, keep updated);
  Memory panel: a task board chip, "Use in a new conversation", the keep-updated
  switch, Forget.
- Left for later in phase 2: saving the board of a conversation reopened from
  history before its session is back (the board is read from the live
  session), and starting from a saved board "by the person asking" (it needs
  a tool, and the model has no board access in this phase).

**3. Switch over.**
- Templates.
- The `task_progress` parameter and tool are dropped; a habitual send is read
  without being advertised.
- Default on.
- Harness A/B against the phase 0 baseline, on the same metrics plus tool
  validation failures on the new tools.
- Ship only if success holds and the fixed price goes down.

**4. Teams.** `team_task` on the graph's store, claims, `run:` gates, the
team nudges (T1–T5), "Ready now" to teammates.

**5. Gates and views.** `human:` wired to questions and the panel; commit,
timer and GitHub gates; Mermaid; tuning the decay from live boards.

## Decided

Taken 2026-11-20:

1. **`task_progress` goes from every tool schema**, and its standalone tool
   with it. Updates are driven by the harness: a specific nudge, or a nudge in
   the tool's output, whichever fits (section 10).
2. **Three tools** (`task_plan`, `task_update`, `task_view`), reduced from
   claude-hooks' 13.
3. **`team_task` stays a separate tool**, with the graph as its backend
   (section 7).
4. **No editing from the panel in phase 1**; editing is phase 2.
5. **Export to memory in phase 2**, when Memory is configured: saving into a
   chosen memory, using it in a new conversation, and optionally keeping it
   updated (section 11).
6. **Phase 0 runs on eleven2go's 3090.**

## Testing: does it get used (section 12)

The harness (automaticum) arms, on the same task set and model:

| arm | what |
|---|---|
| A | today: the checklist parameter, reminders, close-out |
| B | the graph, board injection and close-out only (no section 10 nudges) |
| C | the graph with the solo nudges |
| D | C with teams enabled, and the team nudges |

Measured per run:

- **Adoption:** the run creates tasks at all, and by which call.
- **Upkeep:** writes between updates of the active task; tasks left active at
  the end.
- **Honesty:** tasks marked done whose acceptance the oracle confirms, and
  done-but-not-done.
- **Each nudge:** fired, and whether the model's next call followed it. A
  nudge with low compliance is reworded or removed, not repeated.
- **Cost:** fixed tokens per request, and output tokens spent on task calls.
- **Outcome:** task success, which must not fall.
- **Team (arm D):** layer-0 tasks handed out, claims, a teammate finishing
  without reporting.

Arms A–C run before phase 3's switch-over and decide it. Arm D runs after
phase 4. Live pandorum runs follow each.

## Risks

- **A richer surface on small models.** More fields mean more ways to send a
  wrong shape.
  - Mitigations: lenient readers from day one; batch creation, so the plan
    costs one call; an example in each family template.
  - Phase 3 is gated on validation failures not exceeding today's checklist.
- **The board's own cost.** It is capped and decays. Measure the real size on
  live boards in phase 3, and keep the cap if it holds.
- **Rewind correctness.** Every path that truncates or forks history has to
  pass the message anchor:
  - edit-and-resend;
  - checkpoint restore;
  - the discarded-turn path;
  - resume.
  These are listed in phase 1's tests, so a missed one fails a test rather
  than showing a stale board.
- **`team_task` on another tool's store.** Its runtime methods must write
  through the graph and never keep a copy in the team envelope; two registries
  of the same thing is a bug this codebase has met before. A test creates a
  task with each tool and reads it back with the other.
- **Nudges that nag.** Each fires once per situation with two wordings at
  most, under a shared cap, and is kept only if its compliance (section 12)
  earns it.
