# Changelog

Releases of **Cerebriline**, a fork of [Cline](https://github.com/cline/cline)
built for local and small models.

Upstream Cline's own changelog is a separate document and is not reproduced here.

## [4.100.207] — 2026-09-26

The first public release since 4.100.118. Builds 4.100.119 to 4.100.206 were
test builds and were never published, so everything they carried is collected
here, grouped by what it changes for you. The major features:

- **Agents on every machine you have.** Delegated agents run in parallel across
  several nodes, from one queue, and survive a server restart. The lead manages
  its rounds while you keep talking to it.
- **Swarms.** Many agents share one snapshot of the lead's context on an
  opencoti engine and return one merged report. `count: "max"` runs as many as
  the servers will take.
- **A sandbox for every delegated agent.** Each works in a private copy of your
  workspace, and its changes come back to the lead as revisions.
- **Jev.** An outside scoring model gives a confidence score before the model
  acts on a guess, ranks the options of its questions to you, and scores the
  complexity of an escalation.
- **The Compaction Council.** Every summary is reviewed against the
  conversation before it replaces it.
- **xOllama**, an Ollama-API provider for council chat.

Everything about agents, swarms and teammates, with example prompts, is in the
new guide, `docs/features/agents.mdx`.

### Agents run on your nodes, in parallel

- **The Agents tab holds nodes.** A row of node tabs sits above the provider
  form. Node1 is the tab as it always was, so nothing needs migrating. **+**
  adds a node, the bin removes one, and each node has its own provider, model,
  profile and a **priority**. Priority 1 is the highest. Agents go to the free
  nodes of the best priority available, taking turns between nodes of equal
  priority, and use a lower priority only when nothing above it has room.
- **One queue for every node.** Agents wait in one queue, oldest first. When
  every node is busy the next agent waits instead of failing. A capped node
  takes the next agent as soon as one of its own finishes. An uncapped node
  (elastic or PolyKV opencoti) takes a new agent once the engine has started
  generating for the previous one, so it can no longer take the whole round up
  front while another node sits idle.
- **A node that can't run the agent steps aside.** A node that can't be
  reached, answers 502/504 from a gateway with nothing behind it, or lacks the
  model leaves the rotation for a cool-off, and the agent goes to the next node
  with room. A refused agent returns to the front of the queue. An agent that
  failed after it had started is never re-run elsewhere, because that would
  repeat its edits.
- **Use PolyKV agents as Priority 0.** Off by default. It appears in the Agents
  tab when your main model is on an opencoti server with pools confirmed. When
  it's on, up to 8 agents run as sub-pools of your own session, ahead of every
  node. An agent starts there only while a quarter of your window stays free
  for the conversation. Beyond that it overflows to the nodes.
- **A node's own settings reach its agents.** Thinking, sampler, output budget
  and PolyKV switches set on the Agents tab or a node are now what its agents
  run with. Before this, every delegated agent ran with the lead's settings. A
  tab that sets none of these still follows the session.
- **Agents model**, in Features: a single model id for all delegated agents,
  used instead of the session's model. Leave it empty to keep them on the
  session's model.
- **Several agents run at once.** Tool calls sent in one message now run
  concurrently (8 at a time by default) instead of one after another.
  Delegation skips that limit and waits where its own node or engine says to.
  A request for forty agents no longer runs eight at a time.
- **In the CLI**, `--agent-node model=…,url=…,priority=…,capacity=…` is
  repeatable and gives a run more than one endpoint.
- **Seed and temperature per agent.** `spawn_agent` (single, batch and swarm
  entries), `team_spawn_teammate` and the configured
  `subagent_<name>` tools take an optional `temperature` and `seed`. They
  override the agent's model sampler for that spawn; leave them out and nothing
  changes. A seed that covers several agents is offset per agent (`count: 3,
  seed: 7` runs 7, 8, 9) so they don't sample identically. The seed reaches
  Ollama, opencoti and OpenAI-compatible servers (llama.cpp, LM Studio);
  hosted APIs take the temperature only. A teammate keeps its values when restored.
  `seed: "random"` gives each agent its own seed, and `temperature: "random"`
  or `temperature_range` (a percentage, 2 by default) draws each agent's
  temperature around its model's own or around the number given.
- **Agent window** (opencoti nodes). A slider per node sets how much of the
  node's window each agent asks for, between the minimum a session needs
  (system prompt, tool schemas and one turn's output) and the whole window.
  Every provider warns when a node's window is below that minimum.

### One call for the whole fan-out

- **`spawn_agent` takes a list.** `agents: [{name, task, type?, count?}]`
  starts several agents in one call. `count` repeats an entry, so "15 of each
  of five kinds" is one call with five entries. `type` names an agent defined
  in `.cline/agents`, which then runs with its own role and model.
- **Shared context is stated once.** `knowledge` holds the files and notes
  several agents need, and `instructions` holds the role shared by every agent
  of one kind. On a PolyKV node they are loaded once for all the agents that
  share them.
- **Every report reaches the lead.** Each finished agent writes a summary of at
  most 1,000 characters. The lead gets a result that always fits, names every
  agent with its status, and marks each failure as *infra* (worth running
  again) or *task*. Full reports are read with `read_agent_report(name)`, a
  page at a time.
- **An agent's question goes to the lead, not to you.** A question now ends
  that agent's run and becomes its report. The lead decides whether to answer
  it, run the agent again, or ask you. Before, one agent's question held the
  whole round until you answered it.
- **You can talk to the lead while its agents run.** A round of several agents
  runs in the background by default, so the lead stays free. When it is
  waiting on its agents (`await_agents`, or a spawn told to wait), your message
  wakes it: the round carries on in the background and the lead reads you at
  once. It can reply, pass a message to some or all of its agents
  (`message_agents`), or stop them (`stop_agents`).
- **Identical calls in one message count once.** A fan-out of identical agents
  no longer trips the repeated-call guard.
- **Delegated agents get `check_file`, `ask_lsp` and `list_files`.** Their
  instructions named `check_file`, but until now they didn't have it.

### Swarms

A swarm is many agents working from what the lead already knows, returning one
answer. Use it when the parts don't depend on each other and you want one
result: searching a repository several ways, checking many files, trying
several approaches.

- **Start one with `spawn_agent` and `merge: true`.** With a single `task`,
  `count` says how many agents run it. With `agents`, each entry is a part of
  the work. Asking for "as many agents as possible" is `count: "max"`.
- **The workers share the lead's context without paying for it.** At the end
  of the lead's turn its live context is snapshotted on the opencoti engine
  into a pool, straight from the session's own cache, and every worker attaches
  to it. No worker prefills the conversation again, and none needs `knowledge`
  about what the lead already knows. A worker rerun later shares its round's
  prefix too.
- **One merged report.** Each worker writes a structured digest, and a reducer
  that starts from the same snapshot merges them into one block for the lead.
  With one worker the digest is passed straight through. Workers' transcripts
  are discarded. A worker that failed, or spent its whole budget thinking and
  answered nothing, is still in the report with what it did say, never
  silently missing. The report names the revisions the workers handed back.
- **The round grows while it runs.** `count: "max"` isn't sized once. The
  swarm starts workers while the engine will take them, and asks again as
  workers finish, so a round that starts on a busy server widens as it frees.
- **Swarms run on any node.** They are offered when the main connection, the
  Agents tab or any node has **Allow swarms** on in its PolyKV section and its
  engine confirms pools. Otherwise the tool's swarm mode is left out of the
  request entirely. Workers go to swarm-capable nodes first and still run on
  plain nodes as ordinary agents.
- **Your configured agents can swarm.** An `agents` entry with a `type` keeps
  that agent's role and tools in the swarm, so "15 of each of five reviewers,
  merged" is one call. An agent pinned to its own model is refused by name,
  with the advice to send it without `merge`.
- **Workers are visible and stoppable.** Each gets a row and a tag in the
  working-agents strip, with its node, state, tools and tokens. A failed one
  says why. **Stop all** stops queued workers before they start.
- **Workers fit on the engine.** On a PolyKV node each worker joins the node's
  pool tree instead of booking a full window. A full owner window sends a
  refused worker to the owner with the most room, the admission floor you set
  is applied, and each worker closes its session as it ends, so a finished
  swarm gives its memory back at once.
- **Workers work in the sandbox** like every delegated agent, and their
  questions go to the lead, not to you.

### Watching and steering agents

- **A strip of the agents working right now** sits above the conversation. Each
  agent is a tag with a clock while it's queued and a spinner while it runs. It
  scrolls, so fifty agents don't push the chat off screen.
- **Open an agent to see what it's doing:** its node, provider and model,
  current tool, tool count, speed (`~23 tok/s`, `idle` after 5 s without
  output, "no activity for Ns" after 30 s), the tokens it holds, the last lines
  it wrote, and a log of placements, waits, refusals and warnings. On opencoti
  the row shows the server's phase: *Queued on the server*, *Prefilling
  20,481 / 41,533*, *Generating*.
- **Stop, Restart, Stop all.** Stop ends one agent and keeps the others'
  reports. Restart starts an agent again from its task, in the same place in
  the round, which helps with one that is stuck or looping. **Stop all** asks
  first.
- **Rows finish when their own agent does**, not when the slowest one in the
  round finishes. A queued agent reads as queued, and so does one waiting on
  the server (for room, after a refusal, or through an outage), including after
  the chat is redrawn. Its row says what it is waiting for.
- **Rows count compactions beside tool calls:** "7 tools called · 3
  compactions". The tooltip splits them by cause (the agent's own threshold, KV
  pressure on the server, overflow recovery, manual). Teammates are counted too,
  per task and over their life.
- **Configured agents get the full row**, named for what they are
  (`js-syntactic`, not `subagent_js_syntactic`), with the node shown by its tab
  name (`Node2`).
- **Warnings mean something again.** An admission refusal is an info line, not
  a warning. The ⚠ on a chip clears once the agent makes progress. A missing
  model and a server outage are still warnings.
- **Smaller fixes.** "Show less" collapses a long sub-agent prompt. A price of
  `$0.00` is no longer shown. The task header's connection count opens into
  each provider and model, its role, and what it spent.

### Agents that survive a server restart

- **Agents retry and never fail on infrastructure.** When the server restarts
  or the connection drops, an agent waits for the server's `/health` (backing
  off up to 30 s) and runs the failed turn again. There is no retry limit, and
  Stop always wins. An admission refusal no longer ends an agent either. It
  waits, backing off up to 60 s.
- **The lead hears about a stuck agent.** After about 10 minutes of trouble,
  the lead gets one status message per agent and can message it, stop it, or
  carry on.
- **Pools are restart-safe.** The server's boot id is checked on every
  response. After a restart, pools are rebuilt instead of being addressed by
  ids the new process never issued, for both the lead and its agents.
- **The worker struggle supervisor** watches every delegated agent, not only
  swarm workers. An agent that keeps running out its thinking budget is nudged
  once to commit its answer. If it keeps doing so it is held for the lead
  rather than ended (see below). Replayed against two 75-agent swarms, it
  caught the one real loop and none of the 121 agents that went on to answer.
- **A tool call the server couldn't parse is asked for again.** It no longer
  kills the agent. When opencoti says which argument a value ran into, the
  retry tells the model that.
- **A broken stream is retried, not blamed on the task.** A chunk the SDK can't
  read, a batch the engine failed to decode and an engine eviction are
  transport faults: the turn is sent again, backing off. The round report says
  which node failed and whether it was answering.

### The lead manages its rounds

- **Every delegation is a round the lead can come back to.** Each agent has an
  id, its original task, role, sampler and cap, where it ran, its state and why
  it stopped. The record is kept beside the session, so a reload brings it
  back. A round the session's end cut short is recorded as interrupted and the
  lead is told which agents were lost.
- **`agents_status`** tells the lead what each agent is doing and why: every
  round and node at a glance, or one agent's state, node, window, speed,
  iterations against its cap, check result and recent output.
- **The lead's controls:** `requeue_agent` (move it to another node, carrying
  its transcript), `restart_agent` (start again from its task, with new
  instructions if given), `resume_agent`, `retry_failed`, `message_agents` and
  `stop_agents`, in the lead's own turn as well as in a side turn.
- **Background rounds report on their own.** A round the lead did not wait for
  (several agents by default, `wait: false` on any spawn or configured agent)
  is delivered when it settles. `await_agents` waits for rounds on purpose. The
  lead can't finish its task while a round is still out.
- **A cap and a check per agent.** `max_iterations` caps an agent's turns, per
  agent or for the whole call. `check: {command, expect}` is run at each attempt
  to finish, inside the agent's sandbox, over its copy. A failing check shows
  the agent the output and it keeps working. Where no sandbox can run it, the
  check isn't run on your machine and the report says so.
- **An agent that hits its iteration cap, loops, or struggles waits for the
  lead** instead of ending. Its transcript and overlay are kept, and the lead
  is told why it stopped. The lead picks `resume_agent` (with more turns and
  new instructions) or `restart_agent`, or stops it with its work kept. While
  the lead can answer, the agent keeps its engine session, so on opencoti it
  resumes on its own cache and is not held back by the admission floor as a
  new session.
- **The harness's notes read as notes.** Everything the harness tells the model
  starts with `[SYSTEM MESSAGE]`, is short, and merges with the next one of its
  kind. The queue shows them as Cerebriline's, not as messages you typed, and
  Cancel drops them instead of running them.
- **Agents stay out of the lead's chat.** A background agent's text, tools and
  failure notices no longer appear in the lead's conversation.
- Polling tools (`agents_status`, `await_agents` and the team listings) no
  longer trip the repeated-call guard.

### Teammates

- **Teammates is its own setting, off by default** (Features in VS Code,
  `--teammates` in the CLI). The eighteen `team_*` tools cost about 2,800
  tokens on every request, and few sessions use them. A `/team` prompt still
  turns them on for its run.
- **A teammate takes one task at a time.** Its queued runs wait for the one
  it is on. `team_cancel_run` stops a running task. A shut-down teammate's
  queued work is cancelled and it takes no new tasks.
- **Answers are bounded like agent reports:** whole when short, otherwise the
  opening plus the full report through `read_agent_report`.
- **The lead's controls and the row's stop reach a teammate's task**, as they
  do a sub-agent's.
- **A teammate gets the task board, the mailbox and the mission log**, not the
  lead's tools. That's about 1.7k tokens less per teammate request, and a
  teammate can no longer cancel the lead's runs.
- A teammate keeps the Agents tab's connection when the session's changes. A
  removed teammate stays removed after a reload. A teammate's events stay out
  of the lead's chat. The team's saved state is written on a change of state,
  not on every streamed token.

### Every delegated agent works in a sandbox

- **Copy-on-write isolation for every delegated agent:** `spawn_agent` agents,
  swarm workers, teammates and configured agents. An agent reads through to
  your workspace, but its writes, deletes and renames stay in a private overlay.
  When it finishes (a teammate: when each task finishes), every changed file
  comes back to the lead as a revision attributed to that agent, which the lead
  inspects with `read_files revision:"#N"` and adopts with `restore_file`.
  Nothing is applied behind your back. Two agents working at once never see each
  other's writes. The overlay needs no native code, so it is always on, on
  every platform.
- **Agents can run commands** (Features, off by default). An agent's shell runs
  through a native launcher that points the whole command tree at the agent's
  copy, so a build, a test run or a script edits the overlay and never your
  files:

| OS | architectures | how the agent's commands are isolated |
|---|---|---|
| Linux | x64, arm64 | **L1:** a user namespace with overlayfs mounted over the workspace |
| Linux | x64 | **L2:** ptrace path rewriting, used automatically where user namespaces are blocked (AppArmor) or overlayfs can't mount |
| macOS | Apple Silicon, Intel | **M1:** an APFS `clonefile` copy of the workspace |
| Windows | x64 | **W1:** Microsoft Detours injection that redirects file access into the overlay |

  One Rust binary picks the backend at runtime. All six launchers are built on
  native CI runners for each OS and architecture, verified there, and ship inside
  the `.vsix`; the CLI copies the ones for its target. Where no launcher covers
  your platform an agent gets no shell, never an unsandboxed one.
- On macOS, a path that a command builds while it runs (such as a `$WS/x`
  expansion) isn't redirected. Only the working directory and workspace paths
  passed as arguments are.
- `/delegate` and background delegations run in the sandbox too.
- **A lead that can delegate reaches its agents' work with Checkpoints off.**
  `read_files revision` and `restore_file` stay available for the agents'
  revisions.
- Deleting a conversation also removes its agents' overlays and transcripts.

### Jev: a confidence score before acting

Models guess, and a guess looks just like knowledge. Jev, TypeSafe's scoring
model, answers typed questions with a probability and a confidence. It scores
instead of arguing, so it can check the working model without agreeing with it.

- **Turn it on with *Use Jev for confidence*,** under the image-generation
  box. The **Jev** tab holds the API key, the model, a **Confidence floor**
  (0.6), a **High-stakes floor** for questions the model marks as costly to get
  wrong (0.85), and a timeout. Nothing is sent to Jev until the box is ticked
  and a key is stored.
- **A `jev` tool.** When the model is unsure it understood your request,
  whether a fact is supported, or which approach to take, it asks Jev up to ten
  yes/no, choice or score questions with the context that matters. It acts on
  an answer at or above your floor. Below it, the model verifies or asks you.
  A short rule in the system prompt says when to call it, and it is there only
  when the tool is.
- **Questions to you come scored.** Before a question from the model reaches
  you, Jev ranks its options against what you have said. The option you're
  likeliest to pick is marked recommended when Jev is confident, each option
  shows its score, and options under 5% are left out, never leaving fewer than
  two. You can still type any answer. A question waits at most 6 seconds for
  scores, then goes out without them. Escalation approvals are never touched.
- **Escalations carry a complexity score.** When the model escalates, Jev's
  complexity score for the task and its reading of whether the run is stuck go
  into the assessment you approve from and the expert reads. Next to the
  model's own account and the harness's counts, a disagreement between the
  story and the numbers is itself shown.
- Both of the last two are switches on the Jev tab, on by default once Jev is.

### opencoti and PolyKV

- **Conversations share their prompt.** On opencoti, the per-session parts of
  the system prompt (date, working directory, IDE, workspace rules, mode) now
  travel as a turn of their own. The system prompt and tool schemas, about a
  third of the window, are then held once for every conversation on the
  server, across VS Code windows and the CLI. A new conversation books its
  window minus the shared part.
- **Each agent is its own engine session**, attached to a tree of pools
  (system prompt and tools, then shared knowledge, then role, then task). 50
  agents fit in one 262k window where 49 of 51 used to be cut off. A full owner
  window is a queue, and a refused agent moves to the owner with the most room.
  Sessions and windows are released as soon as their agents end.
- **Book a context window.** An optional PolyKV setting, with **Never go
  below** as a floor. A reopened conversation asks for exactly the window it
  was opened with. If the server can't grant it, a **Can't resume** card offers
  Retry or View history instead of silently truncating the conversation. The
  context bar ends at the granted window, and compaction sizes against it.
- **Liveness.** Streams opt into the server's heartbeat. A server that goes
  silent for 35 s is treated as down and the turn is retried when it comes
  back. An error the server reports inside an opened stream becomes a normal
  HTTP error again. The throughput floor you set is now actually sent to the
  engine.
- **Admission refusals wait instead of ending the turn.** A `429` from the
  admission gate is waited out using the server's `Retry-After`.
- **Pools actually share now.** Pool release, unpin and the post-compaction
  re-root were wrong on the wire, and pools were built from a different token
  stream than the requests that attach to them. All of these are fixed. A
  request that shares less of its pool than it should is reported on the agent
  and in the log.
- **The status strip** shows the server's KV ledger, per-session windows, the
  sliding-window ring and the admission floors in force. Reads from the panel
  are bounded, so a server endpoint that never finishes its reply no longer
  hangs the panel.
- **Compaction runs as a continuation of the session** (PolyKV setting
  *Continuation compaction*, on by default). The summary writer is the
  session's next turn, and the council's reviewers attach to the session's own
  cache instead of prefilling the transcript again. Without pools the calls
  still run as plain continuations.
- **An idle owner is not a server restart.** The engine releases an owner that
  finished no request for five minutes, and its pools with it. That used to
  read as a restart and rebuilt every agent's pools on the server. Now only
  that owner's agents are re-placed, and owners that still have agents are kept
  from lapsing. Nor is a pool listing that a busy server didn't answer in time:
  while the boot id is unchanged, nothing is rebuilt. An owner that is given up
  on while the server keeps running is closed as soon as none of its agents has
  a turn running on it, so its cells go to the new owners at once instead of
  after the engine's idle timeout.
- **Agents give room back under KV pressure.** When the server reports global
  KV pressure, running agents compact and shrink their windows toward their
  floor, and grow back when it clears. A resize on a busy session waits for its
  idle moment. An engine eviction is treated as an engine bug: retried, logged
  with the session and what it held, and counted on the agent's row and in the
  round report.
