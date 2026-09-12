# Prompt templates: architecture, sources, and regeneration

How the text a model actually receives is assembled, where every piece of it
comes from, and what to run when you want to change it.

This document exists because the question *"where does this sentence in the
prompt come from?"* took most of a night to answer from the code and the git
history. Everything that cost time is written down here.

> **Do not put this file in `assets/prompt-templates/`.** The loader reads every
> `*.md` in that directory as a template.

---

## 0. The nineteen things that are easy to get wrong

| | |
|---|---|
| **`default.md` is generated, not authored.** | It is a verbatim mirror of `DEFAULT_CLINE_SYSTEM_PROMPT` plus every built-in tool description. A test fails if it drifts. Editing it to change what a model sees does nothing except break CI. |
| **The `# system` section REPLACES. It does not wrap.** | `{{DEFAULT}}` works in `# tool:` sections only. A family template's system text is the *entire* system prompt for that family — `default.md`'s system text is never appended, prepended, or merged. |
| **Every family already overrides `system`.** | All six family templates ship a full `# system` section, so nothing inherits `default.md`'s system text in practice. "Add it to the base layer so everyone gets it" does not work. |
| **The ideas in a template are ours; the prose is the model's.** | The four numbered failures and the long-horizon framing live in `PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS` and are injected into every generation. A model restates them in its own words, so they read as if the model invented them. Provenance headers name the model that wrote the *wording*. |
| **A family string changes between model generations.** | It is stable across quant, tag and rename of *one* model — not across releases. `glm5.2` became `glm_dsa_moe`; `deepseek4` became `deepseek_v41`. Both templates silently stopped claiming their own family and those sessions fell back to `default.md` with nothing reporting it. Match the family broadly (`glm*`), not the generation (`glm5*`). |
| **The generator and the app read the *bundle*, not the `.md` files.** | `getBuiltinPromptTemplates()` imports `builtin-templates.generated.ts`. Editing a template without running `generate-builtin-templates.mts` changes nothing anywhere. |
| **A rule with no audit gate is not a rule.** | Guidance in the instructions is a suggestion the model may decline. Of four rules folded in on 2026-09-11, only the gated one landed reliably. Add the gate in the same change — see §9. |
| **A model will hand `default.md` back to you.** | `deepseek-v4.1-flash` returned the base layer's system section byte-for-byte (4,253 == 4,253) and audited *clean*, because the no-verbatim-copy rule only ever covered `# tool:` sections. Anything that must hold for the system section needs its own check. |
| **Two shipped templates carried the forbidden completion rule for a month.** | `kimi.md` and `deepseek.md` both said *"Response without tool calls will considered as completed with final answer"* — inherited from the base lineage, never rewritten, and invisible until a rule was written to look for it. |
| **Never exclude a family before its replacement template exists.** | Adding `"!*moe*"` to `qwen.md` with no MoE template drops every a3b/ornith session to `default.md` — no long-horizon framing, no Critical Rules, no warning. Land the exclusion and the new template in one change. |
| **The inferred family stem truncates at the first non-alphanumeric character.** | `kimi-k2` and `kimi-k3` both infer `kimi*`, so the generator cannot propose a generational split on its own — it will hand both generations the same pattern. Use `--match-family 'kimi-k3*' --name kimi-k3`. The same truncation is why `nemotron-3-nano` infers `nemotron*`. |
| **An override only reached the from-scratch branch.** | If a family template already claims the model, the generator takes the "rewrite this template" path, where the standing instruction is *leave the `match:` block exactly as it is* — and the model obeyed that instead. `--match-model '*kimi-k3*'` returned `family: [kimi*]` with nothing reporting the flag had done nothing. Both branches honour it now, and the audit fails if a stated match does not arrive. |
| **A provenance header inside a model's reply is inherited, not observed.** | The model is shown its current template, header and all, and copies it. `deepseek.md` came back naming `deepseek-v4-flash`/`deepseek4` when it was written by `deepseek-v4.1-flash` against family `deepseek_v41`. The generator now strips any model-written header and stamps its own — model, family, run dir, and both samplers. Never trust a header a model handed you. |
| **`prompt-reviews/` has a layout, and it is load-bearing.** | Root = the current set, one file per family, named for the family — the parser falls back to the filename for a template's name. Runs go to `regen/<stamp>-<model>/` with their log; backups go to `archive/`. Rules in `prompt-reviews/README.md`. |
| **Specificity now ranks patterns, not just dimensions.** | `qwen*moe*` (7 literal chars) beats `qwen*` (4) inside the `family` dimension, so a generic family template and a narrower one per generation/architecture can coexist. Order no longer decides. A `model:` match still beats any `family:` match, however narrow. |
| **A params overlay reports no family, and is then handed `default.md`.** | `/api/show` answers `family: ""` for a model built `FROM` a cloud tag, so routing resolves to `default` and the model is asked to improve *the base prompt* rather than its own family's template. `glm` was seeded this way on every attempt across two days and never produced a parsable file, with `family=unknown template=default` in each run log. Pass `--family <what the cloud tag reports>`. The run log says `(declared; /api/show reported none)` when you have. |
| **`think: false` is a request, and a model may answer it by not *separating* its reasoning.** | The generator disables thinking because a reasoning model otherwise spends the whole budget on it. glm-5.3 complies by writing the reasoning into `content` instead. Same prompt, same sampler: thinking on → `thinking` 2,978 chars / `content` 46 chars, exactly the template; thinking off → `thinking` 0 / `content` 1,598 chars, all of it reasoning. That is what "does not parse: no '# system' or '# tool:' section" meant. Use `--think`, and raise `--timeout` with it. |
| **The audit only read `# system` until 2026-09-12.** | The batch-edits ban was enforced against model proposals and against that section only, so nine of the ten shipped templates carried the rule in `# tool: editor` while reporting clean. A model reads a tool description in the same request as the system prompt. `findBatchedEditRules()` now runs over both, and `builtin-templates.test.ts` runs it over what ships. |
| **A rule can reach every template from code, not from a template.** | The batch-edits rule was in `DEFAULT_CLINE_SYSTEM_PROMPT`, `YOLO_CLINE_SYSTEM_PROMPT` and the `editor` and `run_commands` tool descriptions. `default.md` mirrors all of those verbatim, and every other template is regenerated from `default.md`, so fixing the templates alone fixes nothing that lasts. Fix the code, re-sync `default.md`, then regenerate. |
| **Keep the generic pattern when you add a narrow one.** | `kimi*` + `kimi-k3*` means an unreleased `kimi-k4` lands on `kimi.md`. `kimi-k2*` + `kimi-k3*` means it falls silently to `default.md` — the `glm5*` / `deepseek4*` failure again. The fallback rung is the point of the ladder. |