- A session's root pool is rendered with its requests' thinking fields, so it
  matches them (Gemma-4's `<|think|>` flag). The engine's owners go back when
  the conversation ends, and a rerun swarm worker shares its round's prefix.
- **llama.cpp and opencoti get the sampler and thinking budget you set.**
  Before, only Ollama received them. Thinking levels are sent as
  `reasoning_budget_tokens`, which these engines actually read. The panel has
  the full sampler, with each engine's own field names.

### xOllama

- **A new provider for xOllama**, an Ollama fork that can run opencoti as its
  engine, with PolyKV and council chat. It uses Ollama's native API on its own
  default port (22434), so it can sit beside a stock Ollama, and keeps its own
  settings.
- **Council models.** A model the server reports as a council compacts its own
  conversation, so Cerebriline's compaction is off for it and the history it
  sends is the one you see. The council's past deliberation is not sent back.
- **Each council member's deliberation under its own heading** in the thinking
  block: *Planner*, *Researcher 2 · round 1*, *Critic 1 · round 1*.
- **Read-only tools are marked** for the council's researchers and critics:
  the built-in readers, and MCP tools whose server says they only read. Only
  the synthesizer writes.

### Conversation history and the home view

- **Tags on conversations.** Add them from a history row's right-click menu,
  and remove them with the **x** on each chip. Filter by typing `#tag` in the
  search box or clicking a chip, with an **Any / All** switch. The home view's
  recent list shows tags too, and clicking one filters it.
- **A news panel** on the home view carries the fork's own announcements. It is
  hidden when there is nothing current. Upstream Cline's banners are no longer
  fetched. The recent list shows as many conversations as fit.
- **Right-click a conversation** for Copy first prompt, **Size on disk** (split
  into transcript, agent transcripts and agent overlays), and Delete.
- **What a session ran with.** Rest the pointer on a history row for two
  seconds to see its provider, model, context window, output budget, reasoning
  and sampler. Credentials are never recorded. This covers sessions started
  from this release on.
- Closing a conversation opened from the history returns you to the history.
- Sorting by cost or tokens covers the whole history, not just the 50 loaded
  rows.
- The Cerebriline mark replaces Cline's logo on every view.

### Escalation

- **Jev's complexity score** joins the escalation assessment (see Jev above).
- **The struggle detector reads the change protocol's own signal** and names the
  cheapest remedy first, so an escalation is offered when it can help, not
  whenever a check fails.
- **"Attempts thrown away"** is a threshold on the Escalation tab, beside
  "Refused edits in a row", and `--struggle-failed-transactions` in the CLI.
  It counts transactions the model discarded, which is how a model failing
  the change protocol shows up, since its tool calls themselves succeed.

### Questions and images

- **Questions recommend an option.** When the model asks you to choose, it now
  marks the option it would pick, unless the choice depends on your taste or on
  something only you know. The recommended option is listed first. With Jev on,
  Jev's ranking replaces the model's own mark.
- **Generated images on text-only models.** When the model can't take images,
  it gets a text result and you still see the image in the chat.
- Unticking image generation removes `generate_image`.

### Output budget and thinking

- **One Output budget control, on every provider.** *Automatic* uses three
  quarters of the context window, capped at 96,000 tokens per turn. A slider
  scales it in 5% steps. *Manual* sends exactly what you type. The budget the
  prompt tells the model is now the budget sent on the wire.
- **"Default (provider decides)" no longer caps thinking.** It sent
  `think: "medium"`, which on Ollama is a 2,000-token budget. It now sends a
  plain `think: true`. An explicit level or off is unchanged.
- **Reasoning History works.** Automatic, Last only, Everything and None used
  to produce identical requests. They now do what they say. When a chat
  template drops the thinking field, prior thinking is folded into the reply
  text instead.
- **Default and Custom thinking levels can be selected** on Ollama and opencoti.
- **The context estimate follows what the server measured.** A retried turn no
  longer reports double its context, a provider count larger than the window is
  refused, and the estimate is anchored to the last request's real size.
  Sessions stop compacting with half the window free.
- **Compaction fires when the output cap runs thin**, before a whole-file edit
  is cut off mid-call.
- **An agent's context overflow no longer compacts the lead.** An agent's
  measurements are filed under its own session.
- **Stale reads are rewritten only under context pressure.** A file read that
  a later edit made stale used to be rewritten on almost every turn, which
  broke the server's prompt cache from that point on. It now waits until the
  transcript reaches 40% of the window.

### Compaction, reviewed by a council

- **Compaction Council** (on by default). A summary is the one thing in a
  session nobody checks, and after a compaction it *is* the session: every
  later turn reads it instead of the conversation. So the council reviews it
  before it replaces anything. The writer marks the halfway point of the work,
  the transcript is split there, and two fresh reviewers each get **half of the
  evidence and all of the summary**. In parallel, each corrects what its half
  contradicts, adds what it shows missing and fixes every quotation. A
  synthesizer joins the two corrected halves into one continuous replay and
  revises the retrospective against it. It costs three extra model calls, and it
  never fails a compaction: any step that can't run falls back to what it was
  given. Built after measured summaries reported a failing check as a pass,
  paraphrased the instruction they were told to quote, and slipped out of the
  present tense.
- **All three council prompts and the writer's are editable** in Features. A
  prompt template can carry its own compaction prompts in `# compaction: <id>`
  sections, and **Translate Compaction Prompts** can generate them for a model
  family.
- **Choose the strategy.** *Keep Recent Messages* on means the summary reads as
  the model's own memory of the turns it replaces (a present-tense replay). Off
  means the summary is a structured state record. Each strategy keeps its own
  prompt. From the second compaction on, the tail is dropped by default; this
  is a setting.
- **The replay cites tool calls instead of copying them.** `[#3]` or `[#2-5]`
  splices in the recorded call exactly as it happened. The replay is about 60%
  shorter with the narrative intact. What you typed is quoted verbatim and
  carried across compactions, and a record of every tool call and what it
  returned sits beside the summary.

- **Progress and cost on the divider:** *Auto compacting context (2/5) ·
  retrospective* while it runs, and the wall time once it's done.
- **A manual compaction uses your settings** when Auto Compact is off: strategy,
  prompts, council, thinking. Those controls are no longer greyed out.
- **The summarizer sees what the tools returned.** Results from `read_files`,
  `run_commands` and `search_codebase` used to reach it blank. A summary that
  echoes its own prompt back is cut and retried.
- Sub-agents compact with their own model, inside their own session.

### The context bar and the tool list

- **The context bar shows what the tokens are:** system prompt, the agent's
  tool schemas, MCP schemas, then the conversation. Hover for the cost of each
  before the first message. The bar no longer counts the reply, shrinks the
  fixed part on compaction, or jumps between turns.
- **Tools can be switched off per profile.** The Tools section lists each tool
  with its schema cost, grouped as Read, Write, Check and Other. A file read
  over 24,000 characters is refused with the size that would fit. The limit is
  adjustable and can be turned off.
- **MCP tools say which server they came from.** A server named `vscode` is
  refused with a warning instead of silently colliding with the editor bridge.

### Tool calls that used to fail

- **`run_commands` reads a JSON array sent as a string** where only one reading
  is possible. That refusal was 81% of all tool errors in the measured runs.
  An ambiguous one is still refused, and the error now points at the character
  where parsing stopped. `grep`, `sed` and `awk` accept a single path, and task
  checklists sent as a list now reach the panel.
- **`editor`** shows the exact place where `old_text` and the file disagree,
  accepts a line range plus a fragment of that line, lets a model repeat the
  lines it named, and says when the lines being added are already in the file.
- **Files changed behind the model's back are caught.** Changes by a command, a
  parallel agent or you in your editor are noticed: reads warn, and edits
  refuse until the file is read again. Edits to one file are serialized, so two
  parallel edits no longer lose one of them.
- **`restore_file` and earlier revisions work without the change protocol.**
  Turning **Checkpoints** off now turns all of it off (`--no-checkpoints` in the
  CLI).
- **A batch of tool calls runs as a batch.** Several independent calls in one
  message run in parallel (up to 8) instead of one at a time.
- **`check_file`** answers in structured, LSP-shaped JSON and no longer demands
  every fix in one edit.
- The loop guard catches a restore, read, edit cycle it used to miss. Its
  repetition notice now tells the model that its own earlier reasoning is not
  in front of it, so the quote in the notice is not doubted.
- **"Wants to create a new file" no longer appears for a broken `editor`
  call.** A call that names no file creates none, and the model is told to
  resend the call smaller instead of seeing its own garbled output shown as a
  file.
- **Faster on Windows.** Each tool call spent about 600 ms spawning PowerShell
  to find the Documents folder. It now takes about 12 ms.
- An auto-approved edit's preview no longer holds the run up while it fades.

### Settings and profiles

- **Numbers are saved whole.** Number fields wait before saving and save on
  blur and Enter, so `65536` is no longer stored as `6553` on the way. Update,
  Save as… and switching tabs save what a field is still holding.
- **Profiles follow the node you are on**, and loading one onto Node2 no longer
  replaces Node1. Loading a profile asks first if it would discard changes. A
  profile no longer looks changed on the other kind of tab. Delete asks first,
  and Copy on the profile picker copies the profile's name.
- A profile that stores no context window keeps the shared one. The PolyKV
  switch stays off after a profile load. Temperature has one control, in the
  sampler.
- **Parallel Sessions** explains what it means for the provider you're on. An
  empty field lets an elastic or PolyKV engine decide, and the cap is 64.
- **`repeat_last_n`** offers only what the engine accepts. `-1` is no longer
  offered to llama.cpp, which rejects it.
- **Ollama cloud models** are recognised from what the server reports. The
  panel shows the account's plan and each model's real context length and
  warns when a model needs a plan the account doesn't have. Cloud models are
  budgeted at their real window instead of 32k.
- **A prompt template you wrote outranks a shipped one**, however specifically
  the shipped one matches. Four shipped templates were refreshed.
- **Strong coding nudges** is a switch. Turn it off if you mostly ask questions.
- The OpenAI Compatible panel has one Advanced section, the output budget slider
  for opencoti and llama.cpp, and a dialog that is no longer drawn under the
  model list.

### Chat fixes

- **Copy is plain text by default.** *Copy Formatted* in the right-click menu,
  or Ctrl+Shift+C, keeps the Markdown. The thinking block's copy button sits on
  its title and works while the thinking is still streaming.
- The chat panel could crash with *Minified React error #310* when a command
  row followed a tool row. Rows now belong to their message, not their position.
- Dragging the scrollbar counts as scrolling away. The thumb has a minimum size.
- A copied selection no longer ends in a newline that sends the message when
  pasted.
- Cancel shows whenever the Thinking/Generating loader does.
- A turn discarded at the output cap stays visible after the task is reopened.
  Nudge notices read as sentences, and runtime reminders no longer show as your
  own blue messages.
- Edit rows show their diff whether or not background edit is on.
- Popover and right-click menu text follows the theme instead of being black on
  dark.
- A terminal left open after a command error is closed.
- A provider error shows its message instead of `[object Object]`.

### Reports

`Collect-CerebrilineReport.ps1` collects logs and settings from a renamed
install, and says when both `~/.cline` and `~/.cerebriline` exist.

## [4.100.118] — 2026-09-15

### Three local engines, not one

The READMEs named Ollama and stopped there, while the fork carries real work for
two more engines and nothing told anyone about it. All three are described now,
including where the line is:

- **Ollama** — the thinking budget needs the fork's build of Ollama, because
  stock Ollama accepts unknown request options and silently drops them. The
  link in the README is
  [`releases/latest`](https://github.com/mann1x/ollama/releases/latest), which
  now resolves to 0.34.0-thinkbudget.
- **llama.cpp** — a `llama-server` is reached through the OpenAI Compatible
  panel, and its own `timings` object, which a standard OpenAI client discards,
  is read back: the prompt and generation split the server measured, how much of
  the prompt came from its KV cache, and how many speculative tokens were
  accepted. Behind **Show request timings**, off by default.
- **[opencoti-llamafile](https://huggingface.co/ManniX-ITA/opencoti-llamafile)**
  — a single-file engine with PolyKV shared-prefix KV pools. It has a provider
  of its own in the CLI and SDK: a session pins one pool for its system prompt
  and tool schemas, asks the engine how much room is left before each turn,
  compacts when the engine reports cache pressure rather than when a token
  estimate guesses at it, and forks the pool at the prefix afterwards so the
  expensive part is not processed again. Delegated agents let the engine's
  admission control set the concurrency.

### A local server has nobody to authenticate to

`cline auth` demanded an API key from every provider whose registry entry
declares one — which includes Ollama, LM Studio and opencoti-llamafile, since
each has a hosted deployment where a key is real. Setting up a local engine
meant inventing a word for `--apikey`.

The decision now follows the endpoint rather than the field: a loopback address
needs no key, and the same provider id pointed at a remote host still does.

```bash
cline auth --provider opencoti --modelid <model> --baseurl http://localhost:8080/v1
```

### check_file quoted Windows paths as JSON

`check_file` built its command line with `JSON.stringify`, which escapes a
backslash by doubling it — so on Windows the linter was handed
`eslint "D:\\repo\\my file.ts"` and could not find the file. Paths are quoted
for the shell that will run them now.

### The test suites run again, on every platform

Three workflows were red, and most of what was failing were tests asserting
facts about the machine they ran on: a brand name in a path, a POSIX separator,
`sh -c`, win32 case folding. Thirty-eight of those are fixed, the extension's
end-to-end suite passes on Linux, macOS and Windows, and the CLI's recorded
conversations were re-recorded against a real model.

One of them mattered beyond the suite: `sdk-test` builds and tests the CLI but
fired only on changes under `sdk/`, so a CLI change reached the trunk untested
and surfaced later under whatever unrelated commit happened to run it next.

### Publishing to Open VSX by hand

The release publishes to Open VSX without being allowed to fail there — a
gallery outage must not lose a tag that is already pushed — which left no way to
publish afterwards except re-running the whole release. There is now a manual
**Publish VSIX to Open VSX** action that builds a given tag and publishes only
to the gallery, with a dry run that packages the `.vsix` without touching it.

## [4.100.117] — 2026-09-14

### The listing says what this is

The Open VSX page was rendering almost empty, for three separate reasons.

- **The description** was byte-identical to upstream Cline's. It now says what
  Cerebriline actually is: a Cline fork built for local and small models, with
  per-model prompt templating, escalation, sub-agents and image generation.
- **The Overview tab shipped a zero-byte readme.** `vsce` reads `README.md` from
  the extension root, and ours is an empty upstream placeholder; the swap that
  fills it was never wired into this fork's release workflow. Every release up
  to 4.100.116 shipped it blank.
- **The Changelog tab shipped nothing at all**, because no changelog was
  packaged. This release is the first to carry one.

Release notes are now the single source for both: written once per release, they
become the GitHub release body *and* the Changelog tab, so the two cannot
disagree. A release with no notes now fails before anything is built.

### Ollama: num_gpu

Ollama decides how many model layers to offload with its own estimator, and it
is conservative — it has been measured refusing layers that fit and dropping a
model to the CPU without saying so. **num_gpu** now sits in the Ollama advanced
settings so you can overrule it.

`-1` leaves the decision to Ollama and `0` keeps the model on the CPU; both are
real settings and are sent as typed. Above that the number is a layer count, and
the range goes to 9999 because layer counts are not bounded by the 99 people
habitually type. Left blank, nothing is sent and Ollama's own estimate stands.

### Fixed

- **The Images tab trapped you on it.** The Model tab button and the gate that
  hides the "Use a different model for …" toggles asked the same question in two
  hand-written copies that disagreed — the button's list omitted the Images tab.
  Standing there, Model rendered as both the selected tab and a disabled one, so
  the only control that leads back was unusable and the section had to be left
  entirely. Both now share one checked definition.
- **Parallel Sessions was invisible to profiles.** It saved correctly, but it was
  missing from the list of fields a profile carries, so changing it never marked
  a profile as having unsaved changes and saving one did not store it.
- **The provider-config write log** named only the context window, so editing any
  other field looked identical to a no-op refresh. It now names the fields a
  write actually carried.

### Telemetry is off, and the switch is gone

"Allow error and usage reporting" offered a choice this fork cannot honour: no
telemetry key is built into it, and the ingest host is upstream's. The switch
could only ever have meant reporting your usage to Cline — under a label reading
"Help improve Cline" — and with no key it did nothing at all.

The control is removed, and the setting is forced off in code rather than merely
hidden, so a value inherited from a Cline install or set by a remote config
cannot quietly turn it back on.

## [4.100.116] — 2026-09-14

### The expert works beside you, not instead of you

Escalation no longer blocks the session that asked for it. The base model stays
live while the expert works, and supervises rather than sitting idle:

- **Stand-down.** While the expert holds the transaction, the base model's
  writing tools are refused and `run_commands` warns, but reads and checks stay
  open — so it can watch, verify and form an opinion without racing the expert.
- **`wait_for_expert`.** An explicit way to wait for the hand-over to come back,
  instead of guessing when to look.
- **Guards on the expert's own output.** The reasoning-loop and repetition
  guards now run on the expert too, and their verdicts are reported as something
  for the supervising model to judge rather than as an automatic stop.
- **Two-way messaging.** The supervising model can send a note to the expert
  mid-task, and the edits the expert made are summarised back when it returns.
- **A prompt of its own.** The expert is given its own prompt rather than
  inheriting the session's.

### Keeping itself current

- **Settings → General → Check for Updates**, with **Off**, **Notify** (default)
  and **Auto**. VS Code only auto-updates extensions it installed from a gallery,
  so a `.vsix` install was never re-checked; Cerebriline now checks daily itself.
- Downloads are **verified against the SHA-256 published with the release**
  before anything is installed, and nothing installs without you asking unless
  you choose **Auto**.
- A **Cerebriline: Check for Updates** command for checking on demand, and a
  notice in the main panel when a newer release is waiting.

### Published to Open VSX

Cerebriline is now on the [Open VSX Registry](https://open-vsx.org/extension/mann1x/cerebriline)
as `mann1x.cerebriline`, so VSCodium, Cursor, Windsurf and Gitpod can install and
auto-update it the ordinary way.

### Fixed

- The **activity-bar icon** now survives VS Code's masking instead of rendering
  as a filled blob, and the **Fix** button lines up with the controls beside it.

## [4.100.115] — 2026-09-14

### Fixed

- **A decimal could not be typed into the Ollama sampling fields.** Entering
  `0.9` stored `9`: the field discarded the separator as you typed, so the value
  that reached the model was ten times what the panel showed.
- **Every editable number in the Ollama provider panel** was audited for the same
  class of fault after the above was found.
- **Escalation counted a refusal as a success** when a tool returned one inside
  an otherwise successful result, so a blocked hand-over looked like it worked.
- **`expert_in` and `expert_requests` were in different units**, which made the
  escalation budget readout disagree with itself.
- **`struggle_edit_streak` was missing from the proto**, so the struggle
  detector's edit-streak threshold never reached the settings panel.

## [4.100.114] — 2026-09-14

### Complexity scoring

- The complexity score now reads the **scripts inside an HTML page**, instead of
  treating the page as opaque markup, and reports the number earlier in the run.
- Scores are **comparable between files**, and the result says what the number
  actually means rather than leaving it to be guessed at.
- Fixed a parser and a syntax tree being **leaked on every score** — a long
  session scored many files and never released any of them.

### Fixed

- `restore_file` now says **which revision it restored to**. It reported that it
  had rolled something back without naming the state you landed on.

## [4.100.113] — 2026-09-14

**This release renames the extension.** It installs as a *new* extension beside your current one rather than upgrading it, and it ships the migration script that brings your data across.

Supersedes v4.100.112, which was withdrawn — its copy of the migration script loses your conversation history. If you installed it, upgrade to this one; the fix below repairs the damage automatically on first run.

---

### The rename

The fork is now **`mann1x.cerebriline`**, with its data in `~/.cerebriline`. It was published under Cline's own identity (`saoudrizwan.claude-dev`) and kept its data in `~/.cline`.

VS Code keys an extension's storage on its publisher and name, so this is a different extension as far as VS Code is concerned: installing it leaves the old one in place, with its own settings and storage.

**Your conversations are not lost either way.** If Cerebriline starts and finds no `~/.cerebriline` but does find `~/.cline`, it keeps using the old directory. You can install and carry on.

#### Migrating properly

`Migrate-ToCerebriline.ps1` is attached to this release. Close VS Code, then:

```powershell
.\Migrate-ToCerebriline.ps1 -WhatIf   # show what would move, change nothing
.\Migrate-ToCerebriline.ps1           # do it; asks whether to back up first
```

`-Backup` backs up without asking, `-SkipBackup` skips without asking. It copies, verifies the copy, and only then renames the original aside as `*.migrated-<timestamp>` — nothing is deleted and re-running it is safe.

Project-level `.cline` folders and `.clinerules` files are **not** touched. That name is unchanged and shared with upstream Cline, so a repository you work on with other people keeps working for everyone.

---

### Fixes in this release

**A moved data directory no longer empties your history.** Each session stores the absolute path of its own messages file. Move the data directory and every record points somewhere that no longer exists — so the history list renders perfectly and every conversation opens *empty*. The stored path is now treated as what it always was, a cache: when it no longer resolves, the location is derived from the session id and wherever sessions live now. This repairs affected installs on first run, with no script involved. A session whose messages are genuinely gone still reports as missing rather than empty.

**The migration script rewrites what it moves.** Session manifests, `globalState.json`, and puppeteer's cached Chromium path — which named the old extension id, so every browser action would have looked for an executable that is no longer there. Task JSON is deliberately left alone: it names the old id too, but as conversation content.

**The script proves the result is usable, not just copied.** Its old check compared file counts and bytes, which matched exactly while every conversation opened empty. It now follows each session's recorded path and reads the file at the other end.

**A locked folder no longer abandons the migration.** Renaming a directory on Windows needs every handle inside it closed, and closing VS Code is not enough — an Explorer preview pane is enough to block it. The script now names the process holding it and carries on; your data is already copied and verified at that point.

**Escalation thresholds are now yours to set.** The five numbers that decide when a stuck session is offered the expert are in the Escalation tab, in filled boxes showing the value actually in force. Worth knowing before you tune them: a session running the change protocol rarely fails a tool call, so the failed-call count stays near zero and the offer never comes.

**Revisions you can choose between.** `restore_file` lists newest-first, each revision carries a short note describing what it was for, and a `find` action searches them — so restoring no longer means picking blindly from a list of identical-looking entries.

---

### Install

Cerebriline is not on the VS Code Marketplace.

```
code --install-extension cerebriline-4.100.113.vsix
```

Or **Extensions** → **...** → **Install from VSIX...**, then reload the window.

## [4.100.111] — 2026-09-13

A session that is stuck can now hand the task to a second model, and you can watch it work.

### The expert

Some tasks a small model cannot finish, and it usually discovers this several hundred turns in. **Escalation** gives it somewhere to go: a fifth model scope, configured on its own **Escalation** tab, that a stuck session can hand the whole task to — workspace, tools and all.

- **It is asked for, not assumed.** The expert is meant to be the expensive one — a metered account, a limited allowance, a larger model that has to be loaded — and it is told so, and asked not to be called for work the session's own model can finish.
- **Three ways in.** The model can call `escalate` itself; a struggle detector can offer it when a run is going badly; and the terminal guards — the ones that used to just stop a run — spend a hand-over before they give up.
- **Budgets.** Three escalations per task and twenty follow-ups within one exchange, both configurable. A follow-up is far cheaper than a fresh escalation, and the model is told that too.
- **A brief, not a dump.** The expert receives the task as the user stated it, the open transaction and its change budget, what has already been tried and been rolled back, and — separately — the harness's own reading of the run beside the model's account of itself. A disagreement between those two is the most useful thing in the brief.
- **Approval, if you want it.** Off by default. When on, every hand-over is put to you before it happens.
- **In the CLI too**, with `--expert-*` flags.

### Watching it work

An escalation is one tool call from the base model's side, so the first builds showed a collapsed grey line and nothing else — for twenty minutes, while the expert made a dozen tool calls and spent 40k tokens. Reported as *"I should see the conversation between the model and the expert, i only see the files being changed and some shell commands."* Fixed, in four rows:

| row | what it does |
| --- | --- |
| the hand-over | names the escalation, expands to the brief it was given |
| **the progress row** | live: tool count, last tool, running tokens, elapsed — rewritten in place |
| **the expert's thinking** | one row per block, collapsed like the main model's, uncapped |
| **what it said** | its running commentary, shown without an interaction |
| the delivery | takes over the progress row, with what the turn cost |

The task header carries an **Expert** line, separate from the session's own totals — the one model whose spend has to be separable from the rest.

### Failures that used to be silent

Three, all found in one real run:

- **A failed hand-over came back as an answer.** The endpoint returned `ollama cloud is disabled: remote model is unavailable` 31ms in, and that text was handed to the model wrapped in *"THIS IS A DELIVERY, NOT A VERDICT"*. It read it as an empty delivery and carried on alone. A run that finished on `error` now says so.
- **The escalation was charged anyway.** It is spent before the expert is asked anything, because that is the only place that can refuse one. When the ask fails, it is refunded.
- **The dead conversation stayed open**, so the *next* `escalate` arrived as a follow-up — the raw goal, into a context the expert had never seen, with no brief at all.

### Approvals moved into the chat

Both decisions a session puts to you — the check a model proposed, and handing the task over — were modal dialogs. A modal renders markdown as literal asterisks and truncated the escalation brief at 2,000 characters, cutting exactly the part being judged.

They are chat rows now, rendered as markdown, **whole**, with real option buttons. And you can **type instead of clicking**: your words go back to the model as the reason. *"don't escalate for syntax errors, run node --check first"* is now an expressible answer. For the proposed check this replaces two dialogs — decline, then a separate input box that could be dismissed into a dead end — with one act.

### The change protocol

- **A file has a history, not just an original.** `restore_file` takes a `revision`: `"last"` undoes only the most recent change and keeps everything before it, a number goes back to any earlier point, `"original"` is the transaction's base. A single bad edit costs one step instead of the whole transaction. Snapshots are content-addressed and refcounted, so repeated identical states cost nothing.
- **Off / On / Static**, with the per-task half of the settings split from the global half, and engage/disengage reachable from the chat where the problem actually shows up.
- A check whose answer moved is no longer read as a failed hypothesis, and a check that never ran the change is not a verdict on it.

### Smaller things

- **`grep` stopped refusing reasonable requests.** Reported as a frequent failure: `✗ Too big: expected number to be <=20 → at context`. The cap was invisible — nothing in the tool's description mentioned 20 — and it was guarding something already guarded, since the executor enforces a 48,000-character output ceiling and says so. Both context limits are now 50, every capped field states its bound, and a test walks every input schema so the next one cannot be added silently.
- `grep`, `sed` and `awk` belong to an auto-approve domain, so something finally asks about them.
- The copy button either works or tells you it did not.
- Tree-sitter grammars ship in the VSIX.
- The loop guard's first hard verdict is a warning, and no longer claims the run ended.

### Cerebriline

New name, new icons, and the extension now carries both — the icon it ships is a different file from the one in the README, and only the README's had been replaced.

### Skills

Two from **@chaoscode**: a mandatory QA prompt-and-issue-resolution skill, and a docker-compose deploy skill.

## [4.100.107] — 2026-09-13

### Prompt templates

#### A section handed back unchanged is not a rewrite

The audit's verbatim-copy rule compares a tool section against the **built-in**
description, so it only fires while the section still holds that text. Once a
section has been written by anyone, a model can return it byte-for-byte and the
run reports clean.

`kimi-k3:cloud` showed both halves. Asked six times on 2026-09-12 for `grep`,
`sed` and `awk` it returned the built-in text and was caught, so those three were
written by hand. Asked again on 2026-09-13 it returned that hand-written text
byte-identical — and the run said *"clean on attempt 2"*. Same behaviour, opposite
verdict, because nothing compared the reply to the input.

A section rewrite (`--tool`) is the one path that knows what the model was shown,
so the check lives there: each returned section is compared against the one it
replaces, and an unchanged one becomes a problem the repair loop can state. With
it live, the same model was refused three attempts running and then rewrote three
of its four sections.

It is not airtight and cannot be — one changed word satisfies it. It moves the
failure from invisible to visible, which is the part that was missing.

#### `--temperature` on the template generator

The generator pins `temperature 0.2`, which is the setting that produces this
copying, and a params overlay cannot help: a request's `options` override a
Modelfile `PARAMETER`. The flag moves the request and the provenance header
together, so a header still cannot record a value the request did not send.

#### `kimi-k3.md` now carries the model's own words for three of four tools

`grep` and `run_commands` at temperature 0.6, `awk` at 0.9. `sed` is still
hand-written and the provenance header says so plainly: asked at both
temperatures, the model returned the existing text with one sentence extended,
both times borrowing the tail of its own `grep` section. Audited 37/37.

## [4.100.106] — 2026-09-13

### Fixes

#### `sed`, `grep` and `awk` were guarding against a record nobody wrote to

The three POSIX tools added in 4.100.105 enforce read-before-write against the read
registry the SDK builds for them. The VS Code extension supplies its own `read_files`
and `editor`, which write to a registry of **its** own — so nothing ever wrote to the
SDK's, and every in-place `sed` was refused for a file the model had just read.

Measured on a live run of 4.100.105: six `read_files` calls on the target file, four
`sed --in-place` calls on the same path, and all four refused with *"has not been read
in this session"* — twice immediately after a `read_files` that the refusal itself had
asked for. The model then fell back to an `editor` call it had already sent, and the
repeated-call guard ended the session.

The registry now travels with the executors as a capability: a host that replaces half
the read-before-write guard hands over the record the other half reads. The CLI was
never affected — it takes the SDK's executors whole, which is why every test passed.

#### A `sed` row named no file, and its code block opened with ` ```undefined `

Two faults on the same chat row. `grep`, `sed` and `awk` name their files under `files`,
which neither the `path` nor the `paths` lookup read — so the row named no file and fell
through to dumping the raw arguments. And the block it dumped them into took its language
from the path, which by then was the bare tool name with no extension, so an undefined
language was stringified into the fence itself.

The three now render as what they are: the file they act on, and the script, pattern or
program they run on it, with `-i` shown when the run rewrites the file rather than
printing it. The fence fix is general — every tool that names no file hit it.

### Tests

Five new tests across the two fixes, each watched failing before the fix went in:
the capability merge carries the registry, a `sed` run is refused without a shared
registry and applies with one, and the four rendering cases.

## [4.100.105] — 2026-09-13

### grep, sed and awk, in process

Three POSIX tools the model can call directly, rather than reaching for the
shell. None of them shells out: `grep` is not the `grep` binary and does not
need one installed, which matters because `search_codebase` already spawns `rg`
from `PATH` and silently falls back to a JavaScript regex when it is absent —
so the same call could mean two things on two machines. These cannot.

- **`grep`** — POSIX semantics on a file or directory you have already located:
  every matching line, counts, inverted matches, whole words, context windows.
  BRE by default, as grep reads it, with `extended` and `fixed` for the rest.
  `search_codebase` is still the right first call when you do not yet know
  where to look.
- **`sed`** — one mechanical change in many places. Without `in_place` it only
  prints what the script would produce, which is how you check it. With
  `in_place` it writes, and takes the same read guard the editor takes.
- **`awk`** — columns and totals. Read-only by construction: output
  redirection, pipes, `system()` and `getline` are refused rather than ignored.

All three share the editor's read registry, so a `grep` counts as having read
those lines and the next edit is not refused for a file the model has just been
through.

### Three fixes found while wiring them in

**`sed` reported a refused write as a success.** Its read guard refused by
appending a sentence to the output, so the tool returned `success: true` — a
blocked write was indistinguishable from a completed one. Because one `sed`
call names a list of files that do not share a fate, it now answers once per
file, as `run_commands` and `search_codebase` already do.

**Plan mode could write.** Every `enable*` flag defaults to true, so the three
presets that set `enableEditor: false` silently acquired a file writer, and the
plan-mode guard only ever inspected `run_commands` — a `sed` call with
`in_place: true` crossed the boundary built to stop exactly that. Presets now
state all three flags, and the guard refuses `in_place` in plan mode with the
same message it gives `sed -i`.

**`cwd` was baked in at construction** rather than taken per call, so a host
that set `cwd` on the tools and nowhere else would have searched the process's
directory and been told "no match" — which reads exactly like a correct empty
result.

### Prompts

All ten templates gained sections for the three tools. Every template also said
`NEVER use grep`, which was unambiguous while that name belonged to nothing and
now names a tool in the model's own list; `run_commands` sections must name what
to reach for instead, and the remaining prohibitions say "through the shell".

## [4.100.104] — 2026-09-12

### The model submits the transaction; the boundary is only a guard

There was no way for a model to submit anything. `onCompletionAttempt` — the
only path that judges a transaction — is reached from exactly one place in the
runtime: **a turn that called no tools**. So submission was never a decision.
The model would think a turn through, call nothing, and be told *"TX-01 was
submitted"*, which is a report of something it had not done.

It is also the one thing the rest of the contract forbids. The no-tool-call
nudge exists precisely to stop a turn ending without a call, and the protocol's
only exit was to do exactly that on purpose. A model strong enough to hold both
ideas at once absorbs the contradiction — which is why this never showed up
before — and a smaller one either breaks on it or calls tools it does not need
in order to avoid ending a turn.

Measured on the test host under 4.100.103: ten turns, no tool calls, six
boundary messages, and reasoning reading *"I keep failing to emit actual tool
calls"*, *"I have called none of those yet"*, *"this loop above shows exactly
why things keep ending"*. It was not confused about the task. It was reacting to
being told it had submitted.

**`submit_transaction` is the submission now.** The model calls it when it is
confident, the check runs, and the verdict comes back as the tool result. The
opening rules gained a `HOW THIS TRANSACTION ENDS` section that says so.

The completion boundary stays, demoted to what it should always have been: a
guard for a run that has stopped calling anything at all. Until
`DEFAULT_SILENT_TURNS_BEFORE_GUARD` silent turns it asks rather than judges, in
words that never claim the model submitted, and any tool call resets the streak.
Submitting is not working, so the submit call itself does not count toward
whether the transaction was begun.

#### Two wordings the model read back to us

Both from the same session, quoted in its own reasoning:

- *"nothing has been used up"* / *"there is no clock on you here"* became
  *"there's nothing being wasted by my inactivity"*. It now says the transaction
  is not spent — still true — and then that this is not the same as costing
  nothing, because the run has a wall clock.
- *"`<check>` was run at that boundary and it FAILED"* became *"the prompt said
  this was pre-run"*. It now adds that this is the state of the files, not the
  model's diagnosis being done, and to read the file.

#### Also fixed

Four host tests. Three drove the boundary directly and now submit the way a
model does. The fourth had been red since 4.100.102 — that release deliberately
made a changed-nothing task run the check, and the test still asserted the old
behaviour; it is now two tests, one per verdict.

## [4.100.103] — 2026-09-12

### A transaction nothing was called in was never attempted

The empty-attempt budget charged a transaction for turns a reasoning model
spends reasoning. One nudge, two quiet turns, and TX-01 was spent — so roughly
four turns of thinking cost an attempt, and a six-transaction budget could go in
about twenty turns without a single edit ever being tried.

Measured on the test host: ten assistant turns, zero tool calls, TX-01 through
TX-03 discarded and TX-04 open, with the file untouched throughout. Four
transactions "failed" and nothing had been attempted once.

The note on `DEFAULT_MAX_EMPTY_ATTEMPTS` already describes that run — *"it read
as six failed attempts and it was one"* — and answers it by spending the budget
faster, which makes the misreading arrive sooner rather than removing it.

**The distinction it was missing.** A transaction the model worked in and left
with no net change is an attempt that failed, and spending it is fair. A
transaction it spent thinking, calling nothing, is not an attempt at all.
`withAnyToolSignal` counts calls of any kind in the open transaction — wrapped
outermost, so a call the check-first gate refuses still counts, because that is
the model reaching for a tool — and an empty submission with a count of zero no
longer spends anything.

What nudges a run that has stopped converging is the runtime's turn-level
non-convergence guard, which is built for exactly this and documented as nudging
and never ending. The transaction budget is not that guard and should not have
been standing in for it.

`DEFAULT_MAX_UNSTARTED_ATTEMPTS` is the backstop, at 6, so a model that will
never call a tool cannot hold a session open forever. When it fires the run ends
saying so, instead of leaving six discarded transactions behind that read as six
attempts.

**Tests.** 278 in `src/runtime/atomic`. Two existing tests drove the file with
`fs.writeFile` and no tool call, which a real edit never does — it reaches the
file through a decorated tool; they now work through one, which is what they
were describing.

## [4.100.102] — 2026-09-12

### A completion the check disagrees with is not a completion

The atomic change protocol had one silent exit, and it was the first branch of
the boundary it exists to guard:

```ts
if (controller.outcomes.length === 0 && untouched) { finished = true; return undefined; }
```

`finished` is permanent. A model that ended its turn before touching a file did
not just end that turn — it disengaged the protocol for the rest of the run.
Measured on the test host: a run ended `completed` on an early turn with TX-01
open, nothing read, nothing edited and the defect still present.

The reasoning behind the branch was sound and its scope was not. A task that
changed nothing really is not a transaction, and a model answering a question
about the code should be able to finish. But whether a run had work to do is
not the model's to declare where something here can answer the question: a
failing check is the defect still being there, and a completion on top of one
is a fix reported rather than made.

Everything needed to push back already existed a few lines below and was simply
unreachable — the empty attempt is held open, the transaction is not spent, the
rules are restated in full, and the empty-attempt budget bounds the repeat by
spending the transaction rather than hanging the run.

**What changed.** The stand-down now asks the check and only fires when the
check agrees. When it does not, the attempt falls through to the empty-attempt
handling, which now also reports that the check was run at the boundary and
failed, quotes its output, and says that what finishes the task is the check
passing rather than the model's account of the work.

A check that *cannot be run* yields no verdict rather than a failing one: a
broken harness must not produce a session with no way out.

**Tests.** 276/276 in `src/runtime/atomic`. The two new guard tests were
confirmed to fail against the pre-fix source. The existing test that asserted
the old behaviour used `exit 1` precisely so that a stand-down which ran the
check would be caught; it now uses a passing check, which is the case it was
really protecting.

## [4.100.100] — 2026-09-12

Five reporting fixes, all from one session on the test host.

**The context meter counted a request that could not exist.** `observeRequestTokens` judged a provider's count and its chars-per-token ratio together, then kept the count whichever way the judgement went. One usage event reported 138,549 input tokens for 138,262 characters — a token per character, which no tokenizer produces. The ratio was refused; the count was kept, beat the estimate of 48,258, and forced a compaction of a transcript holding 45,783 real tokens against a 64,000-token window. The chat then announced that as "138.5k → 104.7k tokens". The two bounds now reject different things: above the ceiling only the pairing is odd and the count still stands, below the floor the count is the impossible term and goes with it.

**The condensed-reasoning row reported characters under a token budget.** "43k → 620 chars" beside a 16,000-token allowance reads as an overrun of nearly three times the budget when it was under it. Converted in core, where the reasoning rate is calibrated, and carried as its own fields — a task saved before this still shows characters, labelled as characters.

**The `plan` row rendered an empty body.** The tool names no file and runs no command, so the generic lookup found nothing and produced a bare header. It now shows the plan. Any tool that names no file falls back to its arguments.

**A settled transaction never said how long it took**, so an hour of looping read like a first-try landing. Timed from `open()`.

**The completion box's duration never appeared on the first run of a task** — the long one. `runStartedAt` is stamped on the idle→running edge, and a new session is constructed already running, so the edge never happened. Only follow-up turns were ever timed.

## [4.100.99] — 2026-09-12

Four changes to the change protocol, all aimed at one measured failure: a small
model batches its edits, the batch fails its check, and the only way back is to
undo several things instead of one. Measured on JackOD4-AC 9B: 13.6
`restore_file` calls per run against qwen3.6 27B's 0.23 over 40 runs, and within
the arm near-monotonic with wall time — the three runs that restored nothing
were the three fastest successes, the three highest counts were the three
timeouts.

**`qwen.md` no longer tells the model to batch its edits.** It was the only one
of ten templates saying "emit all `editor` calls in the same response" and "run
the program once, after every change is in place", which contradicts
`protocol.ts`. The model was obeying an instruction, not ignoring one. Batching
of *reads, searches and commands* is unchanged — those cost nothing when one
turns out to be unnecessary.

**The protocol says the planned changes are made one at a time.** "Make exactly
those changes, in that order, and nothing else" is about scope, but it reads as
pacing, and the correction sat fourteen lines later and only when an oracle
exists. Caught in a non-qwen coder's own reasoning, talking itself out of the
right choice.

**Three checks over files nobody changed now settle the transaction.** `settle`
was reachable only from the completion attempt, so a model that never yields its
turn never settled at all — the timeout signature, zero transactions closed. The
trigger counts checks *without a change between them*, not failed checks: a
healthy transaction fails its check after every edit until the last fix lands.
On the baseline it fires in 3 of 11 runs, and they are exactly the three
timeouts.

**The third restore in a transaction says what that many means** — that the
reading behind the edits is wrong rather than the typing, and that a transaction
ending on a failing check is put back in full anyway. Firmer from the sixth. The
refusal cap is unchanged.

## [4.100.86] — 2026-09-10

Two fixes from live sessions on top of [v4.100.84](https://github.com/mann1x/cline/releases/tag/v4.100.84), both found by running a 9B model at the harness and watching what it did.

### Copying out of the chat panel

Nothing could be copied out of the chat any more — the paste came back empty.

The `copy` listener was `async`. It awaited the HTML-to-Markdown conversion, then called `preventDefault()` and posted the text to the extension host with `copyToClipboard(...)` — a promise nothing waited on, whose handler swallows its own errors and returns success regardless. The browser's own copy was cancelled in favour of a write that might never land, and when it did not land the only trace was a log line nobody sees.

Two paths failed differently. A selection inside anything with a `pre`-like `white-space` — most of a chat message — took the branch with no `await` before `preventDefault()`, so the cancel was real and the host was the only writer. The Markdown branch awaited first, by which point the event had finished dispatching and `preventDefault()` was already a no-op. Neither reads that way in the source.

It is synchronous now, start to finish, and the text goes out through `e.clipboardData.setData` — the copy the browser was already about to make. No round trip, and no `preventDefault()` unless there is text in hand to replace it with.

### Four faults from one session

A 46-minute run: 362 messages, 74 editor calls, two transactions, and it ended still sending an edit that had been refused five times.

**Compaction deleted the request.** 322 messages folded into 70, and neither the user's own words nor the transaction rules survived. Sixteen seconds later the model asked the user what the task was and which files it was working on. The pin that keeps a typed prompt verbatim refused index 0 — so the one transcript shape where the prompt matters most, a single request followed by a long tool loop, was the one shape that could not pin it. It pins now, unless that message is a previous summary.

**Running the check bought an exemption from stating the plan.** The check-first gate fired only when `run_check` had not run, and the two things it asks for were one condition. This session did the right thing first — `run_check` was tool call #1 — so the gate never fired and the whole run produced exactly one plan. The gate now fires once per transaction either way, and a model that has already run the check is asked for the plan alone rather than told to re-run what it just ran.

**A list sent as text was run as one item.** `search_codebase` was called six times with `queries` holding the *text* `["Math.random()<", "Math.random()>", …` — a serialised array, truncated. The whole literal became one regex, `[` opened a character class, and the tool answered "Unterminated character class". The model read that as an escaping problem, spent a thousand tokens on backslashes, gave up on the tool and shelled out to PowerShell — where `run_commands` took the same argument the same way. Both now parse a bracket-and-quote string as the list it is, or refuse it by name if it will not parse. `[a-z]+` and `[ -f package.json ]` are left alone.

**The refusal explained itself five times.** The same no-op edit, refused five times over the last twenty messages, with a full re-read of the file between three of them. Past four, the message stops explaining and names what is left instead.

### Also in here

Everything from v4.100.85, which was built and tested but never released separately.

## [4.100.84] — 2026-09-10

Everything since **v4.100.80**. Six reported issues are closed here, and the atomic-changes protocol was retuned against a small model.

### Reported issues

**#53 — image generation.** There is a `generate_image` tool now. It posts to any endpoint serving the OpenAI images API and writes the result into the workspace, returning the image to the model as well when the model can see images — so it can look at what it made and try again. Configured on a new **Images** tab in the API configuration settings, behind the checkbox *"Use an endpoint for image generation"*: an endpoint, a key, a model and a default size. The model field queries the endpoint the way the Ollama picker does. Checked end to end against `gen.pollinations.ai`, which lists 388 models of which 63 draw, needs a key, and answers with a JPEG while declaring nothing — so the file takes its extension from the bytes rather than from an assumption.

**#75 — context exceeded the set limit.** Delegated agents were running with no context pipeline at all: no compaction and no thinking cap. A reported session ran a sub-agent 34 consecutive requests past the window, peaking at 491,454 input tokens against the 262,144 configured, while the lead agent on the same model compacted normally. Each delegated agent now gets a pipeline of its own, and it compacts against *its own* model's window rather than the lead's.

**#73 — MCP auto-approve.** Two defects in one lookup. The per-tool tick boxes had been hidden as no-ops upstream while this fork still required the per-tool flag, so nothing could be granted from the UI and the VS Code-borrowed servers could not be granted at all. Worse, and unreported: policies were keyed by the raw `server__tool` pair while tools register under a transform that rewrites punctuation and truncates past 64 characters — so a server called `Microsoft Learn`, or any long `github.com/...` name, matched no policy and the SDK auto-approved it regardless of the toggle. Both were in the reporter's own settings file.

**#76 — total token count.** A line under the context bar with the task's totals in and out plus a generation rate, taken only from providers that time themselves. Every usage record now carries the provider and model that spent it, so a task split across connections shows the split — which of those tokens were free and which were billed. Two accounting gaps closed on the way: a batch of sub-agents was summed into one record even across endpoints, and a *configured* agent's tokens reached no total at all.

**#72 — agent name and colour.** `spawn_agent` takes an optional `name`, and the lead is asked to give each sub-agent one. Colour comes from position in the row rather than a hash, so two visible agents cannot collide. Red and green are not in the palette — they mean failed and completed everywhere else.

**#56 — terminals.** The last abandoned terminal of a session stayed open until you ran another command or closed the window. The cleanup queue now records *why* each terminal is waiting: one that received nothing but Cline's own `cd` closes immediately, one that may hold output you want still waits.

### Atomic changes

Five findings from a single 75-minute JackDelta 9B session, six transactions, all discarded:

- **The prefill rate was nonsense.** `prompt_eval_count` is the whole prompt including the cached prefix, while `prompt_eval_duration` covers only what was evaluated — the two divided reported 1.44 million tokens/s. Computed on the evaluated tokens now, and a fully cached prompt reports no rate rather than an infinite one.
- **Three declared changes is a large-model number.** The model made 56 editor calls against a ceiling of three; the ceiling was not restraining the work, it was making the declaration a fiction. Now six — and the extension kept a second copy of that default which silently overrode it, so the number the model was actually told stayed three until this release.
- **The restore cap ended runs.** Nine now, up from three; the model had been naming the exhausted cap as its reason for giving up.
- **The check is run before the first edit**, once per transaction, and the plan is asked for on the record.
- **A failed transaction is asked for a retrospective** — what worked, what did not, what to reuse, what to approach differently — and it is carried into the next transaction's plan.
- **When the user's own check has reported the identical string all run**, the model is now told so, and told the check is the gate to marking the task complete rather than the task itself.

### Also in here

**Settings: an oracle field no longer erases the other as you type.** This shipped as the `v4.100.81` tag, which never had a release cut for it; it is folded in.

## [4.100.80] — 2026-09-08

### 4.100.80

One change: the green box says how long the run took.

#### The completion box says what the run cost

A finished request has reported its duration since 4.100.12, as a grey row
after the answer and only past a three-minute floor. The row is easy to miss,
and it is in the wrong place — "how long did that take" is asked while reading
the green **Completed** box, not while scanning the transcript underneath it.

The duration now sits beside the label:

```
COMPLETED in 28m
The task is finished.
```

It is carried on the completion row itself rather than written into the model's
sentence. That distinction is the reason for the new field: the sentence is a
transcript message, and appending to it would send the annotation back to the
model on the next turn as something it had written.

**No floor on this one.** The floor exists because an annotation nobody asked
for has to earn its place on every row it appears on. The completion box is
being read for exactly this, so a run that finished in forty seconds has a
right to say so. Seconds below a minute, then minutes, then hours: `45s`,
`28m`, `1h2m` — rounded, so 59m50s reads `1h0m`.

**Known limit.** The translator pushes the completion row in the same batch as
the run's `done` event when the turn ended with text, which is where it gets
stamped. A turn that completed through the completion *tool* emitted its row in
an earlier batch and cannot be stamped from there; that path keeps the old row
after the answer, three-minute floor and all.

## [4.100.79] — 2026-09-08

### 4.100.79

One change: a guard for a run that thinks at length and does nothing.

#### Thinking at length is not the same as working

A run on the manic_miner harness spent six consecutive turns and roughly
226,000 characters of reasoning without emitting a single tool call, and the
runtime did not notice. `consecutiveNoToolCallNudges` sat at 1 throughout: it
increments only when a nudge is actually sent, and every silent turn in between
was answered by something else — a `check_file` reminder, `TX-01 discarded`, a
plan reminder — each of which returns from `runCompletionBoundary` and
continues the loop. There is no bound on those re-entries in the runtime.

**The obvious guard does not work.** Measured over 106 thinking blocks from
eight runs of one model (87 turns that also called a tool, 19 that did not), no
property of the text separates them:

| feature | productive (n=87) | barren (n=19) |
|---|---|---|
| chars, max | **51,141** | 41,412 |
| max line repeat | **17** | 21 |
| repeat mass | **0.567** | 0.369 |

The longest block in the corpus, the most repetitive, and the highest shingle
repeat all belong to turns that *did* call a tool. Any threshold on length or
repetition that caught the stuck turns fired on at least a third of the working
ones. This is also why `ReasoningLoopGuard` is silent here: it detects
repetition collapse, and this is non-convergence, which reads as deep
productive work.

**The streak of turns does separate.** Consecutive turns with no tool call: six
in the failing run, one or two in every other. A threshold of three fires
exactly once across all 106 turns.

So the guard counts turns, and it **nudges** — it never ends a run. The sample
is small enough that it should not be trusted to: zero false triggers in 105
turns puts the ceiling near 3% per turn, not at zero. A false positive that
costs one message on a working run is affordable where killing that run is not.

A **reasoning floor** came out of the test for the opposite failure, which the
first draft had: a model that has finished, answers a completion boundary in one
sentence, is asked again, and answers again. Telling that run to stop analysing
is backwards. Stuck turns carried 26,000–41,000 characters each, and every
barren turn under 4,000 was a final answer, so the floor sits at 2,000 and a
turn below it resets the streak.

The message is new rather than the existing nudge repeated. That one was sent 11
times across this corpus and the next turn called a tool 4 times — and it failed
at the exact case here: nudged, and the next turn came back with 41,000 more
characters and nothing called.

`noToolCallTurnStreakLimit` configures the threshold; zero turns it off. It is
gated behind the existing nudge budget, so a host that set that to zero is
unaffected.

## [4.100.78] — 2026-09-08

### 4.100.78

Two small fixes, both found by watching a local model work rather than by reading code.

#### A window title is not command output

`run_commands` was handing the model this, twice in one session:

```
{"ok":false,"error":"SyntaxError: Unexpected token '{'", …}
;pwsh in test
```

That second line is half of PowerShell's shell-integration title sequence. The
ANSI stripper took the introducer off and left the rest in the captured output,
where it reads as something the command printed — directly after the JSON the
model was trying to interpret.

The OSC branch came from `ansi-regex`, and its payload charset has no space in
it. `ESC ] 0 ; pwsh in test ESC \` is mostly spaces, so that branch could not
match, and the CSI branch underneath then matched `ESC ] 0` on its own. A
window title is the common case for an OSC payload, so the new branch runs to
the first terminator instead of trying to constrain what is inside it — lazily,
so an unterminated introducer in a chunked read cannot swallow output up to some
later BEL.

#### `code_intel` took the name it was given under the wrong key

`workspace_symbols` reads the name to search for from `symbol`, and already
accepted `path` as a second spelling. It did not accept `query` — so this call

```
code_intel {"operation":"workspace_symbols","query":"setupLevel"}
```

was answered with "needs a `symbol` to search for" while the name it needed sat
unread in the same call. The model burned a turn and fell back to
`search_codebase`, which is the fallback the tool description explicitly tells
it not to make.

The guess is a reasonable one: `search_codebase` sits beside this tool in the
same tool list and takes `queries`. `symbol` stays the only documented name —
the schema is unchanged — and the parser is simply tolerant of the near-miss.
The refusal now names both spellings.

## [4.100.77] — 2026-09-08

### 4.100.77

#### The blank panel, found

Since 4.100.72 a few people have opened Cline to an empty panel — no message,
nothing in the output channel, nothing in the webview logs, and no way back but
a reload. 4.100.76 added the instrumentation that would say *something* when it
happened. It said this, on the first try:

```
TypeError: Cannot read properties of undefined (reading 'length')
```

A scoped tab — the Vision tab, or an agent's configuration — stores the model
selection it was committed with, and it stores the plain overrides object rather
than the protobuf message. The provider panels read that object back through
`fromProtobufModelOverrides`, which guarded thirteen of its fourteen fields
against `undefined` and read `capabilities.length` unguarded, because a message
built the normal way always has that array. A stored one does not.

So a scoped tab holding **any** saved per-model override — Per-Turn Max Output
Tokens is the one people actually set — threw during render. React unmounted the
tree, and before 4.100.76 nothing caught it. That is why it was "only when I'm
doing something in the config or editing an agent, not on the main chat": those
are the two scoped tabs.

Both halves are fixed: the reader guards `capabilities` like every other field,
so no caller can take the webview down this way again, and the scoped selection
is now built as a real message rather than cast into one.

#### A broken settings panel is not a broken session

The boundary that caught this one is at the root, so a panel that could not draw
took the chat down with it -- the whole webview became an error card over a task
that was still running, and the only way back was a reload that also empties the
composer.

Each overlay view -- Settings, History, Marketplace, MCP, Account, Worktrees --
now carries its own boundary above the permanently mounted chat. A view that
throws stops at itself: the conversation stays on screen behind it, the message
names which view fell over, and a button closes it instead of reloading. The
failure is still written to the output channel either way.

#### Agents that work while you carry on

`/delegate` suspends the lead model until the agent reports back. Sometimes that
is what you want and sometimes you would rather keep talking.

**`/delegate-background <agent> <task>`** starts the agent beside the session
instead of in front of it. It runs on its own, the conversation continues, and
its report is delivered when it is done — appended directly if the session is
idle, queued as a steer if a turn is holding the transcript, so nothing is
dropped and nothing interrupts a reply mid-stream.

A **Background agents** panel in both surfaces lists what is running, what it is
doing right now (which turn, which tool), and lets you **pause**, **resume** or
**stop** any of them. Pausing holds the agent between requests rather than
killing a response in flight.

#### Also in this release (and in the unreleased 4.100.76)

- **A panel that goes blank now says so.** Four independent mitigations: the
  initial state build is inside the try/catch that owns the subscription, a
  webview render failure is reported to the extension output channel and the
  subscription retried with backoff, a watchdog replaces an indefinitely blank
  panel with a message and a reload button, and a root error boundary catches
  what React would otherwise unmount silently.
- **One server's slot count is not another server's.** Concurrent-agent limits
  are per endpoint now, so a single-slot local server no longer sets the bound
  for the fast one next to it.
- **An event does not need a copy of the whole conversation.** Runtime snapshots
  clone the transcript lazily. Every event carried one, including per-token
  deltas, and two consumers actually read it.
- **The diagnostic report is versioned**, so a report collected with an old
  script can be spotted rather than trusted.

## [4.100.75] — 2026-09-07

### 4.100.75

#### Delegate to an agent, deliberately

Configured agents already carried their own model, profile, tool list and skill
list, and each one already reached the model as a `subagent_<name>` tool. What
was missing was a way to *tell* Cline to use one: only the model could decide to
call it, so "run the QA agent on this" was a suggestion it could decline.

**`/delegate <agent> <task>`** runs the agent directly, in the CLI and in VS
Code. The lead model is not consulted about whether to delegate and does not get
a turn until the agent has reported back. It executes the same tool object the
model would have called, so provider resolution, profile resolution, per-agent
skill filtering and the endpoint slot gate are the implementations that already
work rather than second copies of them. The report enters the conversation as a
user-role message, not a manufactured tool call answering a request nobody sent.

An agent file is markdown with frontmatter, in `.cline/agents` in the workspace
or in the Cline data directory:

```yaml
---
name: qa
description: Runs the QA skill over a change
profile: local-qwen      # or providerId + modelId
skills: [qa]
---
You are QA. ...
```

Worth knowing: `subagent_<name>` tools are **not** withheld on a
one-request-at-a-time endpoint, unlike `spawn_agent` and the team tools. A
delegated hand-off is synchronous — the lead is suspended while the agent runs —
so one slot is enough. Only the tools that run agents *beside* the lead need
more.

#### The model can create an agent

**`create_agent`** — "create an agent for software engineering and one for
network troubleshooting" now works. Until now the format was documented nowhere
the model could read and the only writer was the VS Code editor, reachable by a
human with a mouse. It is offered to the lead alongside the subagents it creates
and withheld with them, and it will not overwrite an existing agent unless asked
to. Agent files are read when a session starts, so a new agent is available in
the next session rather than the one that wrote it.

The renderer now lives in one place shared by the editor and the tool, so a file
written by either is a file the other can read.

## [4.100.74] — 2026-09-07

### 4.100.74

#### A guard on the thinking channel (#69)

A model that collapses into a repetition cycle mid-thought keeps generating
until something stops it. On a local Ollama model that something is
`think_budget`; Ollama Cloud has no thinking budget, so there is nothing
between a degenerate draw and the context window — which is what #69 paid for.

Cline now watches the reasoning stream itself and cuts the request when it sees
a cycle. Cutting the stream cancels the provider request, so the tokens stop
being billed at the cut rather than at the window. The turn keeps whatever it
produced and continues, so a model that was briefly stuck can recover; a model
that redraws the same collapse three turns running ends the task instead.

Three signals, all taken from real collapses rather than invented:

- a window of completed lines carrying almost no distinct lines — your case,
  two checklist items flipping between `[ ]` and `[x]`, which defeats a
  plain period test but is unmistakable this way;
- an exactly periodic block of lines;
- a phrase repeating inside one unbroken line.

**Length is never the signal.** Healthy agentic reasoning runs to 150k–260k
characters in a single turn, and a guard that fired on volume would kill good
turns. Thresholds were set against 1,556 recorded reasoning blocks and checked
against a run that completed its task successfully. On by default; settable
through `execution.reasoningLoopDetection` (`false` turns it off).

This is a mitigation, not the fix. The fix is a thinking budget the provider
enforces — ollama/ollama#18212 is the sampler side of that and is still open.

#### Compaction asked for mid-turn now waits instead of vanishing (#70)

VS Code answered "Cannot compact while a response is in progress"; the CLI
silently did nothing at all. Both now hold the request and run it the moment
the turn ends. It is keyed to the conversation you asked from, so it cannot
fire against a different one later, and asking twice says it is already queued
rather than queuing twice.

#### Streaming text no longer repeats itself

Every text delta on the wire carried the whole block so far, making the event
stream quadratic in the length of a reply: one long answer cost 830 MB of
events against 12 MB for the same content sent as deltas. The webview now
accumulates on its side, as it always did for reasoning.

## [4.100.73] — 2026-09-06

### A check the model proposed can now be wrong

Where a workspace holds nothing runnable, the model proposes the check that
decides whether its change worked and you approve it once. That check is then
frozen for the rest of the run, and the freeze is load-bearing: a model allowed
to re-propose after a failed attempt will weaken the check until one passes,
which is an elaborate way of arriving back at judging its own work.

The freeze also froze checks that could never pass. Measured over ten runs on
one workspace, that cost two of them outright — about forty minutes each, every
attempt discarded, the file rolled back to the broken original:

* one adopted a check keyed on a field that is true only when the page did
  **not** start on its own, so no correct fix could ever satisfy it
* one adopted `node -e "try{...}catch(e){...}&&node run_game.js ..."`, which is
  not valid JavaScript — a `try` statement cannot be followed by `&&` — so node
  died on its own argument identically whatever the workspace held

The second one worked out what was wrong. Its third and fourth proposals were
both the correct check, the one eight other runs used, and both came back
"frozen for the rest of the run". The prompt had been arguing against that
conclusion the whole time: the record of earlier attempts closed with *"if the
same symptom is still there, the previous reading of it was wrong"*, which is
right about a check that has ever passed and wrong about one that has not.

So there is now exactly one way out. After two discarded attempts in which the
check has never once passed, the model is told so and may propose **one**
replacement. Every clause is a guard:

* only a check the model proposed — one you wrote, or one detected in the
  workspace, is the specification and is never reconsidered
* only if it has never passed, in any `run_check` call or at any attempt's end
* only counting attempts that actually changed files, so a model that edits
  nothing cannot buy its way to a fresh proposal
* never on the last attempt, where a replacement would judge nothing
* once
* the replacement is held to the same standard — it must fail on the unmodified
  files — and offering the same check back is refused rather than re-frozen

It also brings its own proposal round rather than spending the run's budget:
the measured run that needed this had one round left by luck, and a single
decline would have closed it.

**Two settings**, under Features → Change Protocol, shown when *Model proposes
the check* is on:

* **Attempts before a rethink** — 2 by default, **0 turns it off** and restores
  the freeze exactly as it was
* **Proposals you judge** — 2, which is what it always was before it could be
  changed

On the CLI: `--check-reconsider-after` and `--max-check-proposals`.

### A check that could not run is no longer mistaken for a check that failed

"The command found a problem" and "the command is itself broken" both arrive as
a non-zero exit, and only one of them is a check. Before approving, a proposal
is now also refused when the failure is the interpreter rejecting the check's
own program — node's `[eval]`, the shell's `-c`, python's `<string>` — or when
the exit code is **127**, which is the shell saying it never found the program
at all. A check reporting a syntax error *in a file in your workspace* is the
check working, and still adopts; the difference is where the error is, not that
it is a syntax error.

### The model no longer loses a round to a proposal that was already clear

Three things measured across ten runs, each of which cost a round trip:

* **`kind` left out, four times.** Every one of them named `path` or `command`
  and nothing else, so there was never anything to disambiguate. The kind is
  now read off whichever field is present. Giving both, with no `kind`, is two
  different checks and is asked about — it used to take the command and drop
  the path in silence.
* **No `expect`, three times**, against a runner that prints its verdict and
  exits zero either way. Each was told only that the check "already passes",
  which is true and not the thing to fix. It now says the exit code was the
  whole verdict, shows what the command printed, and asks for an `expect`.
* **The working directory guessed**, once, as an absolute `cd` baked into the
  command. The tool description now states that a check runs with the workspace
  root as its working directory.

Across the twenty runs after these changes, every run adopted a workable check
on its first or second proposal, and none of the two whole-run losses recurred.

## [4.100.72] — 2026-09-05

### Cline can now use the MCP servers you configured in VS Code

Any MCP server VS Code is running is offered to the model as a Cline tool,
prefixed `vscode__` so it cannot collide with a server you have also configured
in Cline itself. Nothing to set up: if VS Code has it, Cline offers it.

**This reaches servers Cline cannot connect to on its own.** Figma's MCP server
advertises a registration endpoint and then 403s everyone who tries to
register, so Cline can never obtain a client id and can never authenticate.
VS Code already holds a token for it. Cline now invokes through VS Code instead
of trying to connect.

They appear in **Manage MCP Servers** as an entry of their own, with the
controls every other server has:

* a toggle that stops offering them to the model
* a tick box per tool that lets it run without asking

Auto-approvals here are Cline's own list — the approval settings for those
servers live in VS Code, where Cline cannot read them, so nothing is assumed
and an untouched tool asks every time. The entry cannot be deleted from Cline;
the server belongs to VS Code and is removed there.

They are grouped under one entry rather than one per originating server because
VS Code does not say which server a tool came from — it flattens that into the
tool's id, and the field that would answer it is behind a proposed API.

`cline.vscodeMcpTools` turns the whole thing off.

### `providers.json` is no longer read three times a second

Posting state to the webview re-read and re-validated the whole provider
settings file from disk, synchronously, on every streamed chunk. In one
reporter's logs that was **21,556 reads across two sessions** — the loudest
line in the file after the agent events themselves. The parse is now kept while
the file's stat has not moved, keyed on modification time and size together so
a write from the CLI or the hub is still seen.

### The report script collects VS Code's own logs

`tools/Collect-ClineReport.ps1` now takes `exthost.log` and `renderer.log` for
the same windows it takes Cline's log from. An extension host that dies and a
webview that crashes both leave Cline's own log ending mid-line, which is
indistinguishable from the user closing the window; both are recorded next
door, by VS Code.

It also picks the Cline logs better. Windows does not update a file's directory
entry while a handle is open on it, so the log of the window that is actually
running can look hours older than one closed long before — and newest-by-mtime
dropped it. A report collected on 2026-09-05 arrived without the log covering
the incident it was about. It now takes the newest by path as well, since the
timestamp in the log directory's name is written when the window starts.

The copy on `main`, which is the one the link in an issue points at, was also
three changes behind and is now current.

### `--propose-check` for the CLI

`propose_check` only arms where the host can ask a user to approve what the
model proposed, and the extension was the only host that could — so every
headless run in a workspace with nothing runnable got the verdict that preceded
the feature, the model's own account of its work, with no way to ask for the
other one.

`--propose-check auto` approves the proposal without asking, which is the only
shape an unattended batch can run it in. `--propose-check off` pins the
self-declared verdict explicitly. Absent behaves as before, and a typo is
rejected rather than coerced: falling back to the default would run a whole
batch on the verdict you believed you had switched away from.

## [4.100.71] — 2026-09-05

### The check the model is judged by is now a check it can run

The protocol's check reached the model from exactly one place — `settle`, at the
completion attempt — while `propose_check` told it the opposite: *"it is run for
you, unattended, every time your turn ends, and its result comes back to you."*
So a model that proposed a check believed it had a feedback loop, stopped
building one of its own, and got no verdict at all until the transaction was
over.

Measured on one workspace with nothing runnable in it, under 4.100.68: TX-01 ran
**341 messages and 65 edits with nothing judged**, then one `SyntaxError:
missing ) after argument list`, then a full rollback — after which the model
copied the original file back over its work and started again. Across a dozen
runs there, the arm with a proposed check took **four to six times** the model
time of the self-declared verdict it replaced (18 minutes and a clean finish on
4.100.61; 41, 45, 81 and 107 minutes after), and closed nothing.

The arm that works has never had this problem, and not because its check is
better. There the check is a shell line named in the opening prompt, so the
model reruns it whenever it likes — 88 `run_commands` in one run that ended
FIXED. **A check the model cannot type is a check it cannot consult.**

#### `run_check`

No arguments, offered whenever the protocol is armed, including before any check
exists. It runs the current check against the working tree and **settles
nothing and rolls nothing back**: the result is information, the transaction
stays open, the changes stay on disk. Ten per transaction, counted again on the
next one so a discarded attempt can still see what it died on. A check that
cannot run at all says so and says explicitly that this is not a reason to stop.

It is also the only way to reach a `page` check, which runs inside Cline and
cannot be typed at a shell — and it is offered for a configured oracle too,
where it saves the model retyping the command.

#### The description now says what happens

Which matters on its own: a model told it is being checked stops checking
itself. Both branches of the opening protocol prompt point at `run_check` as
well, with the same instruction — run it *before* you edit, so you see the
failure in the check's own words, and again after each change.

#### A switch, so the two can be compared

**Settings → Features → Change Protocol → "Model proposes the check"**. On by
default. Off returns the no-check case to the model's own account of its work,
including standing down in Auto exactly as it did before the feature existed —
there is a test on that last part, because it is the easy thing to get wrong.

#### Verified

New tests run the check twice across an edit and assert the file is left as the
model wrote it and no transaction was settled; others cover the no-check
message, the per-transaction budget and its reset, and a check that throws.
Suites: core 3177, vscode 1516, llms 949, CLI 1226, agents 134, hub 111.

## [4.100.70] — 2026-09-05

### Auto-compaction stood down on a full transcript

Reported on 4.100.67 (#68): a 256k Ollama window showing **262.1k of 262.1k
used**, no compaction anywhere in the task, and the turn dying on repeated
"output limit reached before the turn finished — retrying" against a window
with no room left in it.

The compaction trigger prefers a provider's own count of the last request over
its own character estimate, because a count cannot be wrong. But that count
lives in **one slot on `globalThis`**, and the gateway wrote it for every
stream that did not set `auxiliary`.

The SDK's summarisers set `auxiliary`. **Neither host set it anywhere** — the
flag appeared nowhere in `apps/vscode` or `apps/cli` — so the image describer,
the commit-message writer and the prompt-template generator each left their own
small count standing as the session's. The next compaction pass read it and
concluded the transcript had room.

In the reporter's own diagnostics, **302 decisions across twelve days and five
models** had the estimate above the trigger and the observed count below it.
The worst vetoed a 436,717-token estimate with an 18,875-token observation,
against a 262,144-token window.

#### The retry was suppressed by the same slot

A turn cut off at the output cap with no tool call asks `lastOutputCap()`
whether the *window* is what capped it, and forces a compaction if so. That
report shares the slot. A cap another call ran into answers the question wrong,
which is why the screenshot shows two retries and no compaction between them.

#### Stated positively now

`GatewayStreamRequest.conversation` says a request **is** the conversation, and
only such a request writes the token count, the output cap and the overflow
note. The session orchestrator sets it; nothing else does. Forgetting it now
costs an estimate instead of a measurement — a bad turn rather than a dead run
— which is the whole point of turning the question around.

`auxiliary` keeps its other job: queueing behind the conversation for a local
server's single slot. The two host paths that never claimed it now do.

#### Two conversations in one process

The records also carry the session they describe, and readers ask in their own
session's name, so a delegated agent and the lead that spawned it stop
answering each other's questions. Unknown on either side reads as a match, so a
caller that cannot name its session keeps exactly what it had.

### A command that printed nothing is not a command we failed to read

The terminal reported an empty capture and an empty command identically, so a
command that legitimately printed nothing came back carrying **unrelated
scrollback** — the terminal's own snapshot, handed to the model as that
command's output. Measured at 5 of 9 calls in one run.

The two are now separate questions: whether output was captured, and whether
the capture machinery ran at all. A silent success says so in words; only a
genuine capture failure falls back to the snapshot, and it says that is what it
is.

#### Verified

The gateway test goes red against the old behaviour with the exact symptom
(`expected 4000 to be undefined` — a foreign request's count standing as the
session's). Suites: vscode 1516, core 3166, llms 949, CLI 1226, agents 134,
hub 111.

## [4.100.69] — 2026-09-05

### The tool-result cap belongs to a configuration, not to the app

The cap decides how much of a single tool result reaches the model, and it is
read **against a context window**: the number that keeps a result useful at
256k throws most of it away at 8k.

It was global on both sides — written with no scope awareness, and read once
when a session was built from the one global settings key. So a profile with a
256k window and a profile with 8k had to agree on it, and a field sitting in a
per-profile panel saved nothing per profile.

It now lives on the configuration, exactly where the context window lives:
stored in `providers.json`, carried in a profile's snapshot, and owned by the
Vision and Agents tabs rather than shared with the session.

**Resolution is profile, then the provider entry, then the global setting.**
Anything configured before this release behaves precisely as it did — an
absent value still means the global one decides.

#### Delegated agents take it too

`DelegatedAgentConnectionOverride` gained the field, deliberately, though it is
not a connection field. An Agents tab that names a context window of its own
has named a different budget with it, and a tab that shows a cap its agents
ignore is worse than a tab with no cap on it. Absent, agents keep the
session's — the rule the rest of that override already follows.

#### A bug found on the way, in the same family

`parallelSessions` was **write-only**. The store wrote it to `providers.json`,
the settings panel read it back off the effective config, and the effective
config never read it out of the settings record. So the field went blank after
a reload and looked as though nothing had been kept — while the runtime was
using the value quite happily, because the runtime reads a different path.

Two read paths, one of them wired. Both are read back now, and the new cap
would have shipped with the identical hole had it copied the pattern.

#### Zero clears it

A stored zero would say "send no tool result at all", and nothing downstream
would have explained why results had gone empty. Blank means the global
setting decides again.

#### Verified

New tests cover the read-back, the absent case, and a stored zero being
ignored; the read-back test fails without the fix, which was checked by
removing it. Suites: vscode 1510, core 3163, webview 614, CLI 1226.

## [4.100.68] — 2026-09-05

### A scoped tab must not build a write on a stale snapshot

Fixes #67, and with it a class of "the profile won't save" reports going back
a month — the Vision and Agents tabs, the context window, the request timeout
and Per-Turn Max Output Tokens were all one mechanism seen from different
angles.

#### What was happening

Vision and Agents keep their **whole** configuration in a single settings
string, and that string reaches the panel as a prop — a round trip behind,
updating only once the host echoes it back. Every field built its patch on
that prop. So any two writes in one interaction started from the same stale
base, and the second silently undid the first.

The Ollama context window fires exactly two, from one `onChange`:

```
write({ contextWindow })           → providerConfig patch
commitModelSelection({ modelId })  → providerConfig patch, same stale base
```

The second stored a `providerConfig` with no `contextWindow` in it.

**That is why there was no Update button.** The panel ended up matching the
saved profile exactly, so the dirty check was right to say nothing had
changed — the edit had already been reverted. Done then had nothing to keep,
and reopening the tab showed the old value. Reported as "the change is not
detected", which was a more accurate description than "the save failed".

#### The fix

The snapshot now lives in a writer rather than in a prop. It applies each
patch **synchronously**, so the second write in a turn builds on the first;
it **persists in order**, so the last edit applied is the last one stored;
and it **ignores an incoming prop while its own writes are unacknowledged**,
because mid-flight that prop is the state from before the edit — adopting it
reintroduces the same bug from the other side.

#### Two more, found while tracing it

- **Per-Turn Max Output Tokens could never be saved on Vision or Agents.**
  The scope contract took `commitModelSelection(modelId: string)` and
  discarded the rest; that field rides in the selection's `overrides`. Not a
  race — a hard drop. The selection now travels whole, and is read back beside
  the model id so the field shows what it committed rather than reverting.
- **A request timeout rolled back the context window.** The settings save
  rebuilt the snapshot around the render's `providerConfig` instead of the
  current one.

#### Plan and Act were never affected

With no scope, those writes go to the host, which merges them into
`providers.json`. The stale-prop base does not exist on that path.

#### Still global, deliberately

The **Tool Results Character Cap** is not per-profile and this release does
not pretend otherwise. It is a global setting end to end — written with no
scope awareness, and read once globally when a session is built. Making it
per-profile needs a snapshot field *and* per-scope resolution in the session
factory; storing it per profile in the UI alone would have looked fixed while
the runtime went on ignoring it.

#### Verified

Seven tests, run against the previous behaviour as well as the new: **four go
red without the fix**, including both headline cases — the context window
surviving the model commit, and a settings edit not rolling back a provider
edit. The per-turn-max case is held by the type signature rather than by the
writer, which is stated here because the suite alone does not prove it.

## [4.100.67] — 2026-09-05

### A range and an `old_text` that disagree is not an edit

`editor` dispatched on `start_line` and never passed `old_text` to the range
path. A call carrying both replaced the lines it named and **never checked the
anchor it also sent**.

Measured live, in a transaction that then failed:

```
{ start_line: 100, end_line: 102, old_text: "\n", new_text: "\n" }
```

One blank line named as the anchor, three lines replaced. It deleted a class's
closing brace and a `function update(){` declaration, reported `Replaced lines
100-102` as success, and left the model to work out what had eaten its code.
It concluded that blank lines "anchor incorrectly" and that the file was
"un-editable through micro-edits". They were not anchoring at all.

Across six sessions: **134 editor calls, 26 carried both, and 13 of those 26
had an `old_text` whose line count could not fit the span it named.** Ten of
the thirteen were on 4.100.65 — before `restore_file` existed — so this is not
a regression in the new tools. It is the failure they made visible: until a
model could undo one file, a destructive edit stayed in the transaction and
poisoned everything after it, silently.

**The two halves must agree, or nothing happens.** A mismatch is refused, with
the file's current lines quoted back, and the file untouched. A leading or
trailing newline around the anchor is tolerated — a model brackets its anchor
with line breaks about as often as not, and refusing over punctuation is its
own failure — and a pasted read gutter is stripped before comparing.

**Refused, not re-anchored.** Preferring `old_text` and re-finding it would act
on whichever half happened to be right by luck. A call whose two halves
describe different code is a call whose author is wrong about the file, and the
repair that works is to read it again. A refusal costs one turn; the silent
version cost a transaction.

**The large-range guard now skips an anchored range**, which is what its own
message and the test named for it always claimed. That test passes `old_text`
with *no* range, so it took the other path entirely and the both-supplied case
had no coverage at all. Its `carries no old_text to check it against` is now
only printed when that is true.

Four tests, two of which go red with the check disabled.

## [4.100.66] — 2026-09-05

The change protocol has always held what every file said when the open transaction started — that copy is the undo the rollback is built on. Until now only the rollback could read it, so a model that damaged a file had to rebuild the original from memory. This release hands both halves to the model.

**`read_files` with `revision: "base"`** — the file as this transaction found it. Ranges, line numbers and truncation go through the same windowing as a working read, so the two can be laid side by side. No read receipt is recorded for it: those line numbers are the pre-edit ones, and crediting the read would let the editor accept an edit to lines of the working file the model has never seen.

**`restore_file`** — one file back to that state, discarding your changes to *that file* and nothing else. A file the transaction created is deleted, because that is what putting it back means. A path that never existed is refused without spending budget. A file that already matches the base is refused and told so — that is a model that has lost track of what it changed, and the answer it wants is that the fault predates it.

Both appear **only while the change protocol is armed**. `read_files` is decorated inside the protocol session rather than given a permanent parameter, so a host running without the protocol keeps byte-for-byte the schema it had: there is no base revision without an open transaction, and advertising one anyway teaches a call that can only be refused.

**Bounded, on purpose.** Three restores per transaction, reset on a new one, with the remaining budget stated on every call. A cheap undo lowers the price of a reckless edit, and this model class has been measured issuing twelve `rm` of the file under test in one transaction and losing the file when the twelfth outlived it. A restore loop that announces itself is the point — the failure it replaces was silent and cost two hours.

**Why now.** Measured on the run that prompted it: 7328s and three discarded transactions, with 22 of 43 edits going to a line the same transaction had already edited, and 91% of the wall clock falling after the model first wrote *"I accidentally deleted the entire `dDec` method. Let me restore it correctly"* — restoring, from memory, a 400-character minified line. The snapshot next door had it exactly.

**Known limit.** `forgetReads`, which retires a restored file's read receipts, is wired in the VS Code host. The CLI's receipts are created inside `createDefaultExecutors` and are not reachable from the runtime host, so there it is unset and the warning in the tool's own result is all there is.

---

### Also in this release: a tool call nobody could read is not a turn that called nothing

Ollama's qwen parser hands a block it cannot parse back as content rather than failing the request — which is right, since a turn may already have run commands and there is no safe automatic retry. What it leaves behind is a turn that looks, to everything downstream, like a model that called nothing. It is not: the model tried to act, and `Your last message contained no tool calls` is false in the one way most likely to make it do the same thing again.

Measured on the run that prompted this: **eight such turns, 526s and 16,552 output tokens, one discarded transaction**, and the raw `<tool_call>` left standing as the run's Completed message.

The defect is diagnosable rather than guessed at. In all eight the model opened a call, got part-way through a parameter, abandoned it without a closing tag, and started the whole call again — and the count of unterminated parameters matched the count of extra `<tool_call>` openings exactly, every time. The parser cannot tell an abandoned attempt from the value of the parameter it was abandoned inside. Each of the eight ended in a complete, well-balanced call: the model got it right on its final attempt and was told it had emitted nothing.

So the nudge now names the function the model was reaching for, counts the restarts back to it, and says plainly that nothing ran. And a garbled call no longer ends the run once the silence budget is spent — once per run, gated like every other extension of the nudge policy, so a host that set the budget to zero still ends on a silent turn.

Detection is narrow on purpose: an unterminated parameter is the evidence, and a nested `<tool_call>` alone is not. A model editing a file *about* tool calls writes that tag inside a parameter it then closes properly, and prose that merely mentions the tag names no function at all. Both have tests.

The Modelfile was never the problem — `RENDERER qwen3.5` and `PARSER qwen3.5` are both set, and ollama's qwen3.5 parser delegates tool calls to the qwen3-coder one, so the dialect was the expected one. The remaining fix belongs in that parser: treat a `<tool_call>` opening inside an unterminated parameter as a restart and parse the tail. All eight were recoverable that way.

## [4.100.65] — 2026-09-05

Two things reported from live use of 4.100.64 on Ollama, and the first was mine.

#### The engine rows were empty, and how I checked is why

The panel showed Cline's own two numbers and nothing from Ollama. The cause:
`streamText`'s `finish` part carries `finishReason`, `rawFinishReason` and
`totalUsage` — and no `providerMetadata`. That rides `finish-step`. Reading it
off `finish` produced `undefined` for every streamed request, and nothing said
so, because the field is optional: an empty one is indistinguishable from a
provider that reports nothing.

4.100.64 was verified live against a real Ollama server — by calling
`doStream` directly, one layer below `streamText`, where the raw model *does*
put metadata on its finish part. The check passed while the shipped path was
always empty. The regression test now drives the layer that broke, and fails
without the fix.

#### Both throughputs, because they are two different numbers

Prefill and generation are separate rates, and a single "tok/s" hides which of
them moved between two runs:

```
17.2s · 96.5 tok/s prefill · 48.3 tok/s gen · 13.8s to first token · Ollama
```

Expanded, the split is there in full — model load, prompt tokens/time/rate,
cached prefix, generated tokens/time/rate, draft acceptance.

A provider that reports no engine timings now gets a generation rate too, from
the output tokens it did report over the span measured after the first token.
It is marked `gen*` and labelled as derived, because it is two reported
quantities divided rather than the engine's own count of decode steps — with
speculative decoding those are different numbers.

Measured end to end through the gateway on ollama 0.33.3-thinkbudget: engine
total 17211ms against Cline's 17231ms. That 20ms is admission, and showing both
clocks is the only way it is visible.

#### "Let me propose a check" is not an answer to the nudge

A run ended *Completed* with the file untouched and no check ever proposed. The
model wrote "I see several bugs … Let me propose a check, then fix them",
called nothing, was nudged, wrote another sentence of the same kind, and the
run stopped. Six messages, no edit.

The nudge budget is one, and the reasoning for it holds: the nudge asks a
question with two branches — keep working, or say you are finished — and a
model that answers "the task is fully complete" has answered it. Sending that
model the same text again was measured to change nothing.

But a model that answers by announcing *more* work has not answered. It has
restated the plan, which is the exact behaviour the nudge exists to catch, and
the counter cannot tell the two apart because it counts turns rather than what
they said.

There is now one further nudge, and it is not the same message again: it quotes
the model its own sentence and names the gap between saying and calling. Once
per run, never for a model that claims completion, and never at all where the
host has switched nudging off — that host has said a silent turn ends the run,
and this must not be a second door into the same room.

## [4.100.64] — 2026-09-05

What a request cost in time, under the request — asked for on #64 against a
screenshot of Open WebUI's per-message panel.

#### Two clocks, and the gap between them is the point

Every request now carries its timings, from two independent sources:

- **Measured by Cline** — total wall time and time to first token. Every
  provider has these, hosted ones included.
- **Reported by the engine** — Ollama's model load time and its
  prompt-eval/eval split; llama.cpp's equivalent, plus the prefix it served
  from KV cache and its speculative-decoding acceptance when a draft model is
  attached.

Keeping both is deliberate. A request whose measured total far exceeds the
engine's own total spent the difference queueing, and one whose prompt time
dwarfs its generation time is re-reading a prompt the cache should have held.
Neither question can be asked of a single number. Where an engine reports
nothing, those rows are absent rather than derived from the wall clock: a
prompt/generation split invented from a total would be a guess printed as a
measurement.

Collapsed it is one line under the request:

```
17.3s · 77.1 tok/s · 1.20s to first token · Ollama
```

Expanded, the whole of what was reported — Cline's total and first token, then
the engine's total, model load, prompt tokens/time/rate, cached prompt,
generated tokens/time/rate, and draft acceptance. `reasoning_tokens` is in
there too, where the provider separates it out.

Measured live against Ollama 0.33.2 and a llama.cpp server rather than only
against fixtures:

```
ollama     engineTotal 8990ms · load 4573ms · prompt 14 @ 3.2 tok/s · gen 11 @ 210.5 tok/s
llama.cpp  prompt 35 @ 100.1 tok/s · gen 7 @ 51.7 tok/s · cache_n 0
```

#### Why this was missing rather than merely unshown

Cline already recorded `tokensIn`/`tokensOut`/cache/cost per request. The row
read `cost` as a boolean meaning "the turn ended", showed none of the rest, and
was filtered out of the chat entirely unless the request errored — so the
totals in the task header were the only view, and a single slow request cannot
be seen in a sum.

The durations were not recorded at all. `ollama-ai-provider-v2` parses all six
timing fields into its own zod schemas and forwards only a response id, so the
patch this build already carries now keeps them. llama.cpp needed no patch —
its `timings` object arrives on the same response and only needed reading,
through the metadata extractor `@ai-sdk/openai-compatible` provides. That is
wired into the opencoti vendor and the generic OpenAI-compatible form alike, so
a llama.cpp server reached either way reports the same numbers.

`reasoning_tokens` had travelled as far as the SDK's usage normalizer and died
one layer short of the UI.

#### Off by default, from the provider panel

Under *Advanced* in the Ollama and OpenAI-compatible provider settings. One
switch shown in two places rather than one per provider: a chat where some
requests carry the line and others do not reads as a bug in the line, and the
measurements Cline makes itself are identical across providers.

The switch decides what is **displayed**, never what is recorded. Turning it on
shows the requests already made, not only the ones after; turning it off loses
nothing.

#### The CLI's unsubstituted messages

Three CLI errors printed their own source. `$getCliSubscriptionUrl()` and
`$resetTime` were written into template literals without their braces, so a
user who hit the ClinePass subscription wall was told to visit
`$getCliSubscriptionUrl()`, and one who hit the daily free-model limit was told
to `Try again in $resetTimeor select another model.` Both now say what they
meant to.

## [4.100.63] — 2026-09-04

Two reports from live use of 4.100.62, and what testing the second one
against the real server settled.

#### A check nobody has to watch, and a dialog that said otherwise

First live use of the check proposal. The model proposed exactly the right
thing:

```json
{ "kind": "page", "path": "manic_miner.html",
  "reason": "Loading the page in a browser will confirm no JavaScript
             parse/runtime errors and the game renders correctly." }
```

which Cline runs headless in its own process — no browser window, nobody
watching. The user declined it as manual work they would have to repeat every
attempt, and they were reading it correctly. The dialog opened with

```
Load and run `manic_miner.html`, and fail if it throws or never draws a frame.
Why: Loading the page in a browser will confirm …
This one runs inside Cline — nothing is installed and no shell command is used.
```

The first line is an instruction to whoever is reading it, the second is the
model's own sentence about browsers, and the one line that says who actually
runs it comes last.

**The dialog now leads with who runs it:**

```
Cline runs this itself after every attempt, start to finish. You are not asked
to test anything, now or later.

It loads `manic_miner.html` here in Cline — no browser window opens — runs its
scripts, and fails if the file does not parse, throws, or never draws a frame.

Cline's reason for choosing it: …
```

**The tool description now states the requirement it only implied.** The check
is the model's feedback loop, run unattended when its turn ends, and never
something a person performs — no "open it in a browser and see", no "confirm
the layout looks right". Its `reason` is to be written about the code rather
than about how someone would test it by hand.

**And there is a way to never be asked.** Approval is once per run, which for a
task run repeatedly is once too many every time. Writing

```
cline:page manic_miner.html
```

in Settings → Features → Change Protocol → check command names the same check
directly, with no proposal and no dialog. It is the same code path an approved
proposal takes.

#### Setting the OAuth client on a server that already exists

The client ID and secret were on the *Add Remote Server* form only, which helps
nobody: you find out your server refuses to register Cline by adding it and
watching it fail, and from there the only way to supply a client the provider
issued was hand-editing `cline_mcp_settings.json` — for a server sitting in the
list with a red error under it.

There is now an editor in the server row, under the error, where the failure
is. It clears any stale tokens and previously registered client in the same
atomic write, since those belong to the client being replaced and would fail in
a way that reads like the new one is wrong. A stored secret is never rendered
back into the field, and clearing the ID returns the server to dynamic
registration so a wrong paste is not permanent.

**Why this is the fix rather than a workaround.** Figma's server — the one this
was reported on — advertises a registration endpoint and refuses every
anonymous registration. Measured against it directly:

| request | result |
| --- | --- |
| our exact body, `token_endpoint_auth_method: "none"` | 403 `Forbidden` |
| `client_secret_basic`, which it advertises | 403 |
| minimal body / https redirect / added `scope` | 403 |
| `client_name` of "Visual Studio Code", "Claude", "Cursor" | 403 |
| with an initial access token, and with `X-Figma-Token` | 403 |
| browser User-Agent and `Origin` | 403 |
| a wrong path under the same prefix | clean JSON 404 |
| `OPTIONS` | 200 |

The route exists and declines everyone. The body is nine bytes — `Forbidden` —
sent as `application/json`, which is exactly the `JSON.parse` SyntaxError in
the report. Dynamic registration is not going to start working there, so a
client you register in Figma's own developer settings is not a workaround: it
is the only way that server is ever reached. The refusal message now names the
button instead of the settings file.

## [4.100.62] — 2026-09-04

Two fixes reported from live runs, and the feature both of them argue for.

#### A console that said nothing is not a page that worked

A run on 4.100.61 ended:

> Task is finished — the game HTML file loads with zero JavaScript errors and
> a clean linter check.

It did not. The next run opened the same file 22 seconds later and read it
back broken; the file does not parse — `missing ) after argument list` — and
the run's own last edit is what broke it, closing an arrow function with `}};`
and putting `});` on the line below.

Two checks stood between that edit and the claim, and **both came back clean**:

```
open: file:///C:/.../manic_miner.html
Console: nothing. The page printed no messages and threw no errors.

c:\...\manic_miner.html: no problems reported by the editor.
```

The model was not lying. It was reporting what it was told.

The `browser` tool's own description says a page that printed nothing is a
pass, and for a page whose scripts never ran that is exactly backwards:
silence and success are indistinguishable from the console alone. So for a
local file the silence is now checked against the file. A real parser is asked
whether the scripts parse, and when they do not the tool says so and appends
the delimiter scan that names the line:

```
Console: nothing. The page printed no messages and threw no errors.

That silence is not a pass: manic_miner.html does not parse — SyntaxError:
missing ) after argument list. The script never ran, which is why there was
nothing to print. Fix the file and open it again: silence only counts once
the page parses.

Delimiter scan — 4 line(s) do not balance:
  line 90: counting only code, this line has 1 more `}` than `{` …
```

A parser refusing the source is the only thing allowed to contradict a clean
page; the heuristic delimiter scan stays where it was, placing an error
someone else found.

`BrowserSession` also swallowed navigation timeouts outright. That is right
for a page that polls and never reaches networkidle2, and wrong when it is the
only thing that happened: the result was an empty console reported as a pass
over a page that may not have loaded at all. It is now logged when nothing
else was captured.

#### A closing sentence is a declaration, nudged or not

A regression shipped in 4.100.61. A run ended:

```
Task is finished — the game HTML file loads with zero JavaScript errors and a
clean linter check.
TX-01 kept but UNVERIFIED — the run was cut short before you said whether the
change worked, and nothing here could check it.
```

The model said whether the change worked in the sentence immediately above the
line claiming it had not.

`readSelfReport` looks only for *doubt*, deliberately: a model that ends a run
is already asserting it is done, so what is worth finding is the sentence where
it says it is not sure. A confident closing line therefore comes back
`undefined`, exactly as silence does, and .61 read those two the same way.
Worse, the nudge that produced the stop asks for that very sentence — *"If the
task really is finished, say so in one short sentence."*

Declared now means the model said anything at all. `forced` is left to do the
one job it was added for: colouring the wording when there is genuinely nothing
to report.

#### The model proposes the check, and you approve it

The change protocol judges every attempt by running something. Where a
workspace holds nothing runnable — one HTML file, a script, a game — there is
nothing to judge with, `auto` stood down, and the verdict fell back to the
model's own account of its work. That fallback is where every wrong verdict so
far has come from, including both of the ones above.

The model is nonetheless the one party that has read the code and knows what
would demonstrate the fix. So it proposes and you decide.

**A check Cline runs itself.** Every oracle until now was a command, and a
command only judges anything where one is installed — which is exactly what
these workspaces do not have. `kind: "page"` builds a stub DOM, runs every
`<script>` and pumps animation frames, and fails a page that does not parse,
throws, or never draws. Nothing to install, so it always works.

**Through a typed tool**, `propose_check`, never by reading the closing
message.

**Approval is a boundary, not a formality.** An approved command is then run
repeatedly and unattended as the judge, so the dialog is modal, shows the exact
text, names a shell line as one, and never falls under auto-approve. Declining
takes what you want instead and hands it back. Two declined rounds and the
protocol moves on rather than negotiating.

**Frozen once taken on.** A model free to re-propose after a failed transaction
will weaken the check until one passes, which is self-declaration with a
ceremony around it.

**And it has to fail before it can pass.** An approved check is tried against
the files as the transaction found them:

- it already passed there → refused, it cannot tell a fix from no fix
- it could not be run at all → refused, and named as that rather than as a
  failure, because "pytest is not installed" and "pytest found a problem"
  arrive looking identical and only one is the check working
- it ran and reported a problem → taken on

That last rule is what makes a model-proposed exam worth anything: failing
before and passing after is the definition of a regression test.

A host with no user — cron, CLI automation — supplies no approver and gets
exactly the previous behaviour.

#### MCP: a failed OAuth handshake is a server asking to be authenticated

Second half of the fix from 4.100.60, reported again on .61 with no popup
appearing. The registration-refusal detection was on the *authenticate* path
only; connecting to a server — enabling it, or a reconnect — went through
`connectToServer`, which turned any failure into `Failed to update server
state:` and never offered sign-in.

The fetch the transport uses is now watched on both paths, so a handshake that
fails is reported as the server asking to be authenticated, with the endpoint
and status named:

```
MCP server "figma" refused to register Cline as an OAuth client (HTTP 403 from
https://…/register). This server only accepts clients it issued itself, so no
credentials were sent. Add an "oauthClient" entry with the client ID the server
gave you …
```

## [4.100.61] — 2026-09-04

One report, from a .59 run, and it turned out to be worse than the wording it
was reported as.

#### Silence is not a verdict, and a forced stop is not a completion

A session ended `TX-01 kept — self-declared, nothing here could check it`, and
the model had declared nothing anywhere in the transcript. It had not. Running
the file it left behind:

```
{"ok":false,"error":"SyntaxError: Unexpected token ')'","frames_run":0}
```

A transaction was kept, and reported as declared, over code that does not run.

Two faults, compounding.

**The run did not end because the model was done.** It never called a
completion tool at all — the whole session is `read_files`, `editor` and
`check_file`. Its last two turns produced thinking and no tool call, so the
no-tool-call nudge fired, was spent, and the loop fell straight through to the
completion boundary, which reads that as *"the model believes it is done,
which is exactly when its belief is worth checking"*. It is not. It is the
runtime giving up on a model that was still working: the final turn is 13,492
characters of counting braces and losing its place. The boundary now knows the
difference, because the runtime tells it — a stop that happened with the nudges
already spent is marked as forced.

**Then silence was reported as a judgement.** A change nobody could check and
nobody spoke about is still *kept*, and that has not changed: discarding real
work over a sentence the model forgot to write is the failure a host-owned
boundary exists to avoid. But the verdict was labelled `self-declared`, which
asserts a claim that was never made, and sends whoever reads it hunting the
transcript for a sentence that is not there. The code had the honest version
all along — it computed an evidence line saying the change "was never stated
to work or not" — and threw it away before writing the message.

There is a third verdict source now. `undeclared` says what happened:

> TX-01 kept but UNVERIFIED — the run was cut short before you said whether the
> change worked, and nothing here could check it. The changes are on disk;
> check them before relying on them.

or, where the run ended normally and the model simply never said:

> TX-01 kept but UNVERIFIED — nothing here could check the change and it was
> never stated to work. The changes are on disk; check them before relying on
> them.

The source rides the settled event and its `atomic_transaction` metadata as
well as the message, because anything counting kept transactions as successes
could not previously tell "the check passed" from "nothing checked and nobody
said" — both arrive as `kept: true`.

Four tests, each of which fails on the old code: the runtime reports a forced
stop as forced and a clean finish as not, an unspoken verdict is `undeclared`
rather than `self-declared`, and a forced stop says it was cut short while
leaving every changed file exactly where it is.

Worth saying plainly what this does **not** affect: a workspace that has
something to run is judged by running it, and none of this path executes there.
It is the case where nothing can be run — which, in an editor, is most of them.

## [4.100.60] — 2026-09-04

One report, from testing .59: a subagent was still pointed at a provider
profile that had been deleted, and the only sign of it was the delegation
failing partway through a task.

#### A profile that was deleted should not be found out mid-task

Nothing rewrites an agent file when a profile is removed in Settings, so the
agent goes on naming something that resolves to nothing. It was already refused
rather than quietly run on the session's model — that part was right, and it is
the failure this fork fixed once before — but the refusal arrived at the first
call, which is well into a task, and it read as the subagent being broken
rather than as configuration that had gone stale months after it was written.

The Agents list had been the worst of it. A dangling profile left the "Runs on"
picker rendering **blank**, which looks exactly like "runs on the session's own
model". An agent that was going to fail was displayed as one of the healthy
ones, and there was nothing in the picker to replace.

Four things say it now, in the order a user meets them.

The list marks it: `Workspace · vision-box (missing)`. Opening the agent offers
the dead name as an item of its own, so there is something to replace, and says
plainly that the agent fails when it is called. Choosing another profile and
saving rewrites the file.

The session says it at load, once the agent files have been read and before
anything can delegate, naming the agent, the profile and the profiles that do
exist.

A notification offers to fix it, and fixes it. As the session is built, the
agent files are checked against the saved profiles; anything broken produces a
notice with a button, the button lists the profiles that exist plus the
session's own model, and the choice is written to the agent file. Nothing to
open and nothing to hand-edit.

And the refusal itself, if it still gets that far, now lists the profiles you
could pick instead of only naming the one that is gone. "Cannot resolve X"
answers what went wrong, not what to do about it, which is the question the
user is actually left holding.

Three things the notification deliberately does not do. It does not block a
session: the check is not awaited, and a failure to read the agent directory is
logged and dropped, because a session has to start either way. It does not ask
twice — an offer is remembered per agent-and-dead-profile, so a decline stays
declined until the file names a different missing one. And past six saved
profiles it stops offering buttons and opens the file instead, because a modal
whose buttons are the profiles stops being readable somewhere around there.

## [4.100.59] — 2026-09-04

A regression in .58 that I caused, and the half of mann1x/cline#63 that .58
left undone.

#### Every tool call failed, and the model was right about why

Reported on .58: `AI_NoSuchToolError: Model tried to call unavailable tool
'list_files'. No tools are available.` — on every call, while the system
prompt went on describing `read_files`, `editor`, `search_codebase` and the
rest. The reporter's transcript shows the model trying name after name and
concluding the environment was broken. It was.

"No tools are available" is not "the tool set was empty". It is the AI SDK's
wording for **no tool set at all** — the argument absent at the call, rather
than present and short. An empty set would have printed the list. So nothing
had been built, and the prompt describing tools that were never sent is what
made it read as a model failure.

.58 picked up an upstream gate that empties the tool set when a model's
capability list says it cannot call tools. That is right on its own. What it
collides with is that a capability list counts as *unspecified* only while it
is empty: the moment anything writes one, every capability left out of it
reads as an authoritative "cannot".

Something here writes one. For Ollama I ask the server whether the model reads
images rather than guessing, because the catalog has never heard of a local
model — that is what stopped screenshots reaching models that cannot see. For
a vision-capable model, that block produced a capability list of exactly

```
["images"]
```

a list saying nothing about tools, which after .58 means *cannot call tools*.
The tool set was emptied before the first turn. Before .58 nothing read the
list that way, so it had been wrong and harmless for as long as it existed;
the new gate made it fatal. That is why .56 is clean and .58 is not.

Ollama answers the tools question in the same `/api/show` response that was
already being fetched and cached, so it is read now instead of left out, and a
list written without an answer keeps `tools` — the fail-open default every
other capability check in this codebase already applies. A server that
positively reports no tool support is still believed.

The regression test fails on the old code with the reported symptom exactly:
`expected [ 'images' ] to deeply equal ArrayContaining ["images", "tools"]`.

Upstream had already guarded this same class of bug in two other places that
project capability lists from legacy booleans. This block bypassed both.

#### The auth-mode selector .58 said was missing

.58's notes ended by saying the settings form still offered no way to declare a
pre-registered OAuth client, that you had to write it into the config file
yourself, and that the half was worth doing. It is done.

*Add Remote Server* now asks how to authenticate: **Automatic**, which
registers Cline with the server and is unchanged and still the default, or
**Use an OAuth client I already have**, with client id and secret fields. That
second one exists for the servers that will not register anyone — GitHub, Slack
and Entra publish no registration endpoint at all, and Figma advertises one that
answers 403 to any client outside its allowlist. The secret is written to the
MCP settings file, and `${env:VAR}` is expanded there if you would rather it
were not.

There was a second bug underneath. The extension's connection-time OAuth
provider read the client only from the persisted `oauth` state — which the SDK
writes only after a *dynamic* registration. With a pre-registered client
nothing ever writes that block, so on every connection before the first
interactive authorize the answer was "no client", and the SDK fell back to
registering. A configured client was therefore invisible on exactly the path it
existed for. It now reads the configured client, which is what the CLI already
did.

#### A 403 that named the wrong thing

The same report carried `HTTP 403: Invalid OAuth error response: SyntaxError:
JSON Parse error: Unexpected identifier "Forbidden". Raw body: Forbidden`, and
the obvious reading — bad credentials — was wrong.

I built a mock MCP server with a full OAuth 2.1 authorization server behind it
and drove the shipped client against it headlessly, to read what actually goes
on the wire. The flow stops at step four of fifteen: discovery, discovery,
then the registration POST, refused. `/authorize` is never reached, `/token` is
never reached, and no credential is ever put in a request. The message was
accurate about the status code and misleading about everything else.

A refused registration now says what it is, and what to do about it, instead of
surfacing a body it could not parse. Two tests drive the real flow against a
local OAuth server, because both halves are only visible on the wire: that a
configured confidential client authenticates with `client_secret_basic` and
never touches `/register`, and that a refusing server is reported as refusing
registration.

#### Also

`hub-upgrades.test.ts` imported a type at the top and then wrote the same type
inline at its only use, leaving the import unread and the core package's
typecheck failing on it. It uses the import now.

## [4.100.58] — 2026-09-04

This one is mostly not mine. It is the fork caught up to upstream — 368
commits of it — plus the MCP fix that prompted the release and one guard
that had been quietly lying to the model.

#### A pre-registered OAuth client can reach the server now

mann1x/cline#63. MCP over OAuth worked here only if the server offered
dynamic client registration. If you had been given a client id and secret
out of band — which is the normal arrangement with anything corporate —
there was nowhere for them to go: the connection path never read a stored
client, and the interactive reset wiped one if you hand-edited it into the
config. The report was not "OAuth is broken", it was "OAuth is broken for
everyone who was issued credentials", which is a different and smaller
thing to fix.

A stored client now reaches the transport. Upstream had found the same
runtime path independently and built more on top of it — client binding
per SEP-2352 — so that implementation is the one that ships, with the
client-level test written for this fork kept, since upstream has no
coverage of that path at all.

What is *not* here: the settings form still offers no auth-mode selector.
A pre-registered client works, but you write it into the config file
yourself. That half is worth doing and has not been done.

#### The delimiter scan says what it does

`check_file` reports an unclosed bracket by naming the line to edit and
how many brackets that line is out by, and it proposes the exact `editor`
call. Its own description still said it "names the *opening* bracket" and
told the model the opener "is the one you have to edit" — which is the
opposite of what the scan now recommends, since the proposed edit is
usually on the closer. Two tests had been red on that mismatch, and
`default.md` shipped the stale copy verbatim. The tool, the template and
the fixture now agree.

#### Everything upstream did since early August

The rest is the merge. What a session actually notices: web search where
the provider supports it, workspace metadata reaching the system prompt on
the Cline provider, region guidance when Vertex rejects a model on the
global endpoint, hook context that no longer renders as a user bubble, and
a turn aborted for a plan/act switch that now settles into Resume Task
instead of leaving a spinner or dead approval buttons.

Four things this fork kept rather than take upstream's newer version, each
because a feature here depends on it: per-tool MCP auto-approval (the
toggle is the gate, the per-tool flag is the grant), model-initiated
plan→act switching (the prompt templates ship the tool's description
verbatim), the ollama and llama.cpp reasoning path, and the recoverable
error still arriving in the transcript rather than only the log.

This is also the first build cut from a branch that holds all of it. Every
other branch in the fork was checked by content rather than by commit id,
and the one that still carried work of its own was merged in first.

Core 3054 tests, llms 935, agents 125, extension 1104 bun and 1478 vitest,
every typecheck clean.

## [4.100.56] — 2026-08-27

One change, and a second one that only makes the first legible.

#### A name the provider mis-sliced is still a name

A provider that mis-slices the model's output can hand over the whole
turn as the tool name. Measured: a tool name roughly two thousand
characters long, made of a code block the model had just written, then
a sentence of prose — *Let me re-read the current state of modifySkill
and the rest:* — then `<tool_call>`, then `read_files`. A real tool,
called with well-formed arguments, and the turn was failed over it with
`Model tried to call unavailable tool`.

The name the model wrote is the part after the marker. It is now taken
from there, under two conditions that are the whole of the safety: the
tail has to be a bare identifier naming a tool this run actually has,
and the arguments have to parse as JSON. A mangled name *and*
unparseable arguments means nothing about the call is understood, and
two guesses do not make an answer.

This is deliberately not the argument repair that sits beside it. That
one invents content — closing a truncated string produces a *valid*
call carrying a fragment, and nothing downstream can tell that from a
value the model meant, which is how a whole-file write once replaced
14,127 bytes with 572 ending mid-rule. It refuses a payload cut off
inside a value, and it still does. This changes no value at all. It
moves a name out of text that was wrongly prepended to it, and if the
name is not there, the call still fails.

#### Diagnostics stop reproducing the transcript

The mis-sliced name went into the recoverable-error metadata three
times over, which is why the report that prompted this was a wall of
the reporter's own source code. A tool name that is two thousand
characters long is not a name, it is the turn. Tool name and provider
message are now bounded in that metadata, with the original length
stated so nothing is quietly lost, and the conversation itself remains
where a reader goes for the rest.

Seven tests: the name found after the marker, a tail that is not a tool
this run has, a name with no marker in it at all, a tail that is not a
bare identifier, the call recovered with its arguments untouched,
arguments that do not parse refused, and a tool this run does not have
refused. The llms package's 661 tests and core's 2421 are green, both
typechecks clean.

## [4.100.55] — 2026-08-27

One change, and the number in the error that prompted it was ours.

#### A cap we invented is not a reason to refuse the request

A model that publishes no output ceiling gets one synthesized from the
share of its window that the agent reserves for output: 32,000 per
128,000, which is a quarter. That share exists because a flat cap is
wrong at both ends — 32,000 is the whole window on a 32k model and an
eighth of it on a 262k one — and it has been the right answer everywhere
it has been measured.

It is the right answer because a local model's `num_predict` is a
generation limit with nothing above it. A hosted model validates the
number instead. At a 1,048,576-token window the quarter is 262,144, and
the model behind it accepts 131,072, so the request was refused before
it started — and refused again on every retry, because nothing about
the arithmetic changes between attempts. A whole session's worth of
work, unreachable, over a figure the user never set and could not find
anywhere in their settings.

The refusal carries the number the guess should have been. It is now
read out of the message, the request is retried once at that ceiling,
and the ceiling is remembered for the rest of the session. A model the
catalog does not know costs one round trip rather than the task.

Three things it deliberately does not do. It does not rewrite a cap the
caller asked for: that is a setting, and sending a different number
quietly would hide the field they have to change. It does not record
the ceiling as one the model publishes, which would send the default
back to the flat 32,000 and hold a model that had just said it accepts
131,072 to a quarter of that — it is a clamp, and the share still sets
the number. And it does not persist, because relearning costs one
request and a stale ceiling would outlive the model revision that set
it.

The retry only works because the stream is primed first, and that is
worth stating because the obvious version of this change does nothing
at all. Providers return an async generator: the request and the error
it raises both happen on the first `next()`, so a `try` around the call
that creates the stream catches an empty hand. One event is pulled
before the stream reaches the caller. That is also what makes re-issuing
safe — nothing has been delivered, so the second attempt cannot repeat
output anyone has already seen.

Five tests: the three refusal wordings it reads, a refusal naming no
ceiling left untouched, the retry, the ceiling reused on the next turn
without a second round trip, and an explicit cap left as the caller set
it. The llms package's 654 tests and core's 2421 are green, both
typechecks clean.

## [4.100.54] — 2026-08-25

One change, from a measurement rather than a report: the change protocol would
let a model spend every transaction it had left without editing anything.

#### A transaction with nothing in it is not an attempt

Run 0028 of the current harness campaign closed five transactions in about nine
minutes. TX-01 was a real attempt — 61 iterations, 62 commands, 10 edits, an
hour of work — and the check turned it down. TX-02 through TX-06 were three
iterations, one iteration, one iteration, one iteration, one iteration, with no
tool call at all between them. Each was judged, each failed, each rolled a file
back that had never been touched. The run ended `broken` with the work file
byte-identical to the file it started from, and it reads in every log as six
failed attempts. It was one.

The boundary already knew how to recognise an empty submission — it checks
whether the workspace is untouched — but only before the first transaction has
settled, where an untouched attempt means something else entirely: answering a
question about the code is a legitimate way for a run to end, and running a
typecheck to confirm nobody edited anything is a cost with no verdict in it.

After a transaction has been judged, the same signal means the opposite. The
model has stopped working, and settling that spends a transaction on nothing.

So it is not settled any more. Nothing is judged, nothing is rolled back, the
transaction stays open, and the model is told what it did: the submission was
empty, it cost nothing, and if it has run out of ideas then saying so and
stopping is worth more than another empty transaction. The budget is now spent
only on attempts that contained an attempt.

That nudge is bounded, for the same reason the no-tool-call nudge is: asking a
model that has stopped to carry on is worth one turn, and asking a third time
is a spin with the run's wall clock attached. A second empty submission in the
same transaction ends the run instead. A real change in between resets the
count, so a model that recovers does not start its next transaction a strike
down.

The empty submission appears in the transcript as its own notice rather than as
a verdict, because it is not one — no check ran and no file was put back. A
transaction that absorbed one and a transaction that never happened would
otherwise look identical.

Three tests cover it: the transaction is not spent and the check is never run,
the second empty submission ends the run with four transactions still unspent,
and a real change restores the full budget. The core package's 2421 tests and
its typecheck are green.

## [4.100.53] — 2026-08-18

Two reports from testing 4.100.52, and they turn out to be the same complaint
twice: something gets created, and then it is not there.

#### Agents written in the tab are read again

The Agents tab writes `.md`. The loader that reads agent files accepted `.yml`
and `.yaml` and nothing else — so an agent saved in the UI was invisible to the
tab that saved it, and to the runtime that was supposed to offer it. There was
no error, because an extension the reader does not recognise is not an error:
it is skipped. The result was a form that appeared to work and produced
nothing.

`.md` is the format — markdown with YAML frontmatter — and it is what the tab
writes, what `.cline/agents/*.md` means everywhere it is written down, and what
every previous note about this feature described. `.markdown` is accepted too.
Both YAML extensions still work, so a file already written under one keeps
working.

Worth saying plainly: this means the configured-agent feature has not worked
for anyone following the documented format, tab or no tab. If you wrote an
agent file by hand at any point and concluded subagents were broken, that file
should load now.

The loader's tests never wrote a file to disk — they called the parser with a
string, which was always fine. Three tests now put real files in a real
directory, which is the only way this particular gap is visible.

#### Terminals that get abandoned get closed

A terminal Cline cannot prepare for a command was dropped from its registry and
left open. Nothing could reuse it after that — it was out of the registry — and
nothing would ever close it.

That stays invisible as long as the working directory can be confirmed, because
then the terminal is reused and never abandoned. It needs shell integration: the
confirmation reads `shellIntegration.cwd`, and where a shell does not provide it
the check can never pass. Preparation then fails on every acquisition, so the
session opens a new terminal for each command and leaks every one of them.

Abandoned terminals now go on the registry's existing cleanup queue and are
disposed at the next terminal acquisition. Deliberately at the next one rather
than immediately: disposal fires close listeners, which can ask for a terminal,
and that must not re-enter the acquisition that queued it. It also means the
last command's output stays readable until something actually needs a terminal.

Only terminals that received nothing but Cline's own `cd`. A terminal running a
command Cline no longer observes — a markerless stream, an SSH session — is
still left alone, because it may be yours. Four existing tests cover that and
still pass.

If your shell does have integration, none of this changes anything: terminals
were already being reused and still are.

#### Also

CLI quick setup (`cline auth --provider … --modelid …`) demanded an API key from
every provider and allowed `--baseurl` for two named ones. Both questions are
answered by the provider registry, and the hardcoded answers disagreed with it
about Ollama, which has no API key and does take a base URL — and is the
provider most likely of all of them to be running on another machine. It now
asks the registry.

---

16 terminal-manager tests, 96 in the team suite, 164 in orchestration, 9 in CLI
auth, 1077 in the extension unit suite. `check-types` clean.

## [4.100.52] — 2026-08-18

#### New in this build

**Subagents can be written from the UI.** Customize (the scales icon by the chat
box) → **Agents**.

Until now an agent was a markdown file with YAML frontmatter and nothing
anywhere that wrote one, so the format was discoverable only by reading the
source. The tab is a full form: a name, when to use it, the profile it runs on,
which tools it may have, its prompt, and whether it belongs to this workspace or
every workspace. Save writes the file.

**Files stay the artifact.** This writes `<workspace>/.cline/agents/*.md` and
`~/.cline/agents/*.md` — the same two directories the runtime reads and the CLI
reads. An agent authored in the UI is one the CLI sees, and a hand-written file
opens in the form. Nothing moved into extension state.

Three things worth knowing about the form:

- **It starts from a worked example.** Reviewer, Researcher, Test writer, or
  Empty. The hard part of writing an agent is not the fields, it is knowing what
  a usable "when to use it" sounds like: that sentence is the only thing read
  when the model decides whether to hand work over, and a vague one produces an
  agent that is never chosen.
- **The tool picker comes from the runtime's own list**, so it cannot drift from
  what is actually offered. Leave everything unchecked and the agent gets the
  session's full set. `spawn_agent` and `submit_and_exit` are not on it: the
  first is how a sub-agent hangs a one-slot endpoint, the second is how it
  returns.
- **"Runs on" is a profile**, which carries the provider, the model and the
  context window together. It is also the answer to running an agent on a
  different provider than the session — and unlike the open-ended `spawn_agent`,
  agents defined this way are offered whatever the profile's parallel-sessions
  count is.

Remember the two switches around it: **Subagents** must be on in Settings →
Features → Agent (v4.100.50 put that toggle back), and the change takes effect
on the next task, not the one already running.

## [4.100.51] — 2026-08-17

#### New in this build

**Subagent loading says what it found, and where it looked.**

Follow-on from #55. Turning Subagents on with no agent file written produces no
tool and no error, because nothing is wrong — there is simply nothing to offer.
The loader logged only failures, so the feature was silent in exactly the case
where someone is asking why nothing happens.

The Cline output channel now carries one line either way:

```
[agents] 2 configured agent(s): reviewer, researcher
```

or, when the directories are empty:

```
[agents] No configured agents found. Looked in: /work/.cline/agents, /home/you/.cline/agents
```

Together with the two lines already there, that is the whole picture of what a
session resolved:

```
[Agents] Subagents enabled
[Agents] Concurrency: 1 — no parallel-session count configured; assuming 1
```

Nothing else changed. v4.100.50 remains the build that put the Subagents toggle
back in Settings → Features → Agent; this one only makes the result legible.

## [4.100.50] — 2026-08-17

#### New in this build

**The Subagents toggle is back in Settings → Features → Agent.**

Reported in #55: the model never delegates anything, on any model. It could
not. Upstream commit `c3671de7d` ("fix(vscode): disable subagents") deleted the
toggle's row from the settings section and hardcoded `enableSpawnAgent: false`
in the session factory. The factory was later taught to read `subagentsEnabled`
again — but the row was never put back, so the setting resolved to its `?? false`
default with no control anywhere in the UI that could change it. Every piece of
the machinery was present and shipping: agent files in `.cline/agents`, a tool
per agent, a delegated-agent connection, a slot gate. The model was offered none
of it.

The row's description says what the toggle alone buys, because it is not all of
it. Agents you define in `.cline/agents` are offered the moment subagents are
on. The open-ended `spawn_agent` and the team tools are additionally withheld
when the profile's parallel sessions is 1 — an endpoint that serves one request
at a time would run a delegated agent *after* the agent that spawned it rather
than beside it, so offering the tool would only cost turns. That is deliberate,
and until now the only place it was said out loud was a line in the extension
log. Raise the profile's parallel sessions above 1 to get those two as well.

Two lines in the Cline output channel report what a session resolved:

```
[Agents] Subagents enabled
[Agents] Concurrency: 1 — no parallel-session count configured; assuming 1
```

Also in this build: `read_files` resolves a relative path against the workspace
rather than the extension host's working directory (v4.100.49), and the
duplicating-refusal loop guard reports rather than advises when it stops a run
(v4.100.48).

## [4.100.49] — 2026-08-17

One fix, in a path every tool result flows through.

### `read_files` resolved a relative path against the wrong directory

It resolved against `process.cwd()` — the directory the *process* was started in. That is the workspace only when the agent was launched from the folder it is working in, and neither host does that: the extension host's working directory is wherever VS Code itself was started, and the CLI takes its workspace as `--cwd` while running from wherever the shell was. The editor never had this bug; it takes a workspace and resolves against it.

Nothing goes wrong until a model sends a bare filename instead of a full path — and then everything downstream of the read goes wrong at once. Measured on a harness run started one directory above its workspace:

```
56 × ENOENT  …/manic-harness/manic_miner.html     ← the parent of the workspace
32 × read_files input: "manic_miner.html"
19 × edit refused: the file had never been read
 6 × the loop guard stopping the run
```

Three hours, four applied edits, no transaction ever settled. The read-before-edit guard was doing its job on reads that could not succeed, and the loop guard was doing its job on a call that could not change — both correct, both downstream of one wrong base directory.

Five earlier runs on the same harness never saw it, for a single reason: that model always sent absolute paths, 43 of its 45 reads fully qualified. A model's habits decided whether the bug existed.

The workspace is now threaded in where both it and the reader are known, so the CLI and the extension both get it. An explicit `fileRead.cwd` still wins for an embedder pointing the reader elsewhere, and with nothing supplied it falls back to `process.cwd()` exactly as before — a standalone executor behaves as it always did, and the tests say so in both directions.

Verified live rather than only in tests: the same bare `manic_miner.html` that failed 56 times now resolves on the first read of a fresh run.

### Install

`code --install-extension cline-mann1x-4.100.49.vsix --force`, then reload the window. Installing is inert until the window reloads.

## [4.100.48] — 2026-08-17

Two builds' worth of one thing: a model that repeats a call the tool has already answered, and what it costs before anything stops it. All of it measured on a live session under the change protocol, on a local 27B model.

### A refusal now counts itself

The editor's refusals already explained themselves at length — the text is character-for-character what the file holds, here are the lines quoted back, sending it again cannot help. Measured anyway: the identical call to line 90 three times running before the model varied a character and the edit landed, and later the same 4,991-character whole-class replacement at line 84 **seven times in a row**.

Prose about what the tool will do next time is a prediction, and a model that has decided the change is still missing discounts it. A count of what it has already done is a fact:

> You have now sent this identical edit 3 times and it has been refused 3 times for the same reason, so nothing about the file, the tool or this call is going to change on the next one. Either the change you meant is already in the file — in which case it is done, and the next thing to do is the next change or the answer — or the text you want is somewhere else in the file, and only re-reading around it will find it.

Both refusals carry it: the no-op, and the replacement that would append a second copy instead of replacing. The ledger is per session, so the count is this task's history rather than the process's, and two tasks editing the same file are not one model repeating itself.

### The stop comes sooner, and stops advising

The loop guard routes a call onto a short ladder when the tool has *answered it in advance* — a refusal reached by comparing the payload against the file, which cannot come out differently for identical arguments. The duplicating refusal was missing from that class, so it took the ordinary six-strike ladder. That is the whole reason the run above spent seven attempts on one call.

And six is too many for that class. The advice is three distinct moves — look at what is there, address it differently, leave it and work on something else — and once they have all been read, further strikes buy more of the same call. The budget is now the advice: **three warnings, then the stop on the fourth attempt**, so *"leave this alone now"* arrives with an attempt still left to act on it rather than as decoration on the stop.

The stop itself no longer advises. It used to end with "take the next thing that is still wrong and work on that", addressed to a model that has just been stopped, and reaching the person instead — under a red row offering Retry and Start New Task. It now reports:

> This exact call to `editor` was refused 4 times because the tool compared it against the file and answered it in advance. The arguments are unchanged, so the result cannot be either.
>
> The run is being stopped here. It was warned about this call three times and the same arguments came back, so further attempts would spend turns without changing anything. Retry to run it again as it stands, or send a message saying what to do differently.

The steering keeps its place in the warnings, where there are turns left to use it.

### Install

`code --install-extension cline-mann1x-4.100.48.vsix --force`, then reload the window. Installing is inert until the window reloads.

Supersedes v4.100.47, which carried only the first half.

## [4.100.46] — 2026-08-17

Sixty-one commits since v4.100.40. The headline is the change protocol, which is now a feature of the product rather than a harness around it; the rest is what running it against a local model taught, most of it in the editor.

### The change protocol, natively

Settings → Features → Change Protocol. Off, **Auto**, or **Always**, with two limits you set yourself — changes per attempt (3) and attempts per task (6) — and a check of your own if the workspace has one.

The model works in transactions. It declares at most N changes as WHERE/WHAT/WHY before it edits anything, makes exactly those, and at the end the attempt is judged: kept if the check passes, rolled back and reopened if it does not, with what was tried carried into the next attempt. The rules travel in the task's own message, restated in full each time a transaction opens — not referred back to.

`Auto` engages only where something in the workspace can actually be run to judge a change. Where nothing can, it stands down and **says so in the chat**, because a feature that silently does nothing is indistinguishable from one that is broken:

> Change protocol stood down: nothing in this workspace can be run to judge a change, and the mode is Auto. Name your own check in Settings → Features → Change Protocol, or set the mode to Always to have the model judge its own work.

`Always` engages anyway and is honest about what is judging — *"the model judges its own work, which is the weaker of the two and is labelled as such on every attempt."*

### What the editor was losing

Measured by replaying every editor call a local model made under the protocol. Four repairs, and a fifth in this build:

| what failed | what happens now |
| --- | --- |
| `\n` and `\t` arriving as literal backslash-n in `old_text` | decoded and retried, and adopted only if the decoded form actually occurs |
| `start_line` and `insert_line` both set, one edit meant | resolved where it is unambiguous, refused by name where it is not |
| `old_text` that nearly matches | the reply names the longest prefix that did match, the line it stops on, and what the file holds there instead |
| an edit refused because the read was retired by the model's own earlier edit | a file that has ever been read stays readable to a text-anchored edit |
| the same no-op edit sent again and again | the refusal now counts: *"You have now sent this identical edit 3 times…"* |

The last one is this build. The refusal already quoted the lines back and said resending could not help; measured live, the model sent the identical call to line 90 three times anyway, then varied a character and it landed — five of that session's seven editor calls spent on it. Prose about what the tool will do next is a prediction; a count of what it has already done is a fact.

Against the same task and model: the run before these repairs made 14 applied edits and six failed editor calls. The run after made **50 applied edits and none**.

### Chat and session fixes

- **Jump to present** no longer sits there while you are looking at the newest message. It was keyed on following alone, and following ends when you expand a row, not only when you scroll — a row that expands below the fold leaves the list where it was, so nothing resumed following and the button never left. It now needs both: you stopped following *and* the view is away from the bottom.
- **The session's title is your words.** A protocol-armed task stored the prepared prompt — rules and all — as the session's prompt, so the list showed the rules instead of the task.
- **The engagement notice reaches the chat.** Dispatched while the session was being created, it was dropped as a stale event one line before it would have become a row; it now goes out with the first turn.
- **A condensed think is announced once.** The note was re-announced on every later turn that still carried the capped think — three rows for one condensation, then two for the next.

### Install

`code --install-extension cline-mann1x-4.100.46.vsix --force`, then reload the window. Installing is inert until the window reloads.

## [4.100.40] — 2026-08-12

Two fixes, both from tester reports, and both cases of the interface teaching one thing and accepting another.

### `search_codebase` refused the name it uses itself (#52)

The tool accepted `queries` and nothing else. But every result it returns is `{ query, result, success }`, and its description says as much — *"`query` is the pattern you sent"*. So a model that has read one of its own search results learns the singular and sends it back:

```
FAIL {"query":"SpectatorSelectionCard"}                   -> ✖ Invalid input | Received: {"query":"SpectatorSelectionCard"}
FAIL {"query":"startPlayerDrag"}                          -> ✖ Invalid input | Received: {"query":"startPlayerDrag"}
FAIL {"query":"SpectatorSelectionCard","max_per_file":10} -> ✖ Invalid input | Received: {…}
```

A Zod union that matches no branch prettifies to a bare `✖ Invalid input` — no path, no field, nothing to correct. In the reported session the model sent the same shape three times, then gave up on the tool and fell back to a comma-joined single query, which is a different search. `read_files` next door already accepts `path`, `file_path`, `filePath`, `files`, `file_paths` and `paths`; this one had four branches and none of them singular.

`query` is now accepted as a string or an array, and every shape normalises to the same canonical input.

Writing that surfaced a quieter bug beside it. `{"queries": "x", "max_per_file": 10}` matched the bare `{queries: string}` branch, which strips unknown keys — the search ran at the default of one match per file while having been asked for ten, and nothing said the option had been dropped. Both tuning fields now ride along on every object shape.

The UI had the same gap from the other side: the webview read `queries` only, so a call carrying `query` rendered as `"" in codebase`, naming neither what was searched nor why it failed. It reads both.

### The jump button contradicted the view (#49)

The button added in 4.100.38 was keyed on Virtuoso's `isAtBottom`, which answers "is the list within ten pixels of the bottom this frame". That is a different question from "has the reader stopped following", and during a streaming turn the two come apart continuously: every appended token extends the list before the pin scroll catches up, the smooth scroll spends its whole animation in transit, and the flag starts `false` at mount before Virtuoso has reported anything at all.

None of those disable auto-scroll. Tailing was working the entire time — only the button thought otherwise, which is precisely the complaint: it appeared while the chat was following perfectly well.

Following is now tracked as the decision it is. It ends when you scroll up or jump to an older message, and resumes when you return to the bottom, press the button, or a new turn starts streaming.

The pixel flag has not gone anywhere — every pin path reads it synchronously mid-scroll, so it stays a ref. The two now move together through one pair of helpers rather than six scattered assignments. Four handlers outside that file still clear the ref directly on send, approve, resume and compact; rather than chase each one, the pin effect reconciles the pair whenever it finds the ref clear, so none of them can leave the button asserting you have scrolled away while the view tails.

### Verification

Seven input shapes for `search_codebase` are pinned by tests — singular and plural, string and array, bare string and bare array, and the options surviving on each object form. I checked they fail without the schema change rather than assuming: reverting it fails seven of them. The scroll change is covered by tests that it starts out following, that expanding a row stops it, and that the flag and the state never move apart.

Full suites green: 2,179 in `@cline/core`, 1,223 in the extension, 491 in the webview.

## [4.100.39] — 2026-08-11

Four changes, and three of them are the same finding: the CLI and the extension
were not running the same agent.

### Each subagent is now held to its own endpoint (#47)

`spawn_agent` was gated to the number of requests the server serves at once.
Configured agents — the ones read from `.cline/agents/*.md` — were not gated at
all, and they are the only ones that can name a connection of their own. Four
agents pointed at a one-slot Ollama were therefore spawned four-wide and queued
inside the server socket, which is the exact failure the gate was written to
prevent, while the gate's own comment claimed to cover every spawn path.

Putting them under the same gate would have been the wrong fix. Since 4.100.33
an agent may name a `providerId`, and since 4.100.37 a `profile:`, so one turn
can spread agents over a local server and a cloud one — and a single shared
bound would queue an Anthropic agent behind a local model it was never going
near.

So the bound is applied per endpoint. An endpoint is a provider and a base URL
together, because a provider id alone does not identify a server: two profiles
both naming `ollama` may point at a machine each. Agents on one endpoint queue
against that endpoint; agents on different ones run at the same time. The
number itself is unchanged and still the one measured for the session's
endpoint, since that is the only one this host has — which never
over-subscribes a server, and gives a second provider its own queue rather than
a share of somebody else's.

**So: yes, subagents on several providers do run in parallel now, and until this
build they did not.**

### The CLI kept no checklist

`taskProgress` was the one host contract field the CLI never set, and unset is
not "off with the same effect": the runtime reads it to decide whether to build
a tracker at all, and without one it skips the `task_progress` tool, the
checklist parameter that tool adds to every *other* tool, the reminder and the
close-out guard. The extension has defaulted it on for months. The CLI now does
too, with `--task-progress off` to turn it off and `--task-progress-interval`
for the cadence.

### `check_file` was a different tool in each host

The extension's reads the editor's language servers and tells the model "This is
the linter. It is also the type checker". The one the CLI got is a syntax and
bracket check whose description says outright that it is neither. Both are
honest alone; together they mean `--edit-verification require` forced a much
weaker check than the words implied, and a model that read the bound went and
ran the linter through `run_commands` anyway.

The SDK's tool now takes an optional lint command: given one it runs it per file
after the syntax check, reports what it said, and describes itself as the
linter, naming the command. Given none it is unchanged, because a tool that
claims to lint and does not would be worse than the gap. `--lint-command "npx
biome check ${file}"` on the CLI; `${file}` marks where the path goes, and
without it the path is appended.

A command that could not run at all is reported as such rather than swallowed.
Silence would read as a pass to a model that has just been told this is the
linter.

### `list_files` was in the wrong package

It imported no editor API — it takes a lister through its options, precisely so
the listing could come from somewhere else — but it lived in the extension,
where the CLI could not reach it. A model with no way to ask what exists does
not go without: it runs `ls`, or `dir /s` from wherever the shell started, which
is unbounded, unscoped and formatted differently on every platform. That is as
true in a terminal as in an editor.

The tool moves to the SDK unchanged and gains a second lister backed by the
filesystem: one root, a bounded walk, `node_modules` and the VCS directories
left out — the same set the editor excludes by default. Deliberately no build
outputs in that set: `dist` is noise to one user and the answer to "where did
the build go" for another, and a lister that hides a directory you asked about
is the failure this tool exists to prevent. The extension keeps its own, which
answers from the editor and honours the excludes you have already set.

## [4.100.38] — 2026-08-11

Two changes, one from #49 and one that #49's investigation made necessary.

### Getting back to the newest message

Scrolling up in a chat stops it following, and until now the only way to start it following again was to land within ten pixels of the bottom — `atBottomThreshold`, which is what clears the flag that scrolling up sets. That works on a list that is sitting still. It does not work while a turn is streaming, because every token appended moves the bottom further away than the scroll just closed, so a reader who scrolled up to check something was left chasing the end of the list.

There is now a **Jump to present** button, which appears when the view is not at the bottom and disappears when it is.

Widening the threshold would have been the smaller change and the wrong one: it would re-engage tailing while the reader is still reading, which is the complaint in the other direction. The button asks rather than guesses.

The part that matters is not the scroll. Every place that pins the view to the bottom checks the same flag first, so scrolling to the end without clearing it lands there once and stops following on the very next token — which would have looked like the button working and then breaking. Clicking it clears the flag and then scrolls, and both are covered by tests that fail if the clearing is removed.

### Asking for a verification mode from the CLI

The edit-verification setting — whether the model is nudged, or required, to check a file it has just edited — shipped in 4.100.34 with a control in Settings. That control only ever reached the VS Code host. A CLI run had no way to ask for a mode, so it always got the host default of `nudge`, whatever the user wanted.

```
cline --edit-verification require "fix the failing test"
```

`off`, `nudge` or `require`. Only the mode is sent, so the host keeps naming the checker itself; it adds `check_file` and already defaults to it, and duplicating that here would be a default that drifts.

A mode it does not recognise **fails the run** rather than warning and carrying on, which is what `--retries` does with a bad value. The difference is deliberate: this flag decides whether the model may finish a turn without checking an edit, and a typo that quietly fell back to the default would produce a run that looks like the mode was in force when it was not. In an unattended loop nobody reads the warning.

### Measurements

488 webview tests, 1,028 CLI tests, 74 in the runtime host, all green. Typecheck clean on the CLI, the core package and the webview. The two hook tests for the flag reset were checked against a build with the reset removed, and both fail there.

## [4.100.37] — 2026-08-10

#### Subagents are actually reachable now, and an agent can name a profile (#47)

**The Subagents toggle was storing a value nothing read.** `enableSpawnAgent` and `enableAgentTeams` were written into every session as the literal `false`. Everything behind them had already shipped — agent files in `.cline/agents`, one tool per agent with the routing folded into its description, a second provider's own connection for an agent that names one (4.100.33), a slot gate to bound how many run at once (4.100.32) — and the model was never offered any of it while the settings page showed the feature on.

Turn on **Settings → Agent features → Subagents** and the agents in `.cline/agents` become tools the model can call.

#### `profile:` in an agent's frontmatter

An agent file had `providerId` and `modelId` and nowhere at all to put a context window — which on a local model is the setting that decides whether the thing runs. A profile is the unit you already work in: you picked a provider, a model, a window, a sampler and a thinking budget and gave the combination a name.

```yaml
---
name: reviewer
description: reviews code for correctness
profile: fast-local-reviewer
---
You review code.
```

- `providerId` and `modelId` still **win** over the profile's — "that configuration, this model" is the only reading under which writing both is not redundant.
- A profile's connection wins over the session's **even on the same provider**, because its settings are the entire point and inheriting the session's would discard them.
- A profile that has been renamed or deleted is **refused, naming the agent and the profile**, rather than quietly run on the session's model.
- The resolver reads the picker's `selectedModelId` before the mode keys, for the reason 4.100.36 established: two fields name a model, and a profile saved before that fix can be holding a stale one.

The CLI has providers but no named configurations over them, so an agent naming a profile there is refused rather than run on the wrong model.

#### Not in this build: PolyKV pool sharing between lead and subagent

The reason is in the code rather than in the effort. A configured subagent runs on **its own system prompt** — the body of its own file — so it and the lead diverge at token zero and have no shared contiguous prefix to fork at. The engine's fork contract checks exactly that and answers `409`.

The half of that gap that was real already shipped in 4.100.32: with PolyKV enabled, the slot cap is lifted and the engine's own admission control paces the agents instead of us counting slots.

## [4.100.36] — 2026-08-10

#### The vision model now runs the model the Vision tab names (#43)

Found by the tester dumping his own `visionModeApiConfiguration` out of the settings file, which is more than Cline ever told him.

A scoped snapshot has **two** fields that name a model, and nothing kept them in step:

| field | written by | read by |
|---|---|---|
| `providerConfig.selectedModelId` | the tab's model picker | the status check, and the log line |
| `mode.<provider>ModelId` | the settings fields | **`buildApiHandler` — the actual request** |

His snapshot had the vision model in the first and the *primary* model in the second — DeepSeek, which cannot read images and is the whole reason he configured a vision model. The describer was built, installed, and pointed at DeepSeek. Every image went to a model that refuses images; the refusal dropped the image and the run carried on.

The picker's copy was not ignored. It was passed on as provider settings — where the context window and the sampler come from, and where a model id means nothing. It is also the field the `Describer installed` line printed, which is why that line read correct through four rounds of this issue while every request went somewhere else.

**Fixed on read, not on write**, and deliberately: every install already has the mismatch stored, so a write-side fix would only help snapshots written after upgrading. `buildScopedApiConfiguration` now puts the picked model into the mode keys under the key that provider's handler reads. A tab configured through the settings fields alone has no `selectedModelId`, and its mode keys stay untouched.

The regression test carries his snapshot with the values unchanged and fails against 4.100.35 with `expected 'deepseek-v4-flash:0731-cloud' to be 'mannix/omnimerge-v4-mtp:vision-Q5_K_M'`.

**The log now names what was resolved rather than what was picked**, with the context window beside it:

```
[Vision] Describer installed: provider=ollama model=… contextWindow=…
```

That second number is there because #44 is the other half of the same snapshot — his vision entry also carried the primary model's 1,048,576-token window.

## [4.100.35] — 2026-08-10

#### QA credentials — the other half of #46

The agent can now log in to test what it changed, without the credential entering the conversation.

**Settings → Agent features → QA Credentials.** Enter a name and a value; the value goes to secret storage and is never shown again. The CLI equivalent is `--qa-credential QA_PASSWORD`, which names an environment variable and reads the value from it — so the secret stays off the command line and out of shell history.

**The three rules**, none of which depend on what your project looks like:

1. The model is told the **names** and never the values.
2. A value reaches a command's environment only when **that command asked** for it — by writing `$QA_USER` into the command, or by listing it in `credentials` on the call. The second is there for `npx playwright test`, where the framework reads the environment and the command line names nothing.
3. Every value is **masked out of tool output** before it becomes transcript: `[redacted: QA_PASSWORD]`.

Rule 3 is what makes the others safe in practice — rules 1 and 2 govern what goes out, and output is where a secret actually comes back. `echo $QA_PASSWORD`, a test runner dumping its resolved config, a stack trace with a connection string, the command line echoed back — one choke point, all masked.

**Two details worth knowing:**

- **A declared name is withheld from every command that did not ask**, including from what a child would otherwise inherit from the process environment. Without this the gate would be decorative wherever the host itself holds the secret. Verified against a real spawned process: withheld and the command prints nothing, granted and it prints the value, `env` does not list it at all.
- **A command carrying a credential runs in a child process, never a visible terminal**, even if you have foreground terminal execution selected. A terminal outlives the command that needed the secret; a child process does not.

The environment variable is the interface on purpose — a seeded-user script, a `curl` with a bearer token, a Playwright config and a `docker compose` file all agree on it.

**What this does not defend against:** a model that decides to exfiltrate. If it can write `$QA_PASSWORD` into a command it can write it into a request to a server it chose. That is inherent in giving a credential to a program, which is why the field says test and sandbox credentials only. The guarantee is against accident and drift.

Also in this build: QA credentials are excluded from the API configuration. `ApiHandlerSettings` folds every secret key into the object sent to the webview — correct for a provider key, and the exact leak this feature exists to prevent for a QA one.

## [4.100.34] — 2026-08-10

#### Check Edited Files — the QA guard is now yours to set (#46)

The guard itself has been running since it shipped: a run that edits a file and never looks at it again gets held back and told to check it, twice, then let through. What was missing was any way to change that.

`editVerificationSettings` existed in the state keys and in the generated `Settings` proto, and there was nothing else — no `UpdateSettingsRequest` field, no handler, no path to the webview, no control. The mode could only ever be the value it was born with.

**Settings → Agent features → Check Edited Files**, below Auto Compact Strategy:

| mode | behaviour |
|---|---|
| `off` | no tracker is built; edits are never held |
| `nudge` *(default, unchanged)* | two holds, then the run proceeds |
| `require` | four holds |

All three were already real in core — this only exposes them.

**Not in this build, deliberately:** the test-credentials half of the request. Command execution here goes through the terminal manager, and the cheap ways to get a credential to a QA command either write it into the transcript or put it in the environment of every command the model runs. That needs its own design; see the note on #46.

## [4.100.33] — 2026-08-10

First of the four pieces of #47, and the one that was a defect rather than a gap.

**What was wrong.** A configured subagent is a markdown file in `.cline/agents/` whose frontmatter may name `providerId` and `modelId`. `buildAgentRuntimeConfig` spread the session's config and overrode exactly three fields — `providerId`, `modelId`, `maxIterations`. So an agent naming a second provider got that provider's *name* carried on the lead's API key, base URL, context window and model catalog: a request to the wrong server, which fails as an auth error or, worse, succeeds against a model nobody chose. That is the reported case — *"we have multiple providers that I would like to create agents to handle specific tasks."*

**Two paths now.**

An agent naming only a **model** inherits the session's connection and swaps the model in `providerConfig` as well as at the top level. The gateway reads it from both, and swapping only one left the request naming one model and running another.

An agent naming a **provider** gets that provider's own credentials, base URL and catalog. The host resolves it, because only the host knows where its provider store is: the CLI's follows `--config`, the extension's follows its own data directory, so core reaching for a default path would read the wrong file in one of them. The host's proxy/CA-aware `fetch` is carried across either way — it belongs to the process, not the provider, and dropping it is how a corporate proxy or a self-signed CA stops working for subagents only.

An agent whose provider the host cannot resolve is **refused by name** rather than run on the session's connection. Silently calling a server the user did not choose is worse than a clear error.

**How this passed before:** the existing execution test ran an agent on `openai` under an `anthropic` session and asserted only the id and the model. It now supplies a resolver and asserts the credentials.

Still open on #47, in the agreed order: #46 first, then a profile per agent, the toggle that lets subagents run in the extension at all, and PolyKV pools for shared-prefix parallelism.

Tests: core 2066 passed, CLI 1017 passed, extension 1222 passed.

## [4.100.32] — 2026-08-10

**The problem.** A local server has a fixed number of slots — `OLLAMA_NUM_PARALLEL` for Ollama, `--parallel N` for llama.cpp and opencoti — and a request that finds none free is not refused, it is *queued*, and nothing says so. Spawning four agents against a one-slot server runs one and leaves three waiting: the run reads as slow rather than blocked. A hosted provider has the same shape for a different reason — a plan allows so many concurrent requests, and the rest wait.

**The setting.** `Parallel Sessions`, 1 to 10, default 1, on every provider panel — every endpoint has the number, so it is not gated to a chosen few. Neither Ollama nor a hosted plan publishes it, so it is typed rather than discovered, and it sits beside the context window because it belongs to the same thing: one profile's arrangement with one endpoint. Being per profile, Plan, Act, Vision and Agents each carry their own; a scoped tab stores it in its own snapshot rather than in `providers.json`.

**What it bounds.** Concurrent delegated agents. The lead is blocked awaiting them, so it holds no slot: four slots means four agents.

Two consumers, one gate. `AgentTeamsRuntime.maxConcurrentRuns` was a hardcoded 2 that no caller ever set — it now takes the resolved count. `spawn_agent` had no bound at all: the agent loop can issue several in one iteration and each runs its sub-agent to completion inline. The gate rides on the delegated-agent config provider, the one thing every spawn path already shares, so the team runtime, the lead's `spawn_agent` and a sub-agent spawning its own all count against it. It queues rather than refuses, and hands a freed slot straight to the next waiter so a late arrival cannot overtake a woken one.

**The PolyKV exception.** opencoti registers the `/polykv/*` routes only when it was launched with `--polykv-max-pools N`, so `GET /polykv/pools` answering *is* the probe — there is no capability endpoint to keep in step with the launch flags, and nothing for you to tick and keep in sync. When PolyKV is on, agents attach to a pool and share a slot, and the engine's admission control decides against measured KV headroom; counting slots there would refuse work the server would have taken, so the bound stands down. A server that cannot be reached reads as PolyKV off, because a fixed slot count is the safe answer when the question cannot be asked.

**CLI:** `--parallel-sessions <count>`.

Note the behaviour change: with nothing configured the effective bound is 1, where team runs previously used a hardcoded 2 and `spawn_agent` used none. That is the value under which nothing queues unexpectedly; raise it to what your server was launched with.

Tests: llms 634 passed, core 2059 passed, CLI 1017 passed, extension 1338 passed, webview 471 passed.

## [4.100.31] — 2026-08-10

Plan, Act, Vision and Agents each hold their own configuration now.

**Agents tab.** Subagents and teammates inherited the session's whole connection — provider, model, sampler, and the context window with it. There was no way to run a team of small agents under a strong lead, and no way to size their window for the narrower job. The new Agents tab, beside Vision, holds a configuration of its own.

Stored the same way as Vision and for the same reason: `providers.json` keeps one entry per provider, the session's model owns it, and a second configuration on that provider cannot live there without overwriting the first. Both tabs now render the same panel component, so they cannot drift apart.

**Pinned against the session.** Core reads the connection from `CoreSessionConfig.delegatedAgentConnection` and holds the fields it names, so a mid-run model switch or a refreshed key no longer moves the agents back onto the lead's model. Anything the override does not name — a refreshed key for a provider they do share — still reaches them.

**Two leaks fixed on the way.** Loading a profile into Vision also wrote its provider settings to `providers.json`, which resized Plan and Act. And the tab's dirty check and save read the provider settings back from `providers.json` rather than from its own snapshot, so a profile saved from Vision carried the *session's* context window under a name chosen for the vision model.

**CLI.** `--agents-model <model-id>` and `--agents-num-ctx <tokens>`. This is where delegated agents actually run today: the VS Code session config still sets `enableSpawnAgent: false`, so in the extension the tab configures a connection that takes effect wherever agents are enabled. Turning them on there belongs to #47.

Tests: core 2053 passed, CLI 1017 passed, extension 173 passed, webview 172 passed.

## [4.100.30] — 2026-08-10

Two fixes, both of the same kind: something reported a cause that was not the cause.

#### A profile keeps its own context window

`providers.json` holds one entry per provider — and Plan and Act are in force at the same time. So two profiles on the **same** provider had a single place between them to keep a context window: whichever was loaded last won, and the other quietly ran on that number. That is the setting behaving as a global one however the panel looked, which is what was reported in the first place.

4.100.27 separated the Vision tab from the session. This separates the modes from each other.

A profile already carries these fields in its snapshot, so the fix reads them back per scope rather than moving where they live: no migration, and a user with no profiles keeps exactly the behaviour they had. Two profiles on one provider now resolve independently —

```
plan → { contextWindow: 128000 }
act  → { contextWindow: 8192 }
```

— and the session log says when a mode's settings came from its profile rather than the shared entry.

#### An aborted run says what stopped it

The runtime aborts with a reason: the mistake tracker passes its own message into `abort()`. The result then dropped it, which left the CLI inferring a cause from the only two things it can see locally — a timeout, and its own abort call. Everything else came out as `external_abort`, "aborted by another client".

There is no other client in a headless run. Measured: a run that ended on `consecutive mistakes reached (6/6) in yolo mode` in the runtime log reported another client on the JSON stream, so anything machine-readable was sent to the wrong layer entirely.

This is the 4.100.21 defect one layer further out, and the same rule settles it: a stop names itself, or it says nothing. The JSON now reads `"reason": "stopped"` with the run's own words, and `external_abort` is kept for the case it actually describes.

`abortReason` sits beside `error` rather than inside it — an abort is a stop that was asked for, and a consumer treating the two alike would report a mistake limit as a crash.

core 2,050 passed; agents 104; cli 1,017; vscode 1,342; `tsc --noEmit` clean across core, agents, cli and the extension.

## [4.100.29] — 2026-08-09

#### A repaired tool call could destroy the file it was writing

Malformed and incomplete want opposite treatment, and the tool-call repair path treated them as one thing.

Single quotes and unescaped newlines are a model writing JSON badly; repairing those loses nothing and is why the path exists. A payload cut off **inside a value** is a model that ran out of output tokens — and closing the quote for it produces a *valid* call carrying a fragment. Nothing downstream can tell that from a value the model meant to send.

For a whole-file write, that fragment is the file.

**Measured on a headless run.** A 14,127-byte file came back as 572 bytes, ending mid-rule at `top: 50`, with no `<script>` left in it, after the model's rewrite hit the output cap:

```
14127  manic_miner.html   (before)
  572  manic_miner.html   (after)
```

Everything else behaved correctly, which is what made it hard to see: the editor's own guards refused six later edits with `Read before editing`, and no log line mentioned a repair — repairing is silent.

The same shape reproduces in isolation. Feeding the path a complete call and the same call truncated:

```
complete:            refused (null)
truncated mid-value: REPAIRED -> new_text 98B of 181B, ends "olute; top: 50", has <script>: false
```

After this change, both are refused. Refusing returns the SDK's own error for the call, which the model sees and retries. That costs a turn; guessing costs the file.

**The repairs that matter still happen.** Only double quotes are tracked, so a single-quoted key never opens a string, an unescaped newline does not close one, and a payload that ends after a *closed* value is only missing its brackets — a repair that invents nothing. Those cases are covered by tests alongside the new one, which fails against .28 with `expected { toolCallId: 'call_1', …(2) } to be null`.

llms 620 passed; core 2,050 passed; `tsc -p tsconfig.build.json --noEmit` clean in both.

## [4.100.28] — 2026-08-09

#### The vision model has never described an image

Not "was broken in .24". Never — on this runtime host, since the feature shipped.

`agentConfig` in `local-runtime-host` is an explicit list of fields with no spread, and neither `describeImages` nor `alwaysDescribeImages` was on it. Both were dropped in silence between the session config and the runtime. The describer was built, logged as `[Vision] Describer installed`, and never called once, so the image went straight to the model that configuring a vision model exists to keep it away from — which then refused it, and the recovery path dropped the image and carried on. That is exactly what it looked like from the outside: *"it says it removed the image from the context and then just keeps going."*

It is the same defect as `condenseDiscardedReasoning`, in the same shape, one layer further out: a host sets a field, nobody copies it, nothing reports anything.

**Measured, not argued.** With a real 640×200 PNG and a real vision model:

| | before | after |
| --- | --- | --- |
| `[Vision] Describer installed` | yes | yes |
| `[Vision] Described N of M` | **never** | `Described 1 of 1 image(s)` |
| image at request time | still in the transcript | replaced by its description |

The unit test fails against .27 with `expected undefined to be [AsyncFunction Mock]` — the describer arriving as nothing at all.

#### The CLI can now run this scenario

Arranging that measurement meant giving the CLI the half it never had. It already loads `@./shot.png` mentions into `userImages`; `--vision-model <id>` now supplies the describer, built from the session's own provider with the model id swapped:

```
cline "what does @./shot.png show?" --provider ollama \
  --model <your-model> --vision-model <your-vision-model>
```

So the whole path runs headlessly and can be watched, instead of being inferred from a tester's log three rounds in a row.

#### Two things that had to be true first

`CoreSessionConfig` never declared either field. The VS Code host has set both since the feature shipped, and only got away with it because it adds them through a conditional spread — which excess-property checking does not inspect. A host assigning them directly was rejected for setting a field that has always been read. Declared now.

`timeout: false` from 4.100.26 does not overlap `RequestInit`. The llms build tsconfig did not check that file the way a consumer does; the CLI's did, immediately. Cast through `unknown`, beside `dispatcher`, which is not in the DOM lib either.

core 2,050 passed; llms 617 passed; cli 1,011 passed; `tsc --noEmit` clean in core, llms and cli.

## [4.100.27] — 2026-08-09

#### The context window was fixed in the panel, not in the request

4.100.25 stopped the Ollama settings panel falling back to `ollamaApiOptionsCtxNum` — a single global value — when the scope it was rendered in held no context window of its own. That fixed what the Vision tab *showed*.

It did not fix the resolver that decides what the model is actually **loaded with**, and that one reached for the same global field. So the tab displayed its own (empty) setting while the request carried the primary model's number. A display corrected over a behaviour that was not, which is why this looked unfixed after .25.

Measured, and now asserted in a test that fails against .26: with the Vision tab holding no window and the legacy field set to `64000`, the vision model resolved to `64000`.

A scoped configuration owns its entry now. An empty window means empty, and falls through to the vision model's own `num_ctx` or the default — never to the other model's number.

**Still true, and not fixed here:** `providers.json` is keyed by provider id alone, so two profiles on the *same* provider share one entry. Per-profile context windows for two Ollama profiles need that key to change, which is a larger change than this one.

#### Two things found while proving it

Both came from executing the path rather than reading it.

**An image the describer never sees leaves no trace.** A pasted image already reaches the collector as `{type:"image", image: <string>}` — the shape it matched before .25 too, so the .25 collector change was not what was breaking pasted images. That matters because an installed describer with nothing to describe is indistinguishable in a log from one that was never installed: both end with the image gone, the task carrying on, and no line written. The empty case now says so — counts only, never transcript content.

**Anything at all counted as image data.** The bare-base64 fallback accepted any string, so a value that was never an image became one with an `image/png` label on it. Measured: `/home/user/screenshot.png` came out of it as a 26-character image part and went to the model as a picture. Nothing failed, because nothing there could fail. It is now rejected on both the character set and the length.

core 2,049 passed; agents 104 passed; vscode 1,335 passed; `tsc -p tsconfig.build.json --noEmit` clean in core and agents.

## [4.100.26] — 2026-08-09

#### The timeout that named nothing

A headless run died at iteration 17, after 16 tool calls, with `TimeoutError: The operation timed out.` — no host, no URL, no subsystem in the message, so it read as a network fault and was scored as a failure of the model.

It was neither. The Ollama vendor already argues that a started response is not required to keep arriving at a fixed rate: a thinking model breaks that rule by design, and prefill at a large context is silence of exactly the shape a dead server makes. It lifted undici's version of that rule by handing over a dispatcher with `bodyTimeout: 0`.

Bun enforces the same rule and does not read `dispatcher`, so wherever the CLI runs, nothing was ever lifted.

Measured on Bun 1.3.14 against a local server:

| stream | outcome |
| --- | --- |
| chunks, then silence | `TimeoutError: The operation timed out.` at **300s** |
| the same, with `timeout: false` | alive past **800s** |
| a chunk every 30s | **completed at 600s** |

So it is a bound on the gap between chunks, not a budget for the whole response — and the gap is what this vendor exists to allow. The flag now goes out on every request, beside the dispatcher, and is inert on Node for the same reason the dispatcher is inert on Bun.

Nothing is left unbounded. The two bounds that are ours both name themselves — `Ollama did not start responding within Ns` and `Ollama stopped responding: no response data for Ns` — and both ask the server whether it is alive instead of trusting a constant.

**This is a CLI-only fault.** The VS Code extension host runs on Node, where Bun's cap never applied.

The new test fails against 4.100.25 with `expected [ undefined, undefined ] to deeply equal [ false, false ]`. llms package: 617 passed, 4 skipped; `tsc -p tsconfig.build.json --noEmit` clean.

## [4.100.25] — 2026-08-09

Both of these came out of a tester's 4.100.24 log rather than from reasoning about
the reports, and the diagnostics added in .24 are what made them findable.

### #43 — the describer was installed and never called

The log said `[Vision] Describer installed: provider=ollama model=…`, the
transcript still read `transcriptTail=[user:text+image]` at request time, and
`[Vision] Described N of M image(s)` never appeared at all. That line is emitted
whenever the describer runs, so its absence says the collector matched nothing.

It required a **string** under `image`:

```ts
if (part?.type !== "image" || typeof part.image !== "string") continue;
```

`AgentImagePart.image` is typed `string | Uint8Array | ArrayBuffer | URL`, and
parts also reach the transcript in the llms shape, which carries the payload
under `data`. One of five possibilities was accepted and the rest were skipped in
silence — so the image went to a primary model that cannot read one, the turn
failed, and the recovery path dropped the image and carried on. Which is exactly
what it looked like from the outside: "it says it removed the image from the
context and then just keeps going."

The payload is now read from whichever field carries it, with bytes encoded where
needed. A `URL` is still skipped deliberately: there is nothing to hand a
describer that takes base64, and fetching it is not that function's business.

Two tests cover it, and both fail against the previous build with
`expected "vi.fn()" to be called 1 times, but got 0 times` — the tester's symptom
stated as an assertion.

### #44 — one global key behind two tabs

> "context window seems to be a global settings and when changing the context
> window on the vision tab doesn't set it only for the vision tab"

That is the shape of it, and the cause is a fallback. `providers.json` holds the
context window per scope, but the panel fell back to `ollamaApiOptionsCtxNum`
when its own entry had none — and that key is a single global value. The Vision
tab, which owns a separate entry, therefore displayed the main model's number and
carried it forward from there.

The legacy fallback now applies to the unscoped panel only. A scoped panel owns
its entry, and an empty one means empty rather than "borrow the other model's".

Also in this build: the profile loader clears a context window with `0` rather
than `undefined` (an absent field means *leave unchanged* to the patch reader, so
the .23 clear was inert), and provider-config writes are logged with what they
asked and what the entry holds afterwards.

## [4.100.24] — 2026-08-09

### The correction first

The context-window half of 4.100.23 could not have worked. It cleared a profile's
context window by sending `contextWindow: undefined`, and the patch reader treats
an absent field as *leave this alone*:

```ts
...(protoPatch.contextWindow !== undefined
    ? { contextWindow: protoPatch.contextWindow > 0 ? protoPatch.contextWindow : null }
    : {}),
```

Only a value at or below zero clears. The Ollama panel's own field has always
sent `numCtx ?? 0` for exactly this reason; the profile loader did not. So a
profile carrying no context window still inherited whatever the previous profile
left in the shared provider entry — which is the reported symptom, unchanged.

It now sends `0`.

### Instrumentation, because three rounds is enough

Two facts decided every round of this and neither was written down anywhere.

**Which provider entry a write landed on, and what it did to the window.** The
provider config store now says so on every write:

```
[ProviderConfig] write provider=ollama contextWindow=32000 stored=32000
[ProviderConfig] write provider=ollama contextWindow=cleared stored=none
[ProviderConfig] write provider=ollama contextWindow=unchanged stored=110000
```

`unchanged` is the interesting one: it means the profile being loaded carries no
context window at all, which is a different bug from a write going astray.

**Whether the vision describer ran, or ran and came back empty.** Both end with
the images dropped and the task carrying on, and the log could not tell them
apart:

```
[Vision] Described 0 of 1 image(s)
```

Counts only — no image, no prompt, no transcript. Alongside the existing
`[Vision] Describer installed: provider=… model=…` and the `names no model`
warning from 4.100.23, those three lines settle which of the four possible
states a session is in.

## [4.100.23] — 2026-08-09

Two reports from the same tester, both "still broken", both with a cause one level below where the previous fix landed.

### #43 — images dropped with a vision model configured

`resolveVisionModelStatus` asked whether the Vision tab named a **provider**. A tab naming a provider and no model was `ready`, so a describer was installed with nothing to call: every description came back empty, the images were dropped, and the run carried on without them.

This is the same disagreement fixed in 4.100.14 — two facts behind one question — one level further down.

- `ready` now requires a provider **and** a model.
- The model counts from either place it can live: the picker's `selectedModelId`, or the mode keys the handler is actually built from. A tab configured through the settings fields is not called unconfigured.
- The log names *which half* is missing, not merely that something is.
- The settings warning now says images will not be accepted — which is what happens.

### #44 — per-profile context window

Loading a profile wrote its provider config through a hook bound to the provider the panel was **showing**. A profile that also switches provider wrote its context window onto the entry of the provider being *left*, while its own entry kept the number it already had.

`commitModelSelection` on that same hook throws on a provider mismatch for exactly this reason. The config write had no such guard. It now goes around the hook, to the profile's own provider.

A profile carrying no context window also no longer inherits the one the last profile left in the shared entry — that is the same number appearing under another name, and is precisely what "still matches the main profile" looks like from outside. It is cleared, so the window falls back to what the model declares.

### Also

Four tests were failing on an empty delimiter verdict. The scan moved into core and the extension files calling it were repointed at `@cline/core`, which under vitest resolves to a stub that did not export it: the import was `undefined` and the scan silently produced nothing. Shipped builds were unaffected.

## [4.100.22] — 2026-08-09

### What was wrong

`--timeout` and Ctrl-C/SIGTERM both depended on state assigned **after** `sessionManager.start()` resolved. In non-interactive mode with a prompt, `start()` runs the entire task and does not resolve until it is over.

So in exactly the mode a script uses:

- the timeout was scheduled *after* the thing it was meant to bound, and then cleared immediately on the `started.result` path — it could never fire;
- `abortAll()` spent the whole run with `activeSessionId` still `undefined`, so a signal set a flag and aborted nothing.

**Measured.** One run given `-t 2400` and a SIGTERM at 2520s ran for **3,649s** and started **nine more iterations after the signal**. The only trace either left was the word `aborted` in the closing summary — a flag being reported nineteen minutes late by a run that had ended on its own terms.

### The fix

The session id is known before `start()` — it is passed in the config, and the event subscription already relies on it — so the timeout and the abort target are armed against it up front.

A timeout is now also emitted on the JSON stream (`{"type":"run_aborted","reason":"timeout"}`). It used to reach stderr only, so anything reading machine-readable output saw a run that stopped for no stated reason.

### Scope

`apps/cli/src/runtime/run-agent.ts`. No provider, prompt, or SDK changes.

## [4.100.21] — 2026-08-09

### The run that prompted this

A 34-iteration run that had made **nine edits and six checks in twenty-four minutes** ended on a single repeated `editor` call. It was reported as:

```
max consecutive mistakes reached (3) in yolo mode
```

One mistake had been recorded. The limit was never approached — and the limit is the first place a reader goes looking.

### What changed

**The first hard loop verdict is a last warning, not a stop.** It is delivered through the tool result the model actually reads, and the call still runs. The second one stops the run. A model that has ignored the strike countdown needs an instruction that differs from the ones it ignored, not the same one counted down again.

**Forced stops are worded as the loop guard, in every host,** with the real count. `forced` already existed on the limit context for exactly this purpose; the CLI ignored it and the SDK's own default did too.

**The loop detector's messages state the diagnosis only.** The consequence belongs to whoever decides it — "stopping to avoid a loop" was describing something that no longer always happens.

**`--retries` defaults to 6,** which is what its help text has always said. The code said 3, so every run that did not pass the flag got half the documented budget.

### Scope

`apps/cli`, `sdk/packages/core` (loop detection, mistake tracker, session orchestrator). No provider or prompt changes.

## [4.100.20] — 2026-08-09

### The other half of the context window

v4.100.18 put the model's own `num_ctx` on the wire. Compaction never saw it.

It reads `context.model.info?.contextWindow`, which is `undefined` for a local
Ollama model — `/api/tags` reports names and nothing else, so there is no
catalog entry — and falls back to `DEFAULT_MAX_INPUT_TOKENS` (128,000)
regardless of what the server was actually told.

Measured before the 4.100.18 fix, on a model that declares `num_ctx 128000`:

| | |
|---|---|
| server was sent | `num_ctx = 32,768` |
| compaction sized itself to | 128,000 → trigger at 103,680 |
| observed peaks | **32,674** and **31,666** of a 32,768 window |
| compactions | **none** |

It never triggered, because the number it was watching was four times the real
one. Ollama silently truncated the prompt instead — the same loss of
transcript, with no record that it happened.

Today those two numbers agree only by coincidence: the model declares 128,000
and the hardcoded default is 128,000. Point the same setup at a model declaring
256,000 and they diverge again — the server would hold 256k while compaction
fired at 104k and discarded the rest.

So the declared window is now injected into `knownModels` for the resolved
model, which is what `tryGetModelInfo` reads. **`num_ctx`, the compaction
trigger and the preserve-recent ladder read one number.**

That last one matters more than it looks: `resolvePreserveRecentTokens` scales
how much recent transcript survives a compaction by the window, so an under-read
window does not only compact too early, it also preserves too little when it
finally does.

#### Logged, because it is otherwise invisible

```
Using the context window v7-coder_tb:vision-iq4_nl declares: 128000
```

Nothing else reports which window compaction is sizing itself against, and a
wrong one shows up only as a prompt the server quietly truncated.

Related to #44, same as 4.100.18: that issue is per-profile windows in the
settings UI; this is the layer underneath, where the window one part of the
system uses was not the window the others did.

## [4.100.19] — 2026-08-09

### The CLI could not check its own work

The edit-verification guard from #46 stands aside when no checker is named, and
the CLI named none — `check_file` is VS Code's tool, built on the editor's
language servers, and nothing replaced it elsewhere.

Measured on the CLI against a deliberately broken page: **ten `editor` calls,
zero checks**, and the run reported *"the implementation is complete"* on a file
that does not parse. The model was not being careless so much as blind.

So the local host now supplies a checker. It answers a narrower question than
the editor does — syntax and brackets, not types — and the tool description says
so outright, because a model that reads a clean result as "correct" is worse off
than one that knows the bound.

What it reports, on the real file:

```
manic_miner.html: error: Unexpected token '}'. Expected ')' to end an argument list.
Delimiter scan — 4 line(s) do not balance:
  the `(` opened at line 90, column 30 is closed by `}` at line 90, column 382 …
  `}` at line 95, column 494 closes nothing that is open …
  `}` at line 97, column 1 closes nothing that is open …
  the `{` opened at line 111, column 31 is closed by `)` at line 111, column 386 …
```

The scan names the **opening** bracket, which is the one you have to edit and the
one a parse error can never name — a parse error is always reported where the
parser gave up, which is the closer.

`.html` files get each `<script>` block parsed, with line numbers mapped back to
the HTML. No language server looks inside those, so this is the only report
there is for a page like this one.

#### A runtime difference that nearly made it useless

The parse is `new Function`, not `vm.Script`. On the same broken page, Node's
`vm.Script` throws `missing ) after argument list` and **Bun's parses it without
complaint** — Bun compiles the script lazily. The CLI runs on Bun. `new Function`
has to produce a callable, so both runtimes parse eagerly and both throw.

`vm.Script` is kept only to supply a line number where it will; where it will
not, the report omits the line rather than claiming `:1:` and sending the model
to the wrong end of the file. Module scripts are excluded from the `new Function`
path, since `import`/`export` is a syntax error in a function body and flagging a
working module would be worse than silence.

#### Default changed

`off` → `nudge` on the local host. Off was the honest default while it had no
checker; a guard nothing can satisfy is worse than no guard. That is no longer
the situation.

#### Also

`delimiter-balance.ts` moved into the SDK unchanged (no VS Code imports, 21 tests
still green). VS Code keeps its own `check_file` and pairs the scan with the
language servers this one cannot reach.

Fixed a latent drop found on the way: with no task-progress tracker the tool list
fell back to the pre-checklist array, which would have discarded the new checker
on exactly the runs that have no checklist.

#### Tests

479 passing in `@cline/core` tools and host, 16 new for the checker, extension
typecheck clean. Verified live under Bun end to end.

## [4.100.18] — 2026-08-09

### Ollama: the context window belongs to the model

A local model whose Modelfile says `num_ctx 128000` was being loaded at
**32768**, and nothing said so.

Local models are discovered from `/api/tags`, which reports names and nothing
else, so the resolved model carried no `contextWindow` and the
`OLLAMA_DEFAULT_CONTEXT_WINDOW` constant was what every one of them got.
Sending that default *overrides* the model's own value — Ollama has no way to
tell a considered 32768 from a placeholder one — so the model ran at a quarter
of the window it was built with.

This is the same mistake as writing a temperature from client code, and it is
fixed the same way: the value is read from the server rather than guessed.

**Precedence is now** user setting → the model's own `num_ctx` from
`/api/show` → the constant, for a model that declares nothing.

The lookup is primed once per server and model *before* the first request,
not resolved lazily: a `num_ctx` that changes between turns makes Ollama
reload the model mid-task. A server that will not answer, or answers something
unparseable, leaves the previous behaviour exactly as it was.

Wired into both hosts — the SDK vendor covers the CLI, and `buildSessionConfig`
covers VS Code, where the host override otherwise supplies a window before the
SDK ever gets to ask.

Verified end to end against a live server: `runner.num_ctx` 32768 → 128000.

Related to #44 — that issue is about per-profile context windows in the
settings UI; this is the layer underneath it, where an unset window became a
wrong one rather than the model's own.

#### Also in this build

The edit-verification guard from #46 is wired into the VS Code host: files
changed by `editor`/`apply_patch` and not checked since block completion once,
then a second time, then let the run through. Off / nudge / require, defaulting
to nudge.

#### Tests

585 passing in `@cline/llms` (8 new), 92 in the session factory, extension
typecheck clean.

## [4.100.17] — 2026-08-09

**The loop guard can see a refusal that arrives as a string.**

Six identical `editor` calls, one signature, six `No change: lines 89-97 already reads exactly this way` refusals, a full re-read of the file between each — and not one warning, let alone the stop. Twenty-four minutes of a live run.

The guard was never the problem. `declaredNoOp`, `allOperationsFailed` and `introducedRegression` all read the `{query, result, success, error?}` envelope, and all three required it to arrive as an object. `editor` returns that envelope already serialised, so its results reach them as a JSON *string*, every predicate fell through its `typeof entry === "object"` test to the safe answer — not a failure, not a no-op, no regression — and the safe answer is `productive`. A productive call *clears* the tally. Every one of those six refusals was recorded as a success, so the counter never reached one.

The envelope is now parsed out of a string before it is read. Parsing is best-effort and silent: a string that is not the envelope is left exactly as it was, so an unrecognised shape still reads as productive rather than ending a task that was working.

**A reused note no longer reports itself as new work.**

`Condensed capped thinking: 38924 chars of reasoning to a 936-char note`, thirteen times, identical numbers, seconds apart — while the summariser was called exactly once and every line after the first was a cache hit. The line was the only evidence anyone had, and it described the wrong thing. A cache hit now says so.

## [4.100.16] — 2026-08-09

**The condenser for a discarded turn is actually installed now.**

The two-pass treatment for a turn cut off at the output cap has never once run, in any session. `createAgentRuntimeConfig` assembles the runtime config from an explicit list of fields; `prepareTurn` is on that list and `condenseDiscardedReasoning` is not. The host installed it, the builder dropped it, and nothing said so.

Both halves are built from the same config, which is what made this hard to see. The prepare-turn condenser worked throughout — seven successful condensations in one measured session, including 55,190 characters of reasoning into a 1,364-character note — while the discard half was never installed at all.

The diagnostic added in v4.100.13 named it on the first capped turn after it shipped: `Discarded turn not condensed: no condenser is installed`, against a turn that had just spent 31,294 output tokens. Before that the only evidence was an absence — `notes=0` across four sessions, and nine milliseconds between the truncated turn and the retry's request, far too little for the summariser round trip a note requires.

## [4.100.15] — 2026-08-09

**`task_progress` is a tool the model can actually call.**

Fixes [#48](https://github.com/mann1x/cline/issues/48). The report says it exactly: `AI_NoSuchToolError: Model tried to call unavailable tool 'task_progress'`, twice, beside a panel reading "Tasks (7/7)". Both of those were true at the same time, and that is the whole bug.

The checklist has two halves. A wrapper adds the `task_progress` parameter to every tool and feeds the tracker — which is why the panel counted the boxes correctly. The standalone tool, the name a model calls when it has no other call to hang the checklist on, was pushed somewhere else: by `createDefaultTools`, and only when a tracker was passed into it. On the local runtime host the tracker is built *after* the tools are, so it never was. The parameter worked, the tool did not exist, and every direct call cost a turn and taught the model nothing.

The tool is now added where the tracker is, guarded by name so a caller that did build its tools with a tracker keeps the one it already has.

Also carried since v4.100.14: nothing else. This is a single-fix release.

## [4.100.14] — 2026-08-09

**A turn that runs past the output cap no longer costs the run five minutes and its reasoning.**

A turn cut off at the per-turn output limit with no tool call in it is discarded — it never enters the transcript, so the retry starts where the turn did instead of resending a half-written reply. That much was already true. What was not true is that anything survived it.

Measured on one session: four turns ended at exactly 32,000 output tokens — 6m15s, 5m13s, 5m39s, 5m30s — 22m37s of a 31m43s run, generated and thrown away. None of it was window-bound; input ran 29,527 to 53,842 against a 110,000-token window, so there was nothing for compaction to fix. Between them the model re-read and re-analysed the same file from scratch, because the analysis went in the bin with the turn.

Two changes. The retry now gets **half the cap that was overrun**, and half again on a second consecutive failure, with a floor above the largest turn ever measured recovering from one of these. That asks for what the reminder already asks for — one tool call, or one short paragraph — and a relapse costs about a minute instead of six. It is left alone when the window was what truncated the turn: that cap is the room the prompt left rather than a budget the model overran, and compaction is about to change it.

And the discard path now **says what it threw away**. It had been declining in silence, which from the outside is indistinguishable from a condenser that was never wired — for four sessions that is exactly how it read. The gap that settled it was nine milliseconds between the capped turn and the retry's request, far too little for the summariser round trip a note requires. Part types and sizes are now reported on every discarded turn, and each guard says which one fired. No transcript content is logged.

**Also in this release**

- **Capped thinking leaves a note the model can read.** Reasoning that ends at the model's budget is condensed into first-person prose in the voice of the thinker, not a summary about it, and reinjected in place of the block it replaces. The condensation is a real request now: it used to be a whole system prompt against an empty message list, and an empty message list is not a request — six condensations in one session reached the server as nothing at all. The note is bounded and discarded if it degenerates into repetition.
- **Discarded reasoning gets the compaction's two passes** — a note of where the turn had got to, and a retrospective of what its reasoning established — when the window has room for both.
- **`editor`: a trailing newline is not a line.** A `new_text` ending in `\n` appended a phantom line on every range edit, so the model's `end_line` was permanently one short and it fought the file for whole turns. Both the range and insert paths are fixed, and the create-form line count agrees with them.
- **ollama: content before the end markers.** The final chunk carries the model's thinking; handling `done` before the delta freed the reasoning id first and killed runs with `reasoning part … not found`.
- **Vision: one question, asked once.** The toggle and the resolved configuration were allowed to disagree, so a session could accept an image and send it to a model that cannot read one. Both sides now resolve it in one place, and a toggle with no provider behind it says so in settings.
- **Task end: how long it took**, in parentheses, and only past three minutes — and a nudge, then a last one, to close out an unticked checklist before declaring completion.
- **opencoti**: the session pins its shared prefix as a KV pool, re-roots onto a fork after each compaction, and lets the engine's own capacity reading say when to compact.

## [4.99.93] — 2026-08-08

**Overflow recovery no longer recovers by dropping turns.**

It went straight to basic compaction, which drops whole turns. The reasoning was that recovery must end deterministically and the summariser's own call could overflow the same window — written when the estimator was the thing that had just undercounted. The price was the run: measured across sessions, every overflow recovery was followed by the model coming apart, because the transcript it wakes up in contains the work but not the reasons.

Basic is now the floor rather than the answer. It runs first — local, cheap, deterministic — and its result is held. Then the summarising strategy gets one bounded attempt, accepted only if it is strictly smaller than the input and within the recovery target, the same bar a custom compactor is held to. A throw, a decline, or a transcript that is still too large keeps the basic one, so recovery never depends on another LLM request succeeding.

## [4.99.92] — 2026-08-08

Follow-up to 4.99.91, which hardened the message matching but was not the reason the condenser produced nothing — measured against the live logs, the model's copy of the budget message is byte-identical to the Modelfile's, so the old matcher would have found it.

The likelier reason is structural: the detector stopped at the first assistant message from the end and stood down if it carried no reasoning. A turn reaches the transcript as its reasoning and its call, and depending on how it was assembled those are one message or two — with the half lacking the reasoning nearest the end. Where that split happens the detector could never find a capped turn at all.

It now steps over an assistant message carrying only calls and keeps looking, while still stopping at one that answered (text means the turn is over). Where no split happens this changes nothing, and the stand-down line reports how many fragments it stepped over — so the log now says which shape a transcript actually has.

## [4.99.91] — 2026-08-08

**Why the condenser still produced nothing on 4.99.88.** It arms correctly there — the budget and the message both reach the runtime now — but the match was too literal. `v7-coder_tb` writes its `think_budget_message` as one quoted Modelfile line of `\n` escapes opening with two blank lines, and what the model actually streams back keeps neither those blanks nor the line break between its two sentences. The matcher took the message's first non-empty line and looked for it verbatim, so a layout that had no reason to survive the round trip had to.

It now collapses whitespace on both sides, and looks for the **longest** line rather than the first — which also covers a message typed into the settings box, where the opener may be short enough to occur in ordinary reasoning.

The detector also says why it found nothing now: no budget, no assistant turn, a turn that did not reason, the message not present, or reasoning under the cap — with the reasoning tail it examined. All five used to look identical from outside: no note, no error, no line.

## [4.99.90] — 2026-08-08

**Capped-thinking condensation is now configurable, and no longer switched off by the compaction toggle.**

`cappedThinkingEnabled` and `cappedThinkingPrompt` have been read by the host since the condenser shipped, and nothing ever wrote either — so the built-in note was the only note it could produce and there was no way to turn it off, while both its siblings (the compaction summary and the retrospective) have had a prompt box and a switch all along. **Features → Capped Thinking Prompt** now has both.

The condenser was also tied to auto compaction by accident: its settings travel inside the compaction config, and that whole object was omitted when auto-condense was off. A feature that rewrites one capped turn — whatever the transcript is doing — silently depended on a setting about compacting transcripts. The object is now always sent, and `enabled` remains the only thing that turns compaction itself on or off.

## [4.99.89] — 2026-08-08

`check_file` now says what it is. Asked how many errors the linter was reporting, a model answered that it could not count them and recited its own last edit report instead — the description named `eslint`, `ruff` and `tsc` but never the word *linter*, and `check_file` does not read as one. The tool description and all seven shipped prompt templates now state it outright: this is the linter, the type checker, the diagnostics, the Problems panel, and a question using any of those words is a call to it.

## [4.99.88] — 2026-08-08

Compaction settings were being dropped between the extension and the runtime. `splitCoreSessionConfig` rebuilt the compaction config from a hand-written list of five fields; the seven added since — both summary prompts, the thinking-summary switch, and everything the capped-thinking condenser reads, including the thinking budget — never crossed. The condenser therefore armed on every session and could never detect anything, and a configured compaction prompt never reached a session either. What crosses is now everything except the callback, so a new field arrives without anyone having to list it.

## [4.99.87] — 2026-08-08

**Fixes #44 properly.**

The context window a profile stores comes from `providers.json`, and the profile bar and the provider panel each held their own copy of that entry — read once when settings opened, never refreshed. Typing a new context window in the panel therefore never reached the bar: it kept comparing, and saving, the old value. That is why the 4.99.83 fix (making the unsaved-changes check count the provider config) changed nothing — the value it compares never moved.

Both now read one shared entry, so a write from either is what the other sees immediately, without reopening settings.

Also in this build: a profile load writes `providers.json` after the settings copy instead of before, so the legacy `ollamaApiOptionsCtxNum` mirror is no longer overwritten by the profile's own older copy of that key.

## [4.99.84] — 2026-08-08

Everything in `4.99.83` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.84.vsix --force
```

**Reload the window after installing.**

### Local MCP servers (#45)

The settings file has always taken a server Cline launches itself — a `command`, its `args`, spoken to over stdio — and the runtime has always run them. There was no way to add one except to open `cline_mcp_settings.json` and write it by hand: the only form in the panel was for servers Cline connects to over the network.

**MCP Servers → Local Servers** now has the fields the file itself holds: command, arguments, environment, working directory.

```
Server Name:  azure
Command:      npx
Arguments:    -y
              @azure/mcp@latest
```

Arguments are typed as a line of shell and stored as a list — one per line or space-separated, with quoting so a path containing a space survives. Nothing is handed to a shell to run. What gets written is what was typed, so a server added here reads identically to one added by hand and can still be edited there.

Blocking personal *remote* MCP servers does not hide this tab: that setting is about servers reached over the network, and says nothing about one running on your own machine.

### Ollama stream timeouts, again

`UND_ERR_BODY_TIMEOUT` was still ending runs in `4.99.82`, and the log said why: the health watchdog probed Ollama every 30 seconds through a five-minute prefill, got an answer every time, and undici killed the stream at exactly 300 seconds anyway. The dispatcher that disables that timeout only applies to a fetch that reads `init.dispatcher`, and the VS Code host supplies the global one unconditionally. A supplied fetch that is merely the global is not a routing decision, and no longer wins.

## [4.99.83] — 2026-08-08

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.83.vsix --force
```

**Reload the window after installing.**

### Fixes

**A profile can carry its own context window** (#44). The context window is not part of the settings snapshot — it is `contextWindow` in `providers.json`, which is what the session reads. A profile did capture it, but the unsaved-changes comparison skipped the provider config whenever either side lacked one, and a profile that has none always lacks one. Changing the context window therefore never marked the profile as changed, so it could not be saved. Profiles saved before this now read as changed once; saving carries the provider config from then on.

**Images are usable when a vision model is configured** (#43). Image support was asked of the primary model, which is the right question only while the image would reach it. With a vision model configured it never does — the description goes in the image's place before the request is built. The file picker was refusing images on behalf of a model that was never going to see one, and the tools were refusing to attach them.

**Ollama stream timeouts.** `UND_ERR_BODY_TIMEOUT` again: the dispatcher that disables undici's five-minute body timeout only takes effect on a fetch that reads `init.dispatcher`, and the VS Code host supplies the global one unconditionally. The vendor now prefers undici's own fetch, and a stalled response is measured against the server's health rather than a stopwatch — a server that answers `/api/ps` buys the request another interval, however long prefill takes.

**Tool-result images stay on the tool message** for Ollama's native API, instead of being relocated to a synthetic user message. Chat templates replay reasoning only from the last user turn onward, so a user message after every screenshot deleted the model's whole thinking history from the prompt.

**Reasoning is counted apart from the rest of a request.** One chars-per-token ratio for a serialized request (JSON, code, tool output) undercounts a reasoning-heavy one, which is the direction that lets a request be built too large.

## [4.99.75] — 2026-08-08

Everything in `4.99.74` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.75.vsix --force
```

**Reload the window after installing.**

### Thinking Compaction

Compaction writes a summary of what happened and throws the reasoning away with
the turns it replaces. What dies with it is every approach the model had already
ruled out — so it resumes with no memory of having been wrong, and makes the same
mistakes in the same order.

A second pass now reads that reasoning before it goes, against what it actually
produced. Each thinking block is paired with the call it led to and how that call
came back — applied, refused as a no-op, failed, refused by the loop guard — along
with what the turn cost, which is the one thing a model cannot read back off its
own thinking: whether the stretch that felt thorough was the one that spent 18,000
tokens on a refused edit.

It writes a retrospective, not a second summary: what worked, what wasted time,
where the time went, what to do differently. Method only — file names, line
numbers and values are banned, because those are in the summary and paying for
them twice is what makes both thin. It is emitted as a **thinking block on the
summary message**, holding the position in the transcript that the reasoning it
replaces held, and it chains: each retrospective is input to the next.

**Settings → Features → Thinking Compaction Prompt**, with its own toggle, right
below Compaction Prompt. On by default. Costs one extra model call per compaction.

### The output budget is a ladder now

It was a flat cap: `min(window × 0.08, 8192)`, identical at the first compaction
and the ninth. A first compaction summarises one stretch of work; a fifth carries
everything a task has learned, and holding both to one number is what makes a long
session degrade.

| generation | combined | summary | retrospective |
|---|---|---|---|
| 1 | 33% of target | 7,550 | 3,230 |
| 2 | 40% | 9,150 | 3,920 |
| 3 | 45% | 10,290 | 4,410 |
| 4 | 50% | 11,430 | 4,900 |
| 5+ | 55% | 12,580 | 5,390 |

(Tokens shown for a 110k window — a 32,670 target.) Generation 1 lands within 5%
of the old flat cap, so nothing changes for short tasks.

The summary takes 70% and **writes first**; the retrospective takes what is left,
floored at 20% and capped at 50% of the combined budget. So a summary that comes
in at half its share buys the retrospective room instead of leaving it unspent,
and one that overruns cannot starve it.

### Recent-turn preservation scales with the window

`DEFAULT_PRESERVE_RECENT_TOKENS` was 20,000 for every model, which is right for
exactly one window size: on a 32k window it asks to preserve more than the whole
compaction target, so compaction can reclaim nothing; on 1M it discards a task
with room for forty times that.

It now scales as `20,000 × (window / 128k)^(2/3)` — sub-linear, because the useful
tail is set by the task rather than the hardware. 20,000 at 128k, ~79,000 at 1M,
~18,100 at 110k. Capped at 60% of the compaction target so it cannot crowd out
what compaction is trying to write, which is what binds on small windows.

### The compaction row shows its work

"Context compacted · 87k → 37.9k tokens · 27 → 5 messages" now expands, with
**Summary** and **Retrospective** underneath it. Compaction is the one operation
whose output was otherwise unreachable — it replaces the messages it was written
from, so there is nothing to scroll back to.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to
2,000 characters each. Basic compaction gets no retrospective: it is the fallback
for when a model call fails, and stays request-free.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `4a13b291a`.

## [4.99.74] — 2026-08-08

Everything in `4.99.73` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.74.vsix --force
```

**Reload the window after installing.**

### Reasoning is reclaimed at compaction, not on every request

`4.99.38` was meant to stop compaction from carrying stale reasoning forward.
What shipped resolved on every Ollama request instead, so the model's own recent
thinking was stripped out of every turn whether the context was full or not — on
a request using 40k of a 110k window as readily as on one that was overflowing.

Ollama goes back to sending its reasoning. The reclamation now happens once,
where it was meant to:

- Basic compaction drops the reasoning of the turns it is discarding.
- It keeps the most recent block, so the turn the model is still working on
  comes back with the thinking that produced it — but only while the result
  still lands inside the compaction target. One block at high effort can be 14k
  tokens, which is the difference between reaching the target and compacting
  again on the next turn, so the exemption is priced rather than assumed.
- The summarizer's own input still drops all of it. It is reading the transcript
  to describe it; how the model talked itself into each tool call is not part of
  that description.

### The strike countdown now reaches the model

`4.99.73` added the countdown. It was never delivered. The warning was appended
to the conversation store, which the run snapshots when it starts and overwrites
when it finishes, so nothing appended mid-run survives.

Caught on the wire: the guard counted six refusals of one `editor` call and
stopped the task, and not one of the twenty-six requests logged in that session
carried a word of the warning. The model was being counted down at in silence.

It now rides the tool result, appended to the failure text the model is already
reading:

```
Editor operation failed: No change: lines 94-98 already reads exactly this way…

Warning: you have only 3 strikes left before the system will stop the session.
```

Only ever onto a failure — the verdict is formed before the call runs, and a
repeat that finally works should not be counted down at.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to
2,000 characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `591924c3f`.

## [4.99.73] — 2026-08-08

Everything in `4.99.72` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.73.vsix --force
```

**Reload the window after installing.**

### The loop guard counts down instead of stopping without warning

The budget is six now, and it is spoken. It used to be one warning and then a
stop on the very next repeat, which — on a run that had been going for twenty
minutes — read like every other refusal until the run was over.

The first failure says nothing about strikes; one failure is ordinary. Every
repeat after it ends with the count:

```
Warning: you have only 5 strikes left before the system will stop the session.
…
WARNING: this is the LAST strike! Another failure and the system will STOP the
session! Do not send this call again — change the arguments, use a different
tool, or say what you are stuck on.
```

Six matches `maxConsecutiveMistakes` deliberately: those two are the only things
that stop a run for repetition, and a model told it has strikes left should not
find that a second, shorter budget was also counting. A call that succeeds
clears its own tally, so an edit-test cycle never accrues one.

### An edit that duplicates its range now names the gutter

When `new_text` carries the `read_files` line-number gutter and that gutter runs
past `end_line`, the refusal says so:

> The gutter on your `new_text` covers lines 129-168, but the call names only
> line 129: if you meant to replace 129-168, send `end_line: 168`.

The model wrote those numbers itself; the last one is the `end_line` it meant.
A gutter that stops inside the range is not mentioned — it was not the problem.

### The log can be read while the window is running

VS Code buffers the output channel and only writes
`…/exthost/output_logging_*/1-Cline.log` when the extension host restarts. The
current session's log is 0 bytes on disk, so reading it meant reloading the
window — which ends the run you were trying to diagnose.

Every line is now mirrored to `~/.cline/data/logs/extension.log`, flushed once
logging goes idle (and at least every five seconds under a continuous stream).
It rotates at 8 MB, keeping one previous file.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to
2,000 characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `63e658651`.

## [4.99.72] — 2026-08-08

A regression from `4.99.68`, found the same night. Everything in `4.99.71` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.72.vsix --force
```

**Reload the window after installing.**

### A stopped run left you with no buttons at all

The loop guard stops a task; the red **Cline stopped the task** row appears; and the footer is
empty. No Retry, no Start New Task, nothing to click.

`4.99.68` stopped the mistake tracker's in-run notices from ending the turn — the right fix, they
were putting Retry / Start New Task on screen over a task that was still working. But the flag
those notices set was also, by accident, the only thing carrying "something went wrong" to the end
of the turn. Turn end only ever handled `done(reason:"error")` explicitly, so a run that stopped
for any other reason resolved to *awaiting a follow-up* — a state that shows no buttons by design,
because it means the agent is waiting for you, not that it gave up.

Caught on a live install:

```
22:18:14  Recorded consecutive mistake 1/6 (tool_execution_failed): This exact call to `editor`
          was already refused because what it sends is character-for-character what the file
          already holds
22:18:15  Agent loop caught error (aborted): AgentRuntimeAbortError: mistake_limit_reached
```

Only `completed` means the run reached its end. Every other terminal reason — an error, an abort,
the mistake limit, max iterations — is a run that stopped, and now offers Retry / Start New Task.

Cancelling a task is unaffected: that path sets its own phase first and still offers Resume Task.

### Already in 4.99.68 – .71

- Recoverable in-run notices no longer end the turn.
- An MCP server whose transport died is reconnected and the call retried once.
- A repeated no-op edit gets a warning before it stops the task.
- The profile list opens over the provider controls instead of behind them.
- Loading a profile actually changes the model, and there is a Load button.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000
characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `d684f56b6`.

## [4.99.71] — 2026-08-07

Loading a profile did not change the model. Everything in `4.99.70` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.71.vsix --force
```

**Reload the window after installing.**

### A loaded profile left the model where it was

Picking a profile appeared to do nothing: the panel did not move, and the Update/Revert buttons
flashed and vanished as though there were nothing to save.

The model is held in two places. The settings snapshot records it as `ollamaModelId` (or whatever
the provider's key is), and the provider store records it as a per-mode *selection* in
`providers.json`. Loading a profile wrote the first. The model picker and the session both read
the second.

So the two disagreed, and neither the panel nor the dirty check could tell. Caught on a live
install mid-session:

```
globalState     actModeOllamaModelId = "a3b-coder_tb:vision-cd-iq2_xs"   ← what the profile set
providers.json  settings.model       = "v7-coder_tb:cd-q2_k"            ← what would have run
```

The picker showed the second one, so nothing looked like it had changed; the dirty check compares
against the first, so nothing looked unsaved either. The buttons appearing and disappearing was
that comparison settling.

A load now commits the profile's model through the same path the picker uses, which writes both.
A profile that also switches provider is committed directly, because that path is bound to the
provider the panel was showing.

**Profiles already saved do not need re-saving.** The model is read from the snapshot they already
carry; nothing about the stored format changed.

The Vision tab keeps its selection inside its own snapshot rather than in `providers.json`, and had
the same hole from the other side — a loaded profile left its picker to fall back to the first
model in the list. The selection is now carried into that snapshot too.

### A Load button

The dropdown fires nothing when you pick the value it already holds, so with a profile selected
there was no way to ask for it to be applied again — not to discard an edit, and not to retry a
load that looked like it had not taken. The button next to the dropdown does that: **Load** when
the panel matches the profile, **Revert** when it has been edited. Same action either way.

### Already in 4.99.68 / .69 / .70

- A recoverable in-run notice (`1 tool call(s) failed: …`) no longer ends the turn.
- An MCP server whose transport died is reconnected and the call retried once.
- A repeated no-op edit gets a warning before it stops the task.
- The profile list opens over the provider controls instead of behind them.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000
characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `573ce4a2a`.

## [4.99.70] — 2026-08-07

One UI fix on top of `4.99.69`.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.70.vsix --force
```

**Reload the window after installing** — and if you have been installing these without reloading,
check which version you are actually on first: the extension host keeps running the code it was
loaded with, so several builds can be unpacked on disk while an older one is still doing the work.

### The profile list was drawn underneath the provider controls

Once enough profiles were saved for the list to reach past the top of the form, it disappeared
behind the API Provider box instead of over it, and was cut off there.

The API Provider combobox raises its own input to a fixed z-index so its results paint above
everything below them. The profile dropdown sat above it in the panel with no z-index at all, so
the browser drew it first and the provider input covered whatever hung down into it. With one or
two profiles the list ended before it got that far, which is why this only appeared once a few
were saved.

It now uses the same raised container the provider dropdowns use, one step higher, and opens
downward.

### Already in 4.99.68 / 4.99.69

- A recoverable in-run notice (`1 tool call(s) failed: …`) no longer ends the turn: no more
  Retry / Start New Task, and no more disabled composer, over a task that is still working.
- An MCP server whose transport died is reconnected and the call retried once, instead of
  answering `{"error":"Not connected"}` to everything from then on.
- A repeated no-op edit gets a warning that says the change is already in place, and only stops
  the task if it comes back again.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000
characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `d059f039d`.

## [4.99.69] — 2026-08-07

One fix on top of `4.99.68`, from a run that died on it minutes after `.68` went out.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.69.vsix --force
```

**Reload the window after installing.**

### A repeated no-op edit killed the task on the second attempt

```
Cline stopped the task: tool_execution_failed: This exact call to `editor` was already
refused because what it sends is character-for-character what the file already holds.
```

The leash on a no-op edit was shortened to one repeat in `4.99.64`, for a good reason: the
same `editor` call had been sent seven times against six "No change" refusals, twenty-four
minutes, no edit, and the run ended on the loop stop anyway. Five attempts bought nothing but
the time.

One repeat turns out to be too few. A no-op is not a runaway — it means the file already holds
what the call asked for, so the model has misread the state, not lost control of it — and
stopping the task on the second attempt throws away everything still left to do.

So the first repeat is now a warning that says what happened in terms the model can act on
(the change is already in place, nothing failed, move to the next thing that still needs
changing), and the stop arrives on the one after. That still ends the seven-attempt case at
the third call. A repeat of a call that had previously *succeeded* already worked this way;
both paths now read the same, and an edit that starts working again gets a fresh warning
rather than inheriting the spent one.

### Already in 4.99.68

- A recoverable in-run notice (`1 tool call(s) failed: …`) no longer ends the turn: no more
  Retry / Start New Task, and no more disabled composer, over a task that is still working.
- An MCP server whose transport died is reconnected and the call retried once, instead of
  answering `{"error":"Not connected"}` to everything from then on.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000
characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `35153b33c`.

## [4.99.68] — 2026-08-07

The two problems left open in `4.99.67`. Everything in `4.99.67` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.68.vsix --force
```

**Reload the window after installing.**

### Retry / Start New Task over a task that was still running

The SDK has two kinds of error event, and only one of them ends a run. `recoverable: false` is a
terminal failure. `recoverable: true` is an in-run *notice* — the mistake tracker emits one for
every failure it records (`1 tool call(s) failed: [task_progress] …`), and the agent carries
straight on afterwards.

The UI translated both the same way. A single failed tool call therefore ended the turn as far as
the interface was concerned: the footer went to Retry / Start New Task, the composer was disabled
along with it, and the session was marked not-running — over a run that was still working, as the
text below the red row in your screenshots shows. Nothing put it back, because the only thing that
restores the streaming state is a new prompt.

Now only a terminal failure does any of that. A mistake notice is a red line in the transcript and
nothing else: no ask, no phase change, no footer, and an in-flight compaction is no longer closed
as failed underneath it.

**This is likely the "hangs when answering a question, needing several presses of Return" report
as well** — the failed-request footer disables the composer, so pressing Return did nothing until
some later render moved the state on. Worth re-testing; if it still happens with no error on
screen, it is a separate bug and I'd like the log.

### `{"error":"Not connected"}` from an MCP server

When a stdio MCP server exits, its transport closes and the client is left in place with the
transport cleared. Only the connection's *status* was updated — nothing rebuilt it — so every
later call to that server failed with a bare `Not connected`, handed to the model as the tool's
own result. Neither the model nor you were told that the server had simply gone away.

The call now reconnects the server and retries, once.

Retrying a tool call is normally not safe, and it is worth being precise about why it is here:
the MCP SDK raises `Not connected` *before* the request reaches the transport, so the call was
never sent and the retry cannot run anything twice. Timeouts and failures that happened mid-flight
are rethrown untouched — those may well have executed.

If the reconnect fails, the error now names the server, the tool that did not run, and the last
connection error, instead of two words.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000 characters
each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `b0d5e6307`.

## [4.99.67-mann1x] — 2026-08-07

Includes everything in `4.99.66`. One more fix from the tester's session — and, below, three reported problems that are **not** fixed here, with what is known about each.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.67.vsix --force
```

**Reload the window after installing.**

### `task_progress` can be called as a tool

Reported as:

```
Tool call task_progress was rejected before execution:
AI_NoSuchToolError: Model tried to call unavailable tool 'task_progress'.
```

…twice in a row, while the panel directly above showed `Tasks (2/6)`.

The checklist is a *parameter* that rides along on any tool call — that is the cheap way to keep it current, since it costs no extra round trip. But a model that is asked to maintain a checklist will call it by name, and being told the tool does not exist costs a turn and teaches it nothing.

It is now a tool as well as a parameter. It carries no behaviour of its own — the capture already reads the checklist off the raw input of every call, this one included. What it adds is a name to call at the moment a plan is usually written: before any work has started, when there is no other call to attach it to.

### Fixed in 4.99.66, if you are coming from earlier

- **`run_commands` answered "Invalid input" to everything**, `echo` included, until the model concluded the tool was non-functional and the loop guard stopped the task. The input union now takes the spellings models actually send, and an error that names no field shows the caller its own arguments back.
- **A base URL without `http://`** broke every request with `Invalid URL` and left the model picker silently empty. `host:port` is now read as `http://host:port`.

### Reported but not fixed here

Three problems from the same session are still open. Saying so rather than letting them look fixed:

**Retry / Start New Task stay on screen while the task is still running.** Reproduced in every screenshot. There is a lead — the mistake-limit handler emits a `running` status alongside a terminal error row, which is a contradiction the UI has no way to resolve — but that path is also what keeps a session resumable, and changing it blind risks breaking resume. It needs to be worked through against the UI rather than guessed at.

**An MCP tool failed with `{"error":"Not connected"}`** mid-run, surfacing as a tool failure rather than a reconnect. Not investigated yet.

**Hangs when answering a question, needing several presses of Return.** No screenshot and no log yet, so there is nothing solid to work from. If you can catch this one with the Cline output channel open, that would likely be enough to find it.

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000 characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `2f01f528b`.

## [4.99.66-mann1x] — 2026-08-07

Two bugs from a tester's session, both of which took a whole capability out rather than merely making it awkward. Everything in `4.99.65` is included.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.66.vsix --force
```

**Reload the window after installing** — `code --install-extension` unpacks the new version, but the running extension host keeps the old code until the window reloads.

### `run_commands` answered "Invalid input" to everything

Reported as: every command failed, `echo` included. The transcript shows the model working it out and giving up —

> `run_commands` is definitively non-functional in this environment (returns "Invalid input" for every command, even `echo`). This is a hard tooling limitation.

— and then sending the same call five times until the loop guard stopped the task. The loop guard was right; there was nothing else for the model to do.

**The shapes.** The input union took `cmd` at the top level but *not* inside `commands`, and `args` only as an array, so a single spelling slip failed the entire call. It now also accepts:

- `{"commands": [{"cmd": "…"}]}` — nested `cmd`, which the top level already allowed
- `{"commands": [{"command": "echo", "args": "hi"}]}` — `args` as one string
- `{"commands": [["echo", "hi"]]}` — an argv list
- `{"shell_command": "…"}` and `{"script": "…"}`

A bare list of strings still means a list of shell commands. The argv branch would read the same value as one command plus its arguments, and only the order of the union keeps them apart — so `["echo hi", "ls"]` is two commands, as it always was.

**The message, which mattered as much.** A union that matches no branch prettifies to a bare `✖ Invalid input` — no path, no field, no type. The model was told nothing it could act on, so it changed nothing and retried. When an error names no field, the caller is now shown its own arguments back:

```
✖ Invalid input
Received: {"commands":[{"shell":"echo hi"}]}
```

That applies to every tool validated through a union, not just this one.

### A base URL without `http://` broke the provider silently

Reported as "something is killing the http/https". The symptom was:

```
Failed to parse URL from 192.168.1.100:30068/api/chat: TypeError: Invalid URL (ERR_INVALID_URL)
```

Every request failed, and the model picker sat empty with nothing on screen connecting the two.

**Being straight about this one:** I could not find what drops the scheme. Every normalizer on the write path preserves it, so the fix is to the *reading* rather than the writing — `host:port` has exactly one sensible meaning, and both the session path and the model picker now assume `http://` when no scheme is given. `https://` and anything else already spelled out is left alone.

So a stored URL that lost its scheme now works, and typing `192.168.1.100:30068` deliberately works too. If you can still make the scheme vanish from the field as you type, that is worth reporting — it would be the underlying bug, which this only covers for.

### Already in 4.99.65, if you are coming from .63 or earlier

- Compaction reaches its target: the per-turn cap now reaches the model record, so a long conversation is aimed at a third of the window instead of silently falling back to 70% of the trigger.
- One long turn can no longer defeat a compaction — past two thirds of the budget the cut goes into the current turn, with its prompt pinned rather than summarized.
- The compaction notice compares like with like, so a compaction can no longer appear to make the context larger.
- The compaction prompt is rewritten and editable in **Settings → Features**.
- `/api/show` is retried instead of being lost to a busy Ollama.
- The loop guard can tell a repeat of a success from a loop, and a forced stop is no longer reported as "N errors in a row".

### Known limits

Video input is not supported. The summarizer's input still clips tool results to 2,000 characters each.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `3d3299867`.

## [4.99.65-mann1x] — 2026-08-07

A compaction release. Everything here came out of two consecutive compactions on `4.99.63` that reclaimed almost nothing and then fired again on the very next turn — with the first one displayed as making the context *larger*.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.65.vsix --force
```

**Reload the window after installing.** `code --install-extension` unpacks the new version, but the running extension host keeps the old code until the window reloads — which is how a `4.99.64` install spent an hour looking like it had changed nothing.

### "89.9k → 93.8k" was a measurement artifact

The two ends of that arrow came from different rulers. The "before" is the provider's own token count. The "after" could only ever be an estimate — it describes a request that has not been sent yet — and the estimator over-reads by 15–20%, because it counts reasoning blocks that Ollama strips before sending. When the over-read exceeded the reduction, the notice printed an increase.

The after-figure is now scaled by how far the same transcript's estimate stood from the count the provider actually gave it. Same messages, same method, moments earlier. On the measured case that turns 93,844 into 81,096, against an actual 80,317.

Nothing about the compaction changed there — it never made the context larger. But it was being reported as though it had.

### The 33% target was never in force

Compaction aims a long conversation at a third of the usable window. That branch only applies when the model reports a per-turn output cap below its input budget — and for a local model, nothing ever set one. Every diagnostic read `modelMaxTokens: null`, so the target silently fell through to 70% of the trigger: **54,600 instead of 36,300**, with no indication that the figure you configured was not the figure in use.

The session's output cap now reaches the model record. Carefully: an explicitly configured cap always wins, a model that publishes its own figure keeps it, and the synthesized default is written only for Ollama — where the model publishes nothing and that cap is what goes on the wire.

### One long turn could defeat the whole compaction

The cut stops at the start of the latest typed prompt, so the turn you are in survives intact. But a turn is a prompt *and everything the model did about it*, so one prompt followed by a twenty-call tool loop is a single turn that can be most of the transcript. The clamp then dragged the cut back to near the beginning and folded almost nothing: measured live, a 250,621-byte request compacted to 226,763 — ten small messages, 9.5% reclaimed — and the trigger fired again immediately.

Past two thirds of the budget, that turn stops being exempt.

Its prompt still survives, pinned verbatim rather than summarized. What costs the window is the tool traffic under the prompt, not the sentence that asked for it — so the model keeps the request it is working on and loses only the loop, which it can re-derive from the file.

### The compaction prompt is rewritten, and now yours to change

The summary replaces the turns it stands for permanently: every later turn reads it and never the conversation again. The instruction that produced it asked for a note that was "concise and factual" under five short headings — and the system half of the same request separately asked for something concise, so the one message that has to carry everything was being pulled toward brevity from both sides.

The new default asks for what has to survive: exact paths and identifiers, error text, commands, decisions already taken, and — the one that matters most — **approaches already ruled out**, so the next stretch of work does not re-try them.

It is editable at the end of **Settings → Features**. The field grows to fit, shows the built-in prompt as its placeholder so you can see what you are replacing, and has a Reset button. `{{files_read}}` and `{{files_edited}}` are substituted; a custom prompt that omits them still gets a Files section appended, because a summary that has lost track of which files are in play reads as authoritative while being wrong.

### Known limits

The summarizer's *input* is still built with tool results clipped to 2,000 characters each, so the summary is written from a clipped view of what it summarizes. That is unchanged here and is the next thing to look at if summaries come out thin.

Video input is not supported.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `d11382a66`. Tested against Ollama serving local Qwen3-family builds.

## [4.99.64-mann1x] — 2026-08-07

Three fixes, all of them found by reading the logs of a `4.99.63` run rather than by reasoning about the code. If you are on `4.99.63` and long sessions are working for you, the one that will change what you see day to day is the loop guard.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.64.vsix --force
```

### The compaction summary is no longer written in 1,024 tokens

When a long session compacts, everything before the cut is replaced by one summary, and every turn after it reads that summary instead of the conversation. It is the single most load-bearing thing the model writes all session.

It was being given a flat 1,024-token budget regardless of the window. Measured on a live run: a 67,363-character transcript went into a 110,000-token context and the summarizer was asked to answer in 1,024 tokens, with roughly 87,000 sitting unused.

The budget is now taken from the window — 8% of the usable input budget, never below the old default, never above 8,192. A 110,000-token window buys the full 8,192; a 32,000-token window gets 2,560; a small model keeps the small summary that suits it. The ceiling is deliberate: a summary becomes the context every later turn carries, so it must not be allowed to grow back into the space compaction just freed.

### `/api/show` is asked properly instead of once

Everything Cline knows about a local model — its real context window, whether it can see images, what its thinking budget resolves to — comes from Ollama's `/api/show`. That was one attempt with a two-second timeout, and if it missed, the session started on guessed values instead. A guessed context window is the bug that has had to be fixed twice in this fork, and it is silent: auto-compaction budgets against a window the model does not have.

It missed on a live run for the ordinary reason — Ollama was busy loading the model.

Now it asks until it gets an answer: ten quick attempts, then a warning on screen so the wait is not mysterious, then a timeout ramping to ten seconds out to thirty attempts. If Ollama never answers, **the session fails** rather than starting on values nobody chose.

That applies to the values a session cannot be started without. A prompt-template family lookup, or the placeholder text in a settings field, still takes one attempt and shrugs — opening the settings panel while Ollama is down should not mean sitting through a retry ladder to see what you would have seen anyway.

### The loop guard stopped a run that was not looping

Reported from a live session, and correct. What actually happened:

```
editor, lines 94-97   → applied
editor, lines 94-97   → "No change" (identical call)
editor, lines 94-97   → task stopped
```

Two things were wrong.

**The guard had no memory that the call had succeeded.** It treated a repeat of a call that had just *worked* exactly like a call that had only ever failed. Worse, what the model was told — "what you sent is character-for-character what the file already holds" — is true, reads like a failure, and never mentions the one fact that would have resolved it: *your own edit is what put it there*. The model now gets told that, once, in as many words: the edit already succeeded, nothing was lost, move on. Only a further repeat after that stops the run. A call that has never succeeded is still stopped on its first repeat, which is the case the guard was built for.

**"Cline ran into 6 errors in a row" had not happened.** Forcing a stop used to jump the mistake counter straight to the limit purely to reach the stop path, and the number was then reported as a count. There had been two failures, with two successful edits among the turns being counted. The count is now truthful, and a forced stop is described as what it is instead of as a tally.

### Known limits

Video input is not supported.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `28af7b4cc`. Tested against Ollama serving local Qwen3-family builds.

## [4.99.63-mann1x] — 2026-08-07

A settings-panel release. Everything here is a fix to something reported from live use of `4.99.59`; there are no new capabilities. If you are on `.59` and the Vision tab behaved itself for you, the one change you still want is the line-count fix.

Install the `.vsix` below with **Extensions → … → Install from VSIX**, or:

```
code --install-extension cline-mann1x-4.99.63.vsix --force
```

### The Vision tab is now a configuration of its own

Choosing a second model for vision was sharing state with the main model in three separate ways, and each one looked like a different bug.

**Your vision model came back as the first model in the list.** The selection was written correctly every time — confirmed against the stored state on the test machine — and then discarded on read. Both deserializers for a stored configuration rebuilt it field by field from only the two sections they knew about, so the provider settings, which is where the vision model id lives, never survived a round trip. Reopening the settings panel showed whatever was first alphabetically.

**Saved profiles were losing settings the same way, and had been since `4.99.57`.** A profile saved with a context size, sampling values and a thinking budget restored the provider and the model without them. Same dropped section, different symptom, so it was not obvious the two were one bug.

**Changing the model in the Vision tab overwrote the active profile without an Update.** The tab wrote through the shared provider store, which is also what the profile bar reads and writes.

**Act and Plan are separate from Vision, and from each other.** Editing one no longer moves another.

### Toggles that answer the click

"Use a different model for vision processing" needed three to five clicks to enable, and enabling it sometimes stopped the Act/Plan toggle from responding. These checkboxes flip their own internal state on click and were being driven from a setting that only came back after a write and a state broadcast — so the box would snap back before the real value arrived, and the next click toggled it the wrong way. The displayed state now changes immediately; the stored setting still wins when it arrives, so a write that genuinely failed shows up as the box returning, not as a lie.

### A Revert button, and a Save button that tells you it matters

The profile bar now outlines **Update** and **Save as…** in red when what is in the panel differs from what the profile holds, so unsaved changes are visible rather than remembered. **Revert** reloads the active profile and throws away those changes.

### `read_files` and the editor now agree on how long a file is

A file VS Code showed as 271 lines was reported as 270 by `read_files`, while the editor tool demanded `end_line: 271` for a whole-file rewrite. Two different ways of splitting on a trailing newline. Models were burning turns trying to reconcile the two numbers, and refusing edits that were correctly formed. Both now count the same way.

### Thinking level

**Custom** is now an entry in the Thinking Level list, and `think_budget` appears underneath it only when Custom is selected. The dropdown is the master: setting a named level clears a leftover budget rather than silently losing to it.

`think_budget_message` is a textarea that grows to fit its contents, so you can read the message the template is actually using — and write a replacement — instead of seeing the first few words of it.

### Also in this release

- The vision model replaces **all** of the primary model's vision, not just browser screenshots: images you paste or attach go to it too. When no vision model is configured and the primary model cannot see images, the transcript now says so explicitly instead of leaving a silent gap.
- An oversized replacement that arrives with line-number gutters baked into it (`  135 | </body>`) is no longer written into the file verbatim.

### Known limits

Video input is not supported. Very few local models accept it, and nothing here pretends to.

---

Built from `mann1x/cline`, branch `mann1x/loop-and-listing`, commit `191b45c4d`. Tested against Ollama serving local Qwen3-family builds; the Ollama-specific parts of the settings panel are the parts that get exercised.

## [4.99.59-mann1x] — 2026-08-07

Forty-one builds since 4.99.18, all of it driven by watching a local model fail a real task for an hour and then reading the transcript to find out why. Most of what follows was a measurement first and a fix second.

### Install

Download `cline-mann1x-4.99.59.vsix` and:

```
code --install-extension cline-mann1x-4.99.59.vsix --force
```

Reload the window afterwards — the extension host keeps the old build otherwise.

### Auto-compaction actually fires now

This is the important one. Long sessions were dying on *"Model reached the maximum output token limit before completing the turn"*, and the reason was not a threshold that needed tuning — it was two parts of the system reading different numbers.

The context window reaches consumers by several routes. The wire got `num_ctx: 110000` from your provider settings; the compaction trigger was computed from a catalog-shaped 128,000 and landed at **115,200 — beyond the end of the real window**. Auto-compaction could never fire at all. Every long session ran until its per-turn output cap collapsed to nothing and the turn died.

Four changes, each of which would have been enough to notice:

- **One window.** The session resolves it once and everything reads that. A context size you set wins outright, whatever the model would allow — ask for 128k from a model that supports 512k and you get 128k. Only when you have set nothing does the model answer, and for Ollama it answers exactly: `num_ctx` is in the Modelfile and `/api/show` reports it, so a local model is no longer guessed at by a catalog that has never heard of it.
- **A trigger that leaves room to answer.** It used to ask only whether the prompt fit. A turn needs the prompt *and* its reply inside one window, so the trigger is now the smaller of the old ratio and `contextWindow − outputCap`, floored at half the window.
- **An overflow signal that does something.** When the request path found no room for a reply it logged a warning and sent the request anyway. It now forces compaction on the next turn. This one is not a projection — it is the budget arithmetic having already failed, so it holds whatever the estimates said.
- **A retry that makes room.** A turn cut off at the cap was re-prompted to be briefer, which changes nothing when the cap is small *because* the prompt took the window. It compacts first now.

Measured on the run that verified it: trigger 78,000 against a 110,000 window, compaction fired at 80,413 tokens, transcript 37 messages → 11, and the output cap held at 32,000 for every turn of the session.

### The token estimator was measuring the wrong request

The input estimator ran anywhere from 5% to 70% high, and the error was not noise — it tracked how much the model had been thinking.

The estimator measured the request it was handed. The provider then dropped all but the last reasoning block before sending it. Everything in between was counted and never transmitted. Measured on a live 43-message session, reasoning was **32%–61% of the transcript by characters**, and the share moved every turn — so the estimate ran ~5% high on a tool-heavy turn and ~45% high two turns after a long think. Two consecutive prompts 1.5% apart in characters were counted by the server as 34,361 and 23,670 tokens.

Calibration could not absorb it and hid it: pairing an inflated character count with a true token count teaches the ratio only the *average* inflation. The error always overstated the prompt, and the overstatement came straight off the output cap.

The estimate now measures what the provider will actually send, in all three places that compute one. Live, `charsPerToken` settled at 2.96–3.87 — a real tokenizer ratio, where before it drifted to 5.18 and blew past the rejection ceiling.

### A second model for vision

If your main model cannot read images, you can now nominate one that can. It sits under its own tab in the API configuration.

It replaces the primary model's vision capability entirely — not just browser screenshots, but images you paste or attach in the message box, images read from disk, and images returned by MCP tools. The primary model never receives the image; it gets a description in its place. When a description cannot be produced, the image is replaced with a note rather than handed to a model that cannot read it.

Ollama is also asked directly whether a model reads images, via `/api/show`, instead of the catalog guessing optimistically for every local model.

### API configuration profiles

Named sets of provider settings, one list shared by Plan, Act and Vision — a profile holds a provider, a model and the settings around them, none of which is specific to the tab it was saved from. API keys are stored separately and are not part of a profile.

Profiles carry the provider's own settings too, which matters more than it sounds: for Ollama, the reasoning level, the context window and every sampling parameter live outside the settings the panel used to snapshot. The bar now also shows, in red, when what is on screen differs from the profile it was loaded from.

### Steering a run no longer ends it

A message sent while the model was working was answered, and then the run stopped — because a reply with no tool call reads as "the model is done". It is not: the task it was given is still unfinished. The model now takes the work back up where it left off, unless the message told it to change course.

### Thinking streams again

Reasoning was being absorbed into tool groups and never rendered, so streaming thinking vanished depending only on whether a group happened to be open. It is never absorbed now.

### Editor

- **The read gutter no longer reaches your files.** `read_files` renders `  95 | <text>` and models paste it back. The anchored form already recovered; a range edit had no anchor and no check, so `  135 | </body>` was written into a file verbatim and reported as success. The line numbers are now the evidence: a gutter counting up from exactly `start_line` came from a read of that range.
- Whole-file rewrites are reachable when meant and refused when a range is quietly acting as one.
- Range edits show a diff preview.
- A run no longer stops on "N errors in a row" it never had — a productive turn's reset was racing the failure records and losing.

### Ollama settings

- **Thinking is one control.** The level dropdown gained a `Custom (think_budget)` entry, and the budget field moved under it. Picking any other level clears the budget, so there is only ever one answer to the question.
- `think_budget_message` is a text area that grows to fit, and its placeholder is the model's own message in full — that is the value you are deciding whether to replace.
- Sampling fields show what the model's Modelfile actually sets instead of "model default".
- The per-turn cap is sent as `num_predict`, and the prompt states the cap the server will really enforce.

### Also

- A turn that spends its tokens and delivers nothing is retried instead of ending the run.
- A model that refuses image input no longer fails the run.
- The output-budget terms are in the log message, not only in dropped structured fields — `grep "Resolved output cap"` gives the window, the estimate and the resulting cap for every request.

## [4.99.18-mann1x] — 2026-08-06

Six releases' worth of work since 4.99.12, all of it driven by watching local models fail at real tasks and fixing what the transcript blamed.

### Install

Download `cline-mann1x-4.99.18.vsix` and:

```
code --install-extension cline-mann1x-4.99.18.vsix --force
```

Reload the window afterwards — the extension host keeps the old build otherwise.

### The browser tool is back

The SDK migration cut `browser_action` but left the entire service behind — puppeteer, Chrome discovery, screenshots, console capture, five gRPC handlers, both dependencies. This reconnects it as `browser`.

It opens a page in real Chrome and reports what the console printed and what it threw, so the model can check its own work instead of asking you whether the page loads. A screenshot comes back only when the model actually accepts images. It uses your installed Chrome, so nothing is downloaded, and Chrome is not launched until the tool is first called.

Off switch: `cline.browserTool` in settings. It has its own **"Use the browser"** entry in the Auto-approve panel now, separate from "Fetch web content" — fetching a URL returns text, while this launches a process that runs whatever the page contains, and those are not the same risk.

### `list_files`

There was no tool for finding out what files exist. Models shelled out — one session's only two commands were `dir /s manic_miner.html` and `ls`. Now backed by `workspace.findFiles`, which searches the folders you opened and nothing else, honours your `files.exclude`/`search.exclude`, and refuses a path outside the workspace. The boundary is enforced in code, not requested in a prompt.

### Broken files: from description to instruction

`check_file` had two bugs that made it answer "no problems" on a file that was visibly broken: Windows drive-letter case mismatched when filtering diagnostics, and the delimiter scan was suppressed whenever the editor said nothing — which is always, for script inside an `.html`.

Then the scan itself got sharper. It used to report *"the `(` opened at 94:29 is closed by `}` at 94:289"* — true, and useless, because it never said whether to add, delete or move a bracket. A model answered by sending back the line it already had, twelve times. It now counts each line's brackets in code only and says **"this line has 1 more `}` than `{` — that is the edit"**, and where a flagged line's counts do balance it says so, which separates real breakage from collateral damage.

Browser parse errors get the same scan, since a `SyntaxError` from Chrome names no line at all.

### Loops that actually end

- A no-op edit now **fails** instead of returning `success: true` next to prose saying "do not retry". A model weighing a flag against a paragraph takes the flag.
- The loop guard counts **per call**, not per adjacency — two calls to a different line used to reset the counter and let a loop run four times longer. Only failures accrue and a success clears the tally, so re-running tests is untouched.
- `read_files` teaches a strategy rather than just quoting a cap: locate first via diagnostics, `search_codebase` or `code_intel`, then read ~30 lines around the hit.

### Also

`tools/Collect-ClineReport.ps1` now lists your sessions with the model, status, size and task for each, and lets you tick which to include. `-StripImages` drops base64 screenshots when a report is too large to send.

### Verified

core 1730 tests · vscode vitest 1203 · vscode bun unit 1064 · check-types clean · biome clean across 1217 files. Installed and smoke-tested on Windows 11 with Ollama.

## [4.99.12-mann1x] — 2026-08-05

Six fixes on top of 4.99.11, every one of them from watching a local model fail at something the tools were making it guess at. Two measured sessions: a 265-message qwen3.5 run and a 44-message Gemma-4 run.

Install: download the `.vsix` and run `code --install-extension cline-mann1x-4.99.12.vsix --force`, or use *Extensions → … → Install from VSIX*. **Reload the window afterwards** — the running extension host keeps the old build until you do.

### How long is this file?

There was no way to ask. `read_files` reported a line count only when it had truncated the read; a ranged read stopped at `end_line` and never learned the file's length. One session spent five consecutive shell commands trying to find out — `wc -l` (not a Windows command), `type | find`, and three spellings of `(Get-Content).Count`.

Every read now ends with the length: `[137 lines, shown in full.]` or `[Lines 84-100 of 137.]`.

And `end_line: 9999` — sent twice as the only way that model had to say "to the end of the file" — now clamps to the last line instead of being rejected.

### Missing arguments say so

Sending `editor` without `path` used to produce:

```
✖ Invalid input: expected string, received undefined
  → at path
```

which names the field only as the tail of a type complaint and never says an argument is required. It now says `Missing required argument \`path\`. Send it and call again.` This is in `validateWithZod`, so it covers every tool.

The advice that led there is fixed too. The 4.99.11 message told a model to rewrite a file by sending "the same `new_text` with `start_line: 1` and `end_line: 136`" — and Gemma rebuilt the call from that sentence rather than amending its own, dropping `path` three times in a row. A message that lists some of a call's arguments gets read as listing all of them, so it now spells out every one.

### The bracket the parse error cannot name

A language server reports a parse error where the parser gave up — the closing bracket, never the opening one it failed to match. The question worth answering is the one it structurally cannot answer.

In one session, **23 of 29 shell commands were a brace-counting script the model wrote itself**. It then declared the last two errors "parser artifacts from the very long single-line JavaScript content" and stopped. They were not artifacts — `node --check` fails on that file. `check_file` now appends:

```
Delimiter scan:
  the `{` opened at line 98, column 2352 is closed by `)` at line 98, column 2707
  the `(` opened at line 98, column 2348 is closed by `}` at line 98, column 3744
```

The scan skips strings, comments, regex and template literals — the whole difference between it and counting characters. Its language list is deliberately narrow: JSX is excluded, because over 365 known-good `.tsx` files it produced 49 confident and wrong reports, and a false report sends a model to edit a line that was correct. Verified: 1200 known-good files report nothing; the one broken file reports the two crossings above.

### The word "LSP"

A session called an MCP server's `lsp__restart_server` while `code_intel` sat unused — not preferring it for symbol queries, but wanting to restart a language server because it believed the diagnostics were stale. They were not: the error count moved 10 → 8 → 18 → 17 → 15 → 6 across the session, tracking its edits the whole way.

`code_intel` now says it **is** the LSP, for a model searching for that word against a tool literally named `lsp__*`. `check_file` states that its results are live and that there is nothing to restart.

### Also in this download

`Collect-ClineReport.ps1` — for a tester to send a session back for analysis. Run it with no arguments; it collects the newest session's transcript, the Cline output log (which lives four directories deep in `%APPDATA%\Code\logs` and nobody ever finds), a machine description, and settings with credential-shaped fields redacted, into one zip on the Desktop. The README inside states plainly that the transcript contains the contents of every file the model read.

Detail and measurements are in PRs #6 through #35.

## [4.99.11-mann1x] — 2026-08-05

Everything here came out of watching a local qwen3.5 build work on one minified HTML file across four measured sessions. The pattern in every one: the model was not out of ideas, it was reaching for something the tools could not express, and falling back to PowerShell.

Install: download the `.vsix` and run `code --install-extension cline-mann1x-4.99.11.vsix --force`, or use *Extensions → … → Install from VSIX*.

### The editor can say where

- **Line ranges.** `start_line`/`end_line` replace a region outright with no match string. On minified and generated files "the text" is not something a model can retype — a 293-character line copied out of a numbered read came back with the `92 | ` gutter attached and failed to match.
- **Columns.** `start_column`/`end_column` replace characters, and `insert_column` inserts inside a line. This is the unit a diagnostic speaks in (`Line 108, column 385`), and on a 500-character minified line it is the only edit that leaves the rest alone.
- **`occurrence` and `replace_all`** for a match that appears more than once; an ambiguous match now reports the line each occurrence sits on.
- **No-op edits are reported as such.** 19 of 62 successful edits in one session had changed nothing and returned an empty diff, which read as failure and drove retry loops. They now say `No change: line 108 already reads exactly this way … do not retry this edit`.
- **A whole-file write is no longer refused.** It used to be told to "split the edit into smaller tool calls", which a create cannot do. The edit-size limit is also its own number now (16,000) rather than sharing the shell command's 6,000.

### Reading and diagnosing

- **`check_file`** answers "is this file broken?" from the IDE's own language servers, and **`code_intel`** exposes go-to-definition, references and workspace symbols.
- **Diagnostics carry their column**, and when a parse error cascades, the list is prefixed with the structural error that caused it. One unclosed brace produced seventeen errors, sixteen of them noise, with the real one reported last — the model spent many turns editing lines that were never wrong.
- **`read_files` takes `line_numbers: false`**, so text can be copied out of a read and into an edit, and now accepts a path field that carries a bracketed list instead of ENOENT-ing on it.
- **`search_codebase` takes `context_lines` and `max_per_file`.** `--max-count=1` was hard-coded, so "find every call site" reported one and the model went back to grep.

### Context and turns

- **Per-result cap raised to 32k**, configurable in Settings along with a per-turn output-token cap (`num_predict`), both under the Ollama provider.
- **Truncation markers say who truncated and why**, so a gap in a tool result is not read as a gap in the file.
- **A finished turn ends as finished.** A recovered mid-turn error used to leave the task stuck on Retry with the composer disabled; and the "you didn't call a tool" nudge no longer asks a model that has already answered to answer again.

### Prompt templates

A template per model family — claude, qwen, gemma, glm, kimi, deepseek — each written by that model given the prompt it actually receives, with a coverage audit that fails if a tool goes undocumented.

Full detail, with the measurements behind each change, is in PRs #6 through #34.

## [4.99.8-mann1x] — 2026-08-04

A build of Cline 4.1.3 carrying the patches from `v4.99.3-mann1x` plus five more, all aimed at running local models — Ollama in particular — where the stock build mismeasures context, hides feedback the model needs, or ends a run with the work undone.

Versioned `4.99.8` rather than `4.1.3` on purpose: it keeps upstream's extension ID, so your settings, provider config and task history carry over untouched, while sitting above anything upstream will publish for a long time — so auto-update has nothing to offer and cannot silently swap this build back for the marketplace one. The Extensions panel shows it as **Cline (mann1x build)**.

### Install

Download `cline-mann1x-4.99.8.vsix`, then either:

```
code --install-extension cline-mann1x-4.99.8.vsix --force
```

or, in VS Code: Extensions panel → `···` menu → **Install from VSIX…**

Opening the `.vsix` from the file manager does not work — Windows hands that extension to Visual Studio, which is a different product. Reload the window afterwards: the extension host keeps the old build loaded until you do.

To go back to stock: `code --uninstall-extension saoudrizwan.claude-dev`, then reinstall Cline from the marketplace. Task history survives either direction.

### New since 4.99.3

**The output cap that starved itself.** A request's output limit is `contextWindow − estimatedInputTokens − reserve`: a difference of two large numbers, so it carries the estimate's error magnified. Two things made that error uncorrectable. The calibration rejected any measurement above 8 characters per token as broken — but `measureRequestInputChars` counts serialized JSON, where quotes, braces and escapes are characters and rarely tokens, and a large-vocabulary tokenizer runs well past that: Gemma-4 counted 78,138 prompt tokens for 645,803 serialized characters, a ratio of 8.26. Every observation in the session was thrown away, the ratio stayed frozen at a stale 5.07, and the estimate ran 1.7× high. Measured live, the cap walked down 14,695 → 13,221 → 9,828 → … → **60 tokens** over ten turns while the transcript was only 78k of a 128k window. With Ollama it is worse than useless: an effort-level thinking budget is a share of `num_predict`, so the budget came out at 15 tokens, the forced end-of-thinking sequence spliced into a tool call the model had already begun, and the turn died on `expected '{' in tool call` — reported to the user as reaching the output limit. The ceiling now clears what serialized requests actually measure, the provider's token count is kept even when the ratio is rejected (it was freezing the compaction trigger fourteen turns behind), and a remaining-context term below 1,024 tokens is dropped rather than sent.

**Sampling controls for Ollama.** Every parameter the Ollama API accepts, by its wire name, in a collapsed **Advanced** section on the provider: `temperature`, `top_k`, `top_p`, `min_p`, `typical_p`, `repeat_last_n`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`, `seed`, `num_predict`, `num_keep`, `stop`, `think_budget`, `think_budget_message`. Blank means not sent, so the model's own defaults stand. They are merged last on the request, which means an explicit `num_predict` overrides whatever the context arithmetic above would have computed.

**Resume no longer throws the transcript away.** A resumed session starts with no calibration, so the estimator falls back to three characters per token against a measured ~6 for real transcript content. Measured on two consecutive resumes: 237,977 and 261,494 estimated tokens against a 115,200 trigger — both compacted immediately, while the same session had reported 108,099 and 72,995 actual tokens minutes earlier in the previous process. The measurement is already in the transcript, in what the provider counted for turns that already ran; it is now read back before the first request.

**Tasks that would only offer "Resume".** A session's row keeps the pid of the process that owns it, and the reconciler marks a session dead when that pid is gone. Resume never updated it, so every `listSessions` killed the live session it had just started — four sessions in `sessions.db`, all `failed`, each with a dead pid. A non-terminal status write now claims ownership.

**Linter feedback the model never saw.** After an `editor` or `apply_patch` call, the diagnostics VS Code publishes for the files that call touched are diffed against the ones it had before, and anything the edit *introduced* is appended to the tool result — errors and warnings only, capped at 20 per file, and only for files an editor can actually parse (a `.mp3` produces nothing useful to a model). Includes the markdown a state summary is written in, which is where broken formatting usually goes unnoticed.

**The retry nudge is no longer part of the conversation.** The synthetic "your last message contained no tool calls" prompt is now hidden from the visible transcript, where it read as something you had typed.

### From 4.99.3

Context accounting calibrated from what the provider counted; the compaction trigger measuring the request that actually goes out; compaction that could only ever run once per typed prompt; a deterministic fallback when agentic compaction returns nothing; reasoning intent forwarded to the AI SDK with a level when none was named; prior reasoning carried in `thinking` rather than folded into `content`; the `read_files` paging loop that returned empty successes forever; runs that ended with the work undone; and the output cap stated in the system prompt.

### Verifying which build is loaded

```
code --list-extensions --show-versions | findstr claude-dev
```

should report `saoudrizwan.claude-dev@4.99.8`.

## [4.99.3-mann1x] — 2026-08-04

A build of Cline 4.1.3 carrying nine patches aimed at running local models — Ollama in particular — where the stock build mismeasures context, stops compacting, or ends a run with the work undone.

Versioned `4.99.3` rather than `4.1.3` on purpose: it keeps upstream's extension ID, so your settings, provider config and task history carry over untouched, while sitting above anything upstream will publish for a long time — so auto-update has nothing to offer and cannot silently swap this build back for the marketplace one. The Extensions panel shows it as **Cline (mann1x build)**.

### Install

Download `cline-mann1x-4.99.3.vsix`, then either:

```
code --install-extension cline-mann1x-4.99.3.vsix --force
```

or, in VS Code: Extensions panel → `···` menu → **Install from VSIX…**

Opening the `.vsix` from the file manager does not work — Windows hands that extension to Visual Studio, which is a different product.

To go back to stock: `code --uninstall-extension saoudrizwan.claude-dev`, then reinstall Cline from the marketplace. Task history survives either direction.

### What's in it

**Context accounting.** The token estimator is a constant — JSON characters over three, the same divisor for prose, code and base64 — and every downstream decision rides on it. Ollama already returns `prompt_eval_count` on every response and the provider already maps it into `usage.inputTokens`; nothing read it back. It now calibrates the divisor from what the provider actually counted.

**The compaction trigger.** It measured `apiMessages`, which is not the request that goes out. Measured live it ran ~5× the real body — 803,588 characters against 163,772 bytes — and the opposite way once a compaction state exists. It now triggers on the size the provider reported.

**Compaction that stopped working.** After the first pass the transcript reads `[summary, typed prompt, ...tool loop]`, so the prompt sits at index 1 and the prompt-preservation cap pinned the cut there — folding only the summary, which is no progress. An agentic run driven by one typed prompt could be compacted exactly once. Observed: seven consecutive turns with `shouldCompact: true` and no summarizer request, 122 → 134 messages, usable output budget falling 26,538 → 1,232 tokens, turn lost to "Model reached the maximum output token limit". The cut now moves past the prompt and pins it instead, folding at least half of what follows. A ratio rather than a token count, because every absolute threshold here is only as good as the estimator feeding it.

**A fallback when compaction declines.** Agentic compaction needs a working model request to succeed at exactly the moment the context is fullest. When it returns nothing, the deterministic basic strategy now runs instead of skipping.

**Reasoning.** The request's reasoning intent is forwarded to the AI SDK, and a request that asks for reasoning without naming a level gets `medium` on Ollama — the provider whose wire format has a boolean `think` and therefore has to say what a bare "on" means.

**Prior reasoning in the right field.** `ai-sdk-ollama` folds an assistant turn's reasoning into `content`, so every earlier turn's deliberation comes back as something the model said out loud, and renderers show it as answer text. Carried as a bun patch: the defect is in the dependency, and the real home is a PR there. Sending it in `thinking` also leaves retention to the chat template, which is where a model-dependent decision belongs.

**The `read_files` paging loop.** A range starting past EOF returns `{ result: "", success: true }`, which to a model reads as "nothing here yet, try again" — measured as 15 identical calls in a row that no instruction or output budget broke. An empty successful read now says what the emptiness means.

**Runs that ended with the work undone.** A turn with no tool calls ends the run, which fails on models that announce a plan and stop. Measured on gemma4: 7 of 7 replays of one captured request returned text and no tool call. Opt-in at the SDK layer (`completionPolicy.maxNoToolCallNudges`, default off — the contract is deliberate); Cline's own runtime builder opts in at 2, and the counter resets on any turn that does call tools.

**The output cap the model was never told about.** Every request carries a `maxOutputTokens` the provider truncates at, and nothing in the system prompt mentioned it. When no override exists that value is 32,000 — on a 32,768-token model, the entire context window. The prompt now states the cap, and hands back 75% when the cap is effectively the whole window.

### Verifying which build is loaded

Extensions panel shows **Cline (mann1x build)** v4.99.3. From a running session, View → Output → **Cline** logs a line stock has no string for:

```
LOG [SessionFactory] Output budget: cap=32000 contextWindow=65536
```

### Caveats

Test builds, not endorsed by or affiliated with Cline. Each patch is on its own branch for review; `mann1x/integration` is all nine merged. Upstream PRs will follow per the contributing guidelines once these have had real use.