---

## 1. The chain: where the text comes from

```
sdk/packages/shared/src/prompt/system.ts
  DEFAULT_CLINE_SYSTEM_PROMPT            <-- UPSTREAM Cline's prompt text
            |                                 (written for frontier models;
            |                                  the reason family templates exist)
            v
assets/prompt-templates/default.md       <-- GENERATED mirror. Read-only in practice.
            |                                 system text + all 31 tool descriptions,
            |                                 verbatim. Guarded by a drift test.
            v
assets/prompt-templates/<family>.md      <-- WRITTEN BY THE MODEL ITSELF,
            |                                 seeded with default.md + the previous
            |                                 template + our failure catalogue.
            v
   (occasional hand edits)               <-- audited with audit-prompt-template.mts
            |
            v
builtin-templates.generated.ts           <-- GENERATED bundle that actually ships
```

### File ownership

| Path | Owner | Safe to edit by hand? |
|---|---|---|
| `shared/src/prompt/system.ts` | **Upstream Cline** (PRs #10734, #11514, #11598) | Avoid — conflicts on every rebase, and it ships to all providers |
| `shared/src/prompt/template-types.ts` | **Ours** (`f07eea894`) | Yes |
| `core/assets/prompt-templates/default.md` | Generated | **No** — run `sync-default-template.mts` |
| `core/assets/prompt-templates/<family>.md` | Model-written | Yes, but audit afterwards (see §7) |
| `core/src/extensions/config/prompt-template-review.ts` | **Ours** | Yes — this is where shared guidance belongs |
| `core/src/extensions/config/builtin-templates.generated.ts` | Generated | **No** — run `generate-builtin-templates.mts` |

---

## 2. Template file format

```markdown
---
name: qwen
match:
  family: [qwen*, "!*moe*"]
---

<!-- provenance comment: which model wrote this, and why the match is what it is -->

# system
...the entire system prompt for this family...
{{CLINE_RULES}}
{{CLINE_METADATA}}

# tool: read_files
...own words...
{{DEFAULT}}

# tool: team_status
{{DEFAULT}}
```

* `match:` accepts `provider:`, `family:`, `model:` — each a list of globs.
* A pattern prefixed `!` **excludes**. Any negative match disqualifies the
  template outright. A template with only negative patterns matches everything
  else.
* `family` is the **GGUF architecture string**, stable across quant, tag and
  rename. Prefer it over `model:` unless you deliberately want one model.
* A section named for a tool that does not exist is an audit failure.
* Placeholders must survive verbatim: `{{PLATFORM_NAME}}`, `{{CURRENT_DATE}}`,
  `{{IDE_NAME}}`, `{{CWD}}`, `{{CLINE_RULES}}`, `{{CLINE_METADATA}}`,
  `{{DEFAULT}}`.

---

## 3. Resolution: which template wins

Three keys, in order: **the dimension named** (`model` 3 > `family` 2 >
`provider` 1 > `default` 0), then **how narrowly that dimension's pattern claims
this session** (literal non-wildcard characters in the matched pattern; an exact
pattern gets +1), then **source rank** (workspace > global > builtin).

The middle key is what makes a fallback ladder work, and it was added on
2026-09-11. Before it, two patterns claiming one value tied and the winner was
whichever the template array listed first — measured: `[qwen, qwen-moe]` routed
a `qwen35moe` session to `qwen`, and the same two reversed routed it to
`qwen-moe`. Exclusions (`"!*moe*"`) existed to work around that and are still
the only way to say a value is *not claimed at all*, which narrowness cannot
express.

`resolvePromptTemplate()` in `shared/src/prompt/template-types.ts`.

```ts
PROMPT_TEMPLATE_SPECIFICITY = { default: 0, provider: 1, family: 2, model: 3 }
```

1. Score each candidate by the **most specific dimension it matched on** — not
   by how specific the glob is.
2. Highest score wins.
3. Tie → `SOURCE_RANK` (workspace beats global beats builtin).
4. Still tied → **array order**. This is why two family patterns that both match
   are a latent bug.

**Load order / sources**, lowest to highest rank:

| Source | Path |
|---|---|
| `builtin` | shipped in `builtin-templates.generated.ts` |
| `global` | `<cline data dir>/templates/` |
| `workspace` | `<workspace>/.clinerules/templates/` |

A template named `default` **replaces the base layer** rather than layering on
top of it.

---

## 4. Layering: replace vs wrap

This is the single most misunderstood part.

| Section | Behaviour | Marker support |
|---|---|---|
| `# system` | `matched.system ?? base.system` — **wholesale replacement** | **none** |
| `# tool: X` | `applyPromptTemplateToTools()` splices | **`{{DEFAULT}}`** |

`{{DEFAULT}}` in a tool section expands to that tool's built-in description at
runtime. Two tools **must** keep it:

* `run_commands` — its description is composed against the detected shell.
* `skills` — it appends the skills installed on that machine.

Replace either outright and you freeze one host's answer into every host's
prompt, silently.

### Why `{{DEFAULT}}` is deliberately *not* supported for `# system`

`default.md` mirrors upstream's prompt, which contains:

> *"Response without tool calls will considered as completed with final answer."*

Our generator instructions explicitly tell every model **not** to write a rule
like that — it buys one wasted tool call on every finished task. A wrapping
marker for `system` would make it easy to splice that line back in by accident.
Tool descriptions need the marker because they are host-computed; nothing in the
system prompt is.

**If you want shared system-prompt material across families, put it in
`PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS` and regenerate.** That is the mechanism —
see §6.

---

## 5. The runtime hook point

`createPromptTemplateHooks()` in `prompt-template-hooks.ts`, wired as an
`AgentHooks.beforeModel`.

* Resolution happens **once**, at session start, via `renderPromptTemplate()`.
  The hook only carries the answer.
* The rewritten tool list is **memoised** against the list it was built from, so
  a fifty-turn conversation does the work once.
* `beforeModel` is the seam because it is the only place that sees *every* tool:
  built-ins from core, MCP tools from a hub, and host-injected VS Code tools all
  converge on `request.tools`.
* It reports once per session which tools the template actually changed
  ("2 of 3 … `editor`, `read_files`"), including the silent-drop case
  ("0 of 1 … kept its built-in text").

---

## 6. The generator: how a template is written

`review-prompt-templates.mts` → `generatePromptTemplate()` in
`prompt-template-review.ts`.

### What the model is handed

1. **`default.md`** — labelled *"the base layer, which supplies anything your
   template omits"*.
2. **The family template that claims it today** — labelled *"the template you are
   given today, layered over the base"*. If nothing claims the model, it gets
   the base layer plus *"No template claims you today … Write the template that
   should claim you"*, with its own identifiers filled into a `match:` block so
   it cannot invent a shape that fails to parse.
3. **`PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS`** — **ours**, and the important part:
   * **The four observed failures**, numbered. This is why templates contain
     headings like `## Critical Rules: Tool Selection (Prevent Failure #1 & #4)`
     — they cite *our* list:
     1. Shelling out for file work (`cat`, `sed -i`, `grep`).
     2. Serialising independent work across turns.
     3. Announcing an intention instead of acting; claiming completion without
        reading back.
     4. Answering a symbol question with a text search.
   * **The long-horizon framing** — *"Do not treat 'I have stopped emitting tool
     calls' as 'the work is done'"*. Qwen's one-line "Horizon Rule" is a
     compression of this sentence.
   * **Four measured rules** folded in from harness findings: checker and run in
     the same turn; a tool's report outranks your own re-derivation; run the
     program last; do not re-read a file to confirm your own edit.
   * **Hard constraints** — placeholders, tool coverage, the eight tools that
     must be written in the model's own words, `{{DEFAULT}}` rules, no verbatim
     copies, leave `match:` alone.

### Repair loop

Up to `DEFAULT_ATTEMPTS` (3) passes: the proposal is audited and any failures are
handed back to the model. *"A model that cannot fix a duplicated heading on the
second try is not going to."*

### Output

Proposals are written to `prompt-reviews/` (gitignored). **Nothing is ever copied
into `assets/` automatically — that stays a human decision.**

---

## 7. Runbook

### Prerequisites: cloud auth

The generator runs against Ollama **cloud** models. The dev server
(`./build/ollama serve`, port 11439) runs as root and presents `/root/.ollama/
id_ed25519`, which is *not* the registered key. The registered key belongs to
the system ollama user:

```bash
# symptom: /api/chat returns 401
md5sum /usr/share/ollama/.ollama/id_ed25519   # the registered one
md5sum /root/.ollama/id_ed25519               # what the dev server presents

cp -a /usr/share/ollama/.ollama/id_ed25519{,.pub} /root/.ollama/
chmod 600 /root/.ollama/id_ed25519
```

The key is read **per request** — no restart needed. A spare copy of the
registered pair is staged at `spool/ollama-dev-home/.ollama/`.

A **404** from `/api/chat` means the cloud tag moved; fix `REVIEW_MODELS`.

### When a cloud model cannot produce a template: build a local overlay

A cloud tag runs at the publisher's defaults, and those defaults are tuned for
chat, not for emitting a 34-section, ~20 KB document in one response. Two
failure modes come from that, and both look like the model is incapable when it
is not:

| symptom | cause | parameter |
|---|---|---|
| `does not parse: no '# system' or '# tool:' section`; output of 42 or 149 bytes | the response was **truncated** — the front arrived, the rest did not | `num_predict` |
| `'tool: X' appears more than once` ×90; sections repeated | **degeneration** — the model looped | `repeat_last_n`, `repeat_penalty`, `frequency_penalty`, `presence_penalty` |

An overlay is a params-only model built `FROM` the cloud tag. It carries no
weights, builds instantly, and costs nothing on disk:

```bash
curl -s $OLLAMA_HOST/api/create -d '{
  "model":"glm-5.3-tpl:latest",
  "from":"glm-5.3:cloud",
  "parameters":{
    "num_predict":131072, "num_ctx":262144,
    "temperature":1, "top_p":0.95,
    "repeat_last_n":2048, "repeat_penalty":1.1,
    "frequency_penalty":0.1, "presence_penalty":0.1
  },
  "stream":false}'
```

Then generate against the overlay instead of the cloud tag:

```bash
bun scripts/review-prompt-templates.mts --model glm-5.3-tpl:latest
```

Notes from doing this:

- **The values came from a published overlay**, `igovet/glm-5.2-opencode` — a
  159-byte params layer with `num_predict 131072` and `num_ctx 1048576`. Its
  sibling `igovet/minimax-m3-opencode` turned `minimax-m3` from 149 bytes of
  garbage into a 23.8 KB template that failed only on content.
- **`num_predict` is capped per model.** `nemotron-3-super` refuses anything
  above 65536: *"max_tokens (131072) exceeds model's maximum output tokens"*.
  Read the error and lower it; it names the ceiling.
- **An overlay reports no family** (`family=None`), so nothing claims it and the
  generator hands it `default.md` with the "no template claims you" branch. That
  is correct for a genuinely new family. For a family that already has a
  template, generate from the **cloud tag** if it works, and use the overlay only
  when it does not — otherwise the model is handed the wrong base.
- **The `match:` block a model writes from an overlay cannot key on family.**
  Use `model: ["*minimax*"]`, which scores 3 and beats family anyway (§3).

**glm took three separate fixes and is worth writing down in full.** It failed
on 2026-09-11 and twice on 2026-09-12, each time with the same unhelpful
message, and each time for a different reason:

1. **Wrong seed.** The overlay reports no family, so it was handed `default.md`.
   Fixed by `--family glm_dsa_moe`.
2. **Reasoning in `content`.** With thinking off the file was prose, not a
   template. Fixed by `--think`.
3. **Wall time.** `glm-5.3-tpl:latest` with `--think` then timed out at 3,000 s —
   reasoning 65× the length of its own output, against a 76 KB prompt asking for
   a 20 KB document. Fixed by moving to the **flash** tag.

`glm-5.3-flash-tpl2:latest` is the same overlay recipe (`FROM glm-5.3-flash:cloud`
with `num_predict 131072`, `num_ctx 262144`, `repeat_last_n 2048`,
`repeat_penalty 1.1`, `temperature 1`, `top_p 0.95`, both penalties `0.1`) and it
came back clean on attempt 1. Note the family differs from the non-flash tag:
`glm-5.3-flash:cloud` reports `glm5_next`, not `glm_dsa_moe`. Both match
`glm*`; declare whichever the tag you actually call reports.

### The four overrides, and when each is needed

`--model` alone is right for a cloud tag that reports its own family and answers
without reasoning. Everything else needs one or more of these.

| flag | needed when | symptom without it |
|---|---|---|
| `--family <name>` | the tag reports no family — every params overlay | seeded from `default.md`; run log says `family=unknown template=default` |
| `--think` | the model writes its reasoning into `content` when thinking is off | `does not parse: no '# system' or '# tool: <name>' section`, and the file is prose |
| `--name <template>` | the written file must keep a name the model would not infer | the proposal is named after the overlay tag |
| `--match-family` / `--match-model` | **creating** a split, or an overlay whose own name is scaffolding | the match block claims the wrong thing, or claims nothing |

Two of these are recent and neither is guessable from a failure message:

**`--family`.** A params overlay built `FROM` a cloud tag carries no weights, so
`/api/show` answers `family: ""`. Routing then resolves to `default`, and the
model is handed the base prompt to improve instead of its own family's template.
Pass what the *cloud* tag reports — `/api/show` on `glm-5.3:cloud` says
`glm_dsa_moe`, on `nemotron-3-super:cloud` `nemotron_h_moe`. The provenance
header and the run log both record that the family was declared rather than
measured, because a reader has to be able to tell those apart.

**`--think`.** Reasoning is disabled by default and that is right for most
models — a one-shot transform is not a problem to reason about, and
`deepseek-v4-flash` takes forty minutes with it on against two with it off. But
`think: false` is a request. glm-5.3 answers it by not *separating* the
reasoning, and the prose lands in `content` where the template should be:

```
think on   thinking 2,978 chars   content 46 chars, exactly the template asked for
think off  thinking 0             content 1,598 chars, all of it reasoning
```

Reproduced on a neutral prompt (a heading and one bullet) and on the bare
`glm-5.3:cloud` with no overlay, so it is the model, not the prompt and not the
Modelfile. A tell, when it happens: the leaked content ends in a truncated
`</thin` — the model emits its own thinking tags and nothing strips them.

### Regenerate one family

```bash
cd sdk/packages/core
OLLAMA_HOST=http://localhost:11439 \
  bun scripts/review-prompt-templates.mts --model qwen3.5:397b-cloud
```

### Regenerate every family

```bash
# Back up the shipped set first: the reason to keep it is the case where the
# new templates turn out to be worse.
cp -r assets/prompt-templates \
  ../../../prompt-reviews/archive/templates-backup-$(date +%Y%m%d-%H%M)

OLLAMA_HOST=http://localhost:11439 \
  bun scripts/review-prompt-templates.mts --all
```

No `--out` and no shell redirection. The script writes one directory per model
per run — `prompt-reviews/regen/<YYYYMMDD-HHMM>-<model>/` holding that model's
`.md` and its `run.log` — and copies nothing anywhere. `--out` moves the regen
*root*, not the file. The layout and the reasons are in
[`prompt-reviews/README.md`](../../../../../../prompt-reviews/README.md).

### Install a proposal

```bash
# 1. read it, diff it against the current template, keep what is better
# 2. copy into assets/
#    promoting it to the current set is a copy into the root, named for the
#    family, recorded in README.md's provenance table:
cp prompt-reviews/regen/<stamp>-qwen3.5-397b-cloud/qwen3.5-397b-cloud.md \
   prompt-reviews/qwen.md
#    ...and shipping it is a second, separate copy:
cp prompt-reviews/qwen.md \
   sdk/packages/core/assets/prompt-templates/qwen.md
# 3. re-audit
bun scripts/audit-prompt-template.mts assets/prompt-templates/qwen.md --family qwen3.5
# 4. rebuild the shipped bundle  <-- FORGETTING THIS SHIPS THE OLD TEMPLATE
bun scripts/generate-builtin-templates.mts
```

### Split a family across generations

A family string is stable across quant, tag and rename of one model but not
across releases, and the inferred stem cannot see the difference — `kimi-k2` and
`kimi-k3` both infer `kimi*`. State the block instead:

```bash
# the new generation gets its own template and its own name
OLLAMA_HOST=http://localhost:11439 \
  npx tsx scripts/review-prompt-templates.mts --model kimi-k3:cloud \
    --match-family 'kimi-k3*' --name kimi-k3 --attempts 4
```

That recipe **creates** the split. Once `kimi-k3.md` exists and claims the
model, regenerating it is a plain `--model kimi-k3:cloud` — routing resolves
`family=kimi-k3` to `template=kimi-k3` on its own, and the flags above would
only restate what the file already says. Check the run log line before assuming
either way: it prints `family=<x> template=<y>`, and that is the only thing that
says which template was actually seeded.

Then narrow the template being split *away from*, by hand, and rename its file
to its family: `kimi.md` (`family: [kimi*]`) became `kimi-k2.md`
(`family: [kimi-k2*]`). Both patterns score 2 on the family dimension, so they
must not overlap — a template left at `kimi*` alongside one at `kimi-k3*` is a
tie resolved by source rank and array order, i.e. by luck (§3).

**Keep the generic pattern as the bottom rung.** Pattern specificity ranks
`kimi-k3*` (7 literal characters) above `kimi*` (4) inside the `family`
dimension, so both can ship:

| template | match | claims |
|---|---|---|
| `kimi.md` | `family: [kimi*]` | every kimi, including generations not yet released |
| `kimi-k3.md` | `family: [kimi-k3*]` | kimi-k3, outranking the above |

A future `kimi-k4` then lands on `kimi.md` instead of falling silently to
`default.md`. Narrowing the generic template to `kimi-k2*` would reopen exactly
the `glm5*` / `deepseek4*` hole. Add rungs; do not remove the bottom one.

An exact pattern (`kimi-k3`, no wildcard) outranks a wildcard one matching the
same value. A `model:` match still beats any `family:` match however narrow —
the dimension is the primary key and narrowness only breaks ties inside it.

`--match-model` is the other override, for a params overlay whose own name is
scaffolding (`igovet/minimax-m3-opencode`). Both are checked: if a stated match
does not arrive in the reply, the audit fails the attempt.

### Audit a hand edit

```bash
bun scripts/audit-prompt-template.mts assets/prompt-templates/qwen.md --family qwen3.5
bun scripts/audit-prompt-template.mts assets/prompt-templates/claude.md --model claude-opus-5
```

`--family` / `--model` are **required in practice**: one audit check is that the
`match:` block still claims the session it was written for, and without a target
it fires on every file and reads like a defect in the template.

### After a tool description changes in code

```bash
bun scripts/sync-default-template.mts          # rewrite default.md
bun scripts/sync-default-template.mts --check  # CI: fail if stale
bun scripts/generate-builtin-templates.mts
```

### Producing a template for a model with no Ollama build (e.g. Claude)

There is no Ollama build of Claude, so the generator cannot drive it. The
transport is the `claude` CLI on solidPC in non-interactive mode; the input and
the checks are identical to a generated one.

```bash
cd sdk/packages/core
W=../../../prompt-reviews/regen/$(date +%Y%m%d-%H%M)-claude-p
mkdir -p "$W"

# 1. dump the exact prompt a Claude session would be handed (~76 KB, 34 sections)
bun scripts/dump-review-prompt.mts --template claude.md --out "$W/prompt.txt"

# 2. answer it. -p is non-interactive: prompt on stdin, reply on stdout.
#    --max-turns 1 matters -- this is a single rewrite, not an agent session,
#    and without it the CLI may start using tools on the repo it is run in.
(cd "$W" && claude -p --model opus --max-turns 1 < prompt.txt > claude-opus-5.md 2> run.log)

# 3. same audit as every generated template. --model is required in practice:
#    one check is that the match: block still claims the session it was written
#    for, and without a target it fires on every file (7).
bun scripts/audit-prompt-template.mts "$W/claude-opus-5.md" --model claude-opus-5
```

**There is no repair loop on this path, so build one by hand.** For an Ollama
model `review-prompt-templates.mts` feeds the audit's complaints back up to
`--attempts` times; `claude -p --max-turns 1` is a single shot, so the audit is
advisory unless you act on it. Measured 2026-09-12: attempt 1 was structurally
perfect — 34/34 tool sections, one `# system`, no fence, no inherited header —
and failed the audit on one point, the one-change-at-a-time rule. One repair
round fixed it:

```bash
# 3b. if the audit complained, hand it back the way the generator would
bun scripts/audit-prompt-template.mts "$W/claude-opus-5.md" \
  --model claude-opus-5 2>&1 | tail -n +2 > "$W/audit-1.txt"
{ cat "$W/prompt.txt"; echo; echo "---"; echo
  echo "You answered this once already. The answer is below, and it failed the audit on the following point. Fix exactly that and return the whole file again, in the same format, with nothing before or after it."
  echo; echo "AUDIT:"; cat "$W/audit-1.txt"
  echo; echo "YOUR PREVIOUS ANSWER:"; cat "$W/claude-opus-5.md"
} > "$W/prompt-2.txt"
(cd "$W" && claude -p --model opus --max-turns 1 < prompt-2.txt > claude-opus-5.attempt2.md 2> run-2.log)
bun scripts/audit-prompt-template.mts "$W/claude-opus-5.attempt2.md" --model claude-opus-5
```

Keep both attempts and both audits in the run directory, and say in the
hand-written provenance header which attempt the file is and what the earlier
one failed on — there is no generator to record it for you.

Notes from doing it:

- **The reply is not automatically a file.** `claude -p` writes prose to stdout;
  if the model wraps the template in a ```markdown fence or adds a sentence
  before it, strip that before auditing. The audit's first complaint on a
  fenced reply is `does not parse: no '# system' or '# tool:' section`.
- **Write into `prompt-reviews/regen/<stamp>-claude-p/`, not `/tmp`.** Same
  layout rule as every other run (`prompt-reviews/README.md`), and it keeps the
  prompt next to the reply so a later audit failure can be reproduced.
- **Strip any provenance header the reply carries.** The prompt includes the
  current `claude.md` header and the model copies it -- the same inheritance
  that made `deepseek.md` name the wrong model (0). The generator stamps its own
  header for Ollama runs; this path has no generator, so do it by hand.
- `claude.md` matches on `model:`, not `family:` -- there is no GGUF
  architecture string for a cloud Claude. Keep
  `["*claude*", "*opus*", "*sonnet*", "*fable*", "*haiku*"]` so a rename of one
  model does not drop the family.

---

## 8. The model roster

`REVIEW_MODELS` in `review-prompt-templates.mts`. Cloud tags move when a family
ships a new flagship; when one 404s, fix it here **and** in the provenance header
of the template it wrote.

**Cloud tag names follow no rule. Verify one, never guess it.** Within a single
family: `nemotron-3-super:cloud` and `nemotron-3-ultra:cloud`, but the third is
`nemotron-3-nano:30b-cloud` — a size in the tag, for that one only.
`gemma4:31b-cloud` carries a size; `glm-5.3:cloud` and `kimi-k2.6:cloud` do not;
`deepseek-v4.1-flash:cloud` puts the variant in the name. A guessed tag comes
back as `model '<name>' not found`, which reads like the model is gone rather
than misspelled.

**The `family` a cloud model reports is equally inconsistent**, and it decides
whether a template can match on family at all:

| model | reported family |
|---|---|
| `nemotron-3-super:cloud` | `nemotron_h_moe` |
| `nemotron-3-ultra:cloud` | *(empty)* |
| `nemotron-3-nano:30b-cloud` | `nemotron-3-nano` |

Three models, one family, three answers — one of which is nothing. Check with
`/api/show` before writing a `match:` block, and use `--match-model` (§7) when
the family comes back empty.

### WHICH MODEL TO USE FOR WHICH TEMPLATE

**Four of these must be generated from a local params overlay, not from the
cloud tag.** `--all` walks `REVIEW_MODELS`, which is the bare `:cloud` tags, so
`--all` alone regenerates four templates and silently wastes the attempts on
the other three. The overlays are already built on solidPC's dev server
(`127.0.0.1:11439`) and are listed below — check with `/api/tags` before
rebuilding one.

| Template | Generate with | Why |
|---|---|---|
| `gemma.md` | `gemma4:31b-cloud` | cloud tag works |
| `qwen.md` | `qwen3.5:397b-cloud` | cloud tag works |
| `deepseek.md` | `deepseek-v4.1-flash:cloud` | cloud tag works |
| `kimi.md` | `kimi-k2.6:cloud` | cloud tag works (family `kimi-k2`) |
| `glm.md` | **`glm-5.3-flash-tpl2:latest`** + `--think` | §7 "glm took three separate fixes" — the only family needing an overlay *and* reasoning *and* the flash tag |
| `minimax.md` | **`minimax-m3-tpl:latest`** | `minimax-m3:cloud` degenerates / truncates |
| `nemotron.md` | **`nemotron-3-super-tpl:latest`** | `nemotron-3-super:cloud` same |
| `kimi-k3.md` | `kimi-k3:cloud` | its own family (`kimi-k3`), not a kimi variant |
| `claude.md` | `claude -p` on solidPC | no Ollama build of Claude |

The overlay runs need their identity stated, because an overlay reports **no
family at all** and its own name is scaffolding.

`--family` is the one that decides which template seeds the rewrite, and it is
easy to miss: without it `/api/show` answers `family: ""` for a params overlay,
routing resolves to `default`, and the model is asked to improve **the base
prompt** rather than its own family's template. That is what happened to `glm`
on 2026-09-11 and again on 2026-09-12 -- seeded from `default.md` on every
attempt across two days, never producing a parsable file, with `family=unknown
template=default` sitting in each run log. Pass the family the *cloud* tag
reports (`/api/show` on `glm-5.3:cloud` says `glm_dsa_moe`). The provenance
header records that it was declared rather than measured.

`--name` and `--match-*` are a different job: they keep the written file's
identity and match block pointing at the family rather than at the scaffolding.
All three are needed:

```bash
cd sdk/packages/core
export OLLAMA_HOST=http://127.0.0.1:11439
R="bun scripts/review-prompt-templates.mts --timeout 1200"

# the five that work from their cloud tag -- one invocation, one run stamp
$R --model gemma4:31b-cloud --model qwen3.5:397b-cloud \
   --model deepseek-v4.1-flash:cloud --model kimi-k2.6:cloud \
   --model kimi-k3:cloud

# the three that need an overlay. --name keeps the template's identity;
# --match-* states the block the model must write, and the audit fails the
# attempt if the stated match does not arrive.
# glm needs --think as well, and a longer timeout to pay for it (see below)
$R2="bun scripts/review-prompt-templates.mts --timeout 3000"
$R2 --model glm-5.3-flash-tpl2:latest  --family glm5_next --think \
   --match-family 'glm*'      --name glm
$R --model minimax-m3-tpl:latest       --family minimax \
   --match-model '*minimax*'  --name minimax
$R --model nemotron-3-super-tpl:latest --family nemotron_h_moe \
   --match-model '*nemotron*' --name nemotron
```

Measured 2026-09-12, running `--all` without the overlays: `gemma`, `qwen`,
`deepseek` and `kimi` came back clean; `glm` produced nothing, `minimax` spent
every attempt (four of them) and `nemotron` was NOT CLEAN after two. Those are
the same three the overlays exist for, and the run had been told to ask the
cloud tags anyway.

Also note what `--all` does **not** cover: `claude.md` has no Ollama build, and
`kimi-k3.md` has no tag in `REVIEW_MODELS`. Neither is regenerated by `--all`,
and neither reports that it was skipped. After a rule change — which
invalidates every template (9) — those two must be handled by hand or they
silently keep the old rules.

The local overlays, as built (params only, no weights, `FROM` the cloud tag):

| overlay | `num_predict` | `num_ctx` |
|---|---|---|
| `glm-5.3-tpl:latest` | 131072 | 262144 |
| `glm-5.3-flash-tpl:latest` | 131072 | 1048576 |
| `minimax-m3-tpl:latest` | 131072 | 262144 |
| `nemotron-3-super-tpl:latest` | **65536** | 262144 |

All four also carry `temperature 1, top_p 0.95, repeat_last_n 2048,
repeat_penalty 1.1, frequency_penalty 0.1, presence_penalty 0.1`.
`nemotron-3-super` refuses `num_predict` above 65536 — it names the ceiling in
the error.

### The roster in code

| Template | Model |
|---|---|
| `gemma.md` | `gemma4:31b-cloud` |
| `qwen.md` | `qwen3.5:397b-cloud` |
| `glm.md` | `glm-5.3:cloud` |
| `deepseek.md` | `deepseek-v4.1-flash:cloud` |
| `kimi.md` | `kimi-k2.6:cloud` |
| *(new)* | `minimax-m3:cloud` — family `minimax-m3` |
| *(new)* | `nemotron-3-super:cloud` — family `nemotron_h_moe` |
| `claude.md` | a Claude, via `dump-review-prompt.mts` |

Adding a family means adding its template **and** updating the expected name list
in `shipped-templates.test.ts`.

---

## 9. The guard tests

| Test | What it proves |
|---|---|
| `shipped-templates.test.ts` "keeps `default.md` verbatim against the built-in system prompt" | `default.md` system == `DEFAULT_CLINE_SYSTEM_PROMPT` |
| …"verbatim against every static tool description" | every non-computed tool matches its built-in text |
| …"defers to the code for the two computed descriptions" | `run_commands` / `skills` are `{{DEFAULT}}` |
| …"covers every tool the default template claims to reproduce" | a tool added in code but not in `default.md` is caught |
| …"ships the base layer and one template per model family" | the family list is exactly as expected |
| `builtin-templates.test.ts` | the generated bundle matches the `.md` files on disk |
| `prompt-template-hooks.test.ts` | the change report fires once per session, names the changed tools |
| `builtin-templates.test.ts` "ships no template telling the model to batch its edits" | **what ships** carries the rule in no `# system` and no `# tool:` section. The gate on the artefact, not on the proposal — the audit runs against model output only, which is how seven of ten shipped files broke a ban that read as enforced |
| `findBatchedEditRules()` — phrasings | "Batching:", "Do not split … edits across separate turns", "emit multiple editor calls together", and the cadence rule stated correctly, which must pass |
| `auditSystemSection()` — read-back | the system section does not tell the model to read a file back after editing it |
| `auditSystemSection()` — verbatim copy | the system section is not `default.md` reproduced word for word |
| `auditSystemSection()` — completion rule | the system section does not say a response without tool calls counts as completion |

---

### RULE: every rule added to the instructions MUST get an audit gate

**This is not advice. A rule without a gate is a rule that does not exist.**

When you add guidance to `PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS`, you must in the
same change add a check for it in `auditPromptTemplateProposal()` — as a
forbidden-content check (`/pattern/` → problem) or a required-content check
(entry in `REQUIRED_SYSTEM_GUIDANCE` / `REQUIRED_USE_CASES`). Then regenerate,
so every template is verified against it rather than assumed to have absorbed
it.

The reason, measured on 2026-09-11. Four rules were folded into the
instructions. One got a gate. Six regenerations later:

| rule | gated? | landed in |
|---|---|---|
| no read-back after edit | **yes** | **every** regenerated template |
| checker and run in the same turn | no | 3 of 4 |
| a tool's report outranks re-deriving it | no | 2 of 4 |
| run the program last | no | 2 of 4 |

Same instructions, same run, same day. `qwen3.5:397b-cloud` regenerated **clean
on attempt 1** while reproducing verbatim the one sentence the instructions
named as forbidden; with the gate in place it fixed it on attempt 2. `kimi`
picked up one of the three ungated rules; `gemma` and `deepseek` picked up all
three. There is no way to tell from the output which rules a model absorbed
unless something checks.

The corollary matters as much: **changing the rules invalidates every existing
template.** After adding a gate, the honest options for a template you cannot
regenerate (no working model, e.g. `glm-5.3` and `glm-5.3-flash` both fail to
produce a parseable file) are to re-run with the model that wrote it, or to
hand-edit it and make it pass `audit-prompt-template.mts`. "It was clean before"
is not a state that survives a rule change.

This is the same lesson as `8323c3f65`, which fixed `code_intel` by adding
`REQUIRED_USE_CASES` rather than by asking more clearly.

#### …and a gate must accept every correct phrasing

A required-content gate is a regex over prose a different model wrote. Before
shipping one, check it against a template that *does* comply — ideally one that
complied in wording you did not anticipate.

Measured the same day: the "checker and the run in the same turn" gate matched
`same turn` but not `same response`. `kimi-k2.6` wrote *"call `check_file` in the
same response as `run_commands` or `browser`"* — correct, and rejected three
times running. The repair loop cannot win an unsatisfiable check; it just spends
attempts. The gate was wrong, not the model.

So: forbidden-content checks can be narrow, because a false negative merely
fails to catch something. Required-content checks must be **wide**, because a
false positive blocks a correct answer.

## 10. "I want to change X" → edit Y

| Goal | Edit |
|---|---|
| Change what **one family** sees | `assets/prompt-templates/<family>.md`, then audit, then `generate-builtin-templates.mts` |
| Change what **every family** sees | `PROMPT_TEMPLATE_REVIEW_INSTRUCTIONS` in `prompt-template-review.ts`, then regenerate all |
| Add a new **audit rule** | `prompt-template-review.ts` (`auditPromptTemplateProposal`), then regenerate and re-audit |
| Change a **tool description** | the tool's own definition in code, then `sync-default-template.mts` |
| Change the **base prompt for all providers** | `shared/src/prompt/system.ts` — upstream-owned; expect rebase conflicts |
| Add a **new model family** | new `<family>.md` + `REVIEW_MODELS` + `shipped-templates.test.ts` name list |
| Fix **non-deterministic routing** | add a `"!pattern"` exclusion or switch to a `model:` match (§3) |

---

## 11. History worth knowing

* `f07eea894` — the templating system itself. Ours, not upstream.
* `f9dc49b50` — *"ship a template per model family, written by that model"*.
  Where the `## Critical Rules` structure entered.
* `8323c3f65` — `code_intel` required-use-cases audit rule; all six regenerated
  under it. The **worked example of the §4 recommendation**: add a rule to the
  instructions, regenerate everything, re-audit.
* **2026-09-12, the batch-edits rule.** Found in `qwen.md` and blamed on it;
  the commit message said it was the only one of the ten. It was not. The rule
  lives in `DEFAULT_CLINE_SYSTEM_PROMPT`, `YOLO_CLINE_SYSTEM_PROMPT` and the
  `editor` and `run_commands` tool descriptions, and from there in seven of the
  ten templates' system sections and nine of the ten's `# tool: editor`. It read
  as enforced the whole time, because the audit ran against model proposals and
  against `# system` only. Cost, measured over ten runs: 13.6 `restore_file`
  calls per run for the family reading it against 0.23 for the family that was
  not. Three lessons, all now gates: fix the code and re-sync rather than
  fixing templates; audit what ships, not only what a model proposes; and widen
  the matching against real sentences — three models wrote three phrasings past
  the first version of the check on the same afternoon.
* `d0b4ce0c4`, `cea985baa`, `84a667163`, `e825ae5f5` — four hand edits to
  `qwen.md` alone, from harness findings. These were the reason `qwen.md`
  diverged from every other template. Folded into the instructions on
  2026-09-11 so a regeneration no longer loses them.
