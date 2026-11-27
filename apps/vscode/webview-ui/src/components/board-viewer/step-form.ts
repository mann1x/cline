/**
 * The pipeline step form's knowledge (owner, 2026-11-27: "pipelines are bare,
 * there's no helper for syntax of anything, add a contextual pop while
 * hovering"; "everything that can be auto-completed in ui should have it").
 *
 * What each step type's fields are and mean, in the person's words; what a
 * field can be completed from; and what an expression can name at the caret.
 * It follows the engine's node types (core `pipelines/model.ts`) and the
 * model's `pipeline catalog`; a field the form does not know stays editable
 * in the JSON tab.
 */

export type FieldKind =
	| "text"
	| "multiline"
	/** Text with `{{ … }}` expressions in it. */
	| "expr"
	/** One expression, `{{ }}` optional: a condition or a value. */
	| "condition"
	| "number"
	| "boolean"
	| "enum"
	| "json"
	/** Several words, comma separated. */
	| "list"
	| "after"
	| "tool"
	| "agent"
	| "pipeline"
	| "gate"

export interface StepField {
	key: string
	label: string
	kind: FieldKind
	help: string
	required?: boolean
	options?: { value: string; label: string }[]
	placeholder?: string
}

/** What a gate can wait on, offered as the person types one. */
export const GATE_SUGGESTIONS: { value: string; label: string }[] = [
	{ value: "human:", label: "Waits for your answer: Resolve opens it" },
	{ value: "timer:+30m", label: "Waits a while (+10m, +2h, +1d)" },
	{ value: "timer:2026-12-01T09:00", label: "Waits until a time" },
	{ value: "commit:<sha>@main", label: "Waits until the branch has the commit" },
	{ value: "gh-pr:owner/repo#1", label: "Waits until the pull request is merged" },
	{ value: "gh-run:owner/repo/123", label: "Waits until the Actions run succeeds" },
	{ value: "run:", label: "Waits until a teammate run or delegated agent ends" },
	{ value: "command:", label: "Waits until a background command exits" },
	{ value: "pipeline:", label: "Waits until a pipeline run ends" },
]

/** What each step type does, shown with its form. */
export const STEP_HELP: Record<string, string> = {
	tool: "Calls one of this conversation's tools, with its approvals. Its items are the tool's result.",
	command: "Runs a shell command in the workspace, under the shell's approval. Items: [{exit, stdout, stderr}].",
	set: "Makes items: the fields you give, once per input item (once with none), or a list from an expression.",
	if: "Picks its true or false output from a condition. Steps after it name the output: id.true or id.false.",
	switch: "Picks one output per case by comparing a value with each case as text, or default.",
	merge: "Joins what the steps before it gave.",
	loop: "Runs one body step for every item of a list: $item and $index name the current one.",
	wait: "Waits on a gate before going on: a time, a commit, a pull request, your answer.",
	approval: "Asks you on the task board: Resolve approves (output approve), removing the gate rejects (output reject).",
	check: "Fails the run unless a command exits 0 or a condition holds.",
	agent: "Hands a task to a sub-agent: a configured agent by name, or an open one. Items: [{text}].",
	swarm: "Runs several workers at once, one task each. Items: one per worker's report.",
	http: "Sends a web request. Asks you first unless the pipeline_http policy approves. Items: the JSON list, or [{status, headers, body}].",
	pipeline:
		"Runs another workspace pipeline's approved version to its end. Its items are what that pipeline's last steps gave.",
}

/** The fields every step has, after its own. */
export const COMMON_FIELDS: StepField[] = [
	{
		key: "name",
		label: "Name",
		kind: "text",
		help: "A label for the board and the viewer. The id is shown when it has none.",
	},
	{
		key: "description",
		label: "Description",
		kind: "multiline",
		help: "What the step is for, for whoever reads the pipeline.",
	},
	{
		key: "after",
		label: "After",
		kind: "after",
		help: 'The steps it runs after: "build", or "check.true" for one output of a branching step. A step whose input did not run is skipped, and so is what follows it.',
	},
	{ key: "timeout", label: "Timeout (s)", kind: "number", help: "Seconds before the step is stopped and fails." },
	{
		key: "retry",
		label: "Retry",
		kind: "json",
		help: "Try again after a failure: {max, wait? (seconds, 1), backoff? (2)}. Not after a stop.",
		placeholder: '{"max": 3, "wait": 2}',
	},
	{
		key: "onError",
		label: "On error",
		kind: "enum",
		help: "After the last attempt failed: stop the run (the default), continue with [{error}] as its items, or route them to its error output (steps after id.error).",
		options: [
			{ value: "stop", label: "stop the run" },
			{ value: "continue", label: "continue with the error" },
			{ value: "route", label: "route to its error output" },
		],
	},
	{
		key: "idempotent",
		label: "Safe to run twice",
		kind: "boolean",
		help: "A step running when the host stopped is run again after a reload only when this is set; otherwise it fails as interrupted.",
	},
	{
		key: "pin",
		label: "Pinned items",
		kind: "json",
		help: "Test data: a test run returns these items without running the step.",
		placeholder: '[{"ok": true}]',
	},
]

const EXPR_HELP = "Text, with {{ … }} for values: $vars.<input>, $node.<step>.items, $item, functions like len(…)."

/** Each type's own fields, in the order the form shows them. */
export const STEP_FIELDS: Record<string, StepField[]> = {
	tool: [
		{ key: "tool", label: "Tool", kind: "tool", required: true, help: "The tool to call: any tool of this conversation." },
		{
			key: "input",
			label: "Input",
			kind: "json",
			help: "The tool's arguments, as JSON. Strings in it may hold {{ … }}.",
			placeholder: '{"path": "{{ $vars.file }}"}',
		},
	],
	command: [
		{ key: "command", label: "Command", kind: "expr", required: true, help: `The shell command. ${EXPR_HELP}` },
		{ key: "cwd", label: "Folder", kind: "text", help: "Where it runs, under the workspace. The workspace when empty." },
		{
			key: "allowFailure",
			label: "A failing exit is fine",
			kind: "boolean",
			help: "A non-zero exit fails the step unless this is set.",
		},
	],
	set: [
		{
			key: "fields",
			label: "Fields",
			kind: "json",
			help: "The fields of each item, {name: value}. Values may hold {{ … }}.",
			placeholder: '{"version": "{{ $vars.version }}"}',
		},
		{
			key: "items",
			label: "Items from",
			kind: "expr",
			help: "Instead of fields: {{ … }} giving a list, which becomes the items.",
		},
		{
			key: "keepInput",
			label: "Start from the input item",
			kind: "boolean",
			help: "Each item starts as the input item, then gets the fields.",
		},
	],
	if: [
		{
			key: "when",
			label: "When",
			kind: "condition",
			required: true,
			help: "The condition: true goes to id.true, false to id.false. {{ }} is optional: $node.test.exit == 0",
		},
	],
	switch: [
		{ key: "on", label: "Value", kind: "condition", required: true, help: "The value compared with each case, as text." },
		{
			key: "cases",
			label: "Cases",
			kind: "list",
			required: true,
			help: "The outputs, comma separated; anything else goes to default.",
		},
	],
	merge: [
		{
			key: "mode",
			label: "Mode",
			kind: "enum",
			help: "all: every input ran; append: whatever ran; first: the first that ran; by-key: join items on a field.",
			options: [
				{ value: "all", label: "all inputs ran" },
				{ value: "append", label: "append what ran" },
				{ value: "first", label: "the first that ran" },
				{ value: "by-key", label: "join on a field" },
			],
		},
		{ key: "key", label: "Join on", kind: "text", help: "The field by-key joins on." },
	],
	loop: [
		{ key: "over", label: "Over", kind: "expr", required: true, help: "{{ … }} giving the list it runs the body for." },
		{ key: "parallel", label: "At once", kind: "number", help: "How many bodies run at once (one by one when empty)." },
		{
			key: "body",
			label: "Body",
			kind: "json",
			required: true,
			help: "One tool, command, set, check, http, agent or pipeline step, without id or after. $item and $index name the current item.",
			placeholder: '{"type": "command", "command": "echo {{ $item }}"}',
		},
	],
	wait: [
		{
			key: "gate",
			label: "Gate",
			kind: "gate",
			required: true,
			help: "What it waits on: a time, a commit, a pull request, your answer.",
		},
	],
	approval: [
		{
			key: "message",
			label: "Question",
			kind: "expr",
			required: true,
			help: `What you are asked on the task board. ${EXPR_HELP}`,
		},
	],
	check: [
		{ key: "command", label: "Command", kind: "expr", help: "Passes when it exits 0." },
		{ key: "when", label: "Or when", kind: "condition", help: "Passes when the condition holds." },
		{ key: "message", label: "Message", kind: "text", help: "Said when the check fails." },
	],
	agent: [
		{ key: "task", label: "Task", kind: "expr", required: true, help: `What the agent is to do. ${EXPR_HELP}` },
		{ key: "agent", label: "Agent", kind: "agent", help: "A configured agent's name. An open sub-agent when empty." },
		{ key: "instructions", label: "Role", kind: "multiline", help: "The open sub-agent's role (with no agent named)." },
		{
			key: "json",
			label: "Answer is JSON",
			kind: "boolean",
			help: "Read the answer as JSON: its value is the step's items.",
		},
	],
	swarm: [
		{ key: "instructions", label: "Role", kind: "multiline", required: true, help: "The role every worker runs with." },
		{
			key: "tasks",
			label: "Tasks",
			kind: "json",
			help: 'One task per worker, as a list, or "{{ … }}" giving the list.',
			placeholder: '["Review src/a.ts", "Review src/b.ts"]',
		},
		{ key: "task", label: "One task for all", kind: "expr", help: "One task every worker gets, with How many." },
		{ key: "count", label: "How many", kind: "number", help: "The number of workers for the one task." },
	],
	http: [
		{ key: "url", label: "URL", kind: "expr", required: true, help: `The address. ${EXPR_HELP}` },
		{
			key: "method",
			label: "Method",
			kind: "enum",
			help: "GET when empty.",
			options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value })),
		},
		{ key: "headers", label: "Headers", kind: "json", help: "{name: value}.", placeholder: '{"Accept": "application/json"}' },
		{ key: "body", label: "Body", kind: "json", help: "Sent as JSON, or as text when it is a string." },
		{
			key: "allowFailure",
			label: "Any status is fine",
			kind: "boolean",
			help: "A status outside 2xx fails the step unless this is set.",
		},
	],
	pipeline: [
		{
			key: "pipeline",
			label: "Pipeline",
			kind: "pipeline",
			required: true,
			help: "Another pipeline of this workspace, by name. Never this one.",
		},
		{
			key: "inputs",
			label: "Inputs",
			kind: "json",
			help: "Its inputs, {name: value}. Values may hold {{ … }}.",
			placeholder: '{"version": "{{ $vars.version }}"}',
		},
	],
}

/** The outputs a step offers the steps after it, besides its default. */
export function stepPorts(node: { type?: unknown; cases?: unknown; onError?: unknown }): string[] {
	const ports =
		node.type === "if"
			? ["true", "false"]
			: node.type === "switch"
				? [...(Array.isArray(node.cases) ? node.cases.map(String) : []), "default"]
				: node.type === "approval"
					? ["approve", "reject"]
					: []
	return node.onError === "route" ? [...ports, "error"] : ports
}

/** What a step's `after` can name: each other step, or one of its outputs. */
export function afterOptions(
	nodes: readonly { id: string; type?: unknown; cases?: unknown; onError?: unknown; name?: unknown }[],
	self: string,
): { value: string; label: string }[] {
	return nodes
		.filter((node) => node.id !== self)
		.flatMap((node) => {
			const ports = stepPorts(node)
			const name = typeof node.name === "string" && node.name ? node.name : node.id
			const whole =
				node.type === "if" || node.type === "switch" || node.type === "approval"
					? []
					: [{ value: node.id, label: `${name} (${String(node.type)})` }]
			return [...whole, ...ports.map((port) => ({ value: `${node.id}.${port}`, label: `${name}: its ${port} output` }))]
		})
}

export interface ExpressionContext {
	/** The pipeline's steps, for `$node.<id>`. */
	nodes: readonly { id: string; type?: unknown }[]
	/** Its inputs, for `$vars.<name>`. */
	inputs: readonly string[]
	/** The functions an expression may call. */
	functions: readonly string[]
}

export interface Completion {
	insert: string
	label: string
	detail: string
}

const ROOTS: Completion[] = [
	{ insert: "$vars.", label: "$vars", detail: "The run's inputs: $vars.<name>" },
	{ insert: "$node.", label: "$node", detail: "An earlier step: $node.<id>.items, .exit, .stdout, .stderr, .text, .port" },
	{ insert: "$input", label: "$input", detail: "The items this step got" },
	{ insert: "$item", label: "$item", detail: "The current item (in a loop body or per item)" },
	{ insert: "$json", label: "$json", detail: "The same as $item" },
	{ insert: "$index", label: "$index", detail: "The current item's position, from 0" },
	{ insert: "$run.", label: "$run", detail: "This run: $run.id, $run.pipeline" },
	{ insert: "$env.", label: "$env", detail: "What the host lets a pipeline read" },
]

const NODE_FIELDS: Completion[] = [
	{ insert: "items", label: "items", detail: "Its items (a list)" },
	{ insert: "exit", label: "exit", detail: "A command's exit code" },
	{ insert: "stdout", label: "stdout", detail: "A command's output" },
	{ insert: "stderr", label: "stderr", detail: "A command's error output" },
	{ insert: "text", label: "text", detail: "An agent's answer" },
	{ insert: "port", label: "port", detail: "The output a branching step took" },
]

/** What each function does, for the popup; a function the engine adds later is offered without one. */
export const FUNCTION_HELP: Record<string, string> = {
	len: "len(x): the length of a text or list, the number of keys of an object",
	join: 'join(list, sep?): the list as text, joined with sep (",")',
	split: 'split(text, sep?): the text as a list, split at sep (",")',
	json: "json(x): x as JSON text",
	parse: "parse(text): the JSON in a text",
	default: 'default(x, fallback): x, or fallback when x is empty ("", null, missing)',
	contains: "contains(list or text, x): whether x is in it",
	lower: "lower(text): in lower case",
	upper: "upper(text): in upper case",
	trim: "trim(text): without spaces at the ends",
	keys: "keys(object): its keys",
	number: "number(x): x as a number",
	string: "string(x): x as text",
	lines: "lines(text): its non-empty lines",
}

/**
 * What to offer at the caret of an expression field, and where the word it
 * replaces starts. `always` is for a condition, which is an expression
 * throughout; elsewhere only inside `{{ … }}`, or right after a `{{`.
 */
export function expressionCompletions(
	text: string,
	caret: number,
	context: ExpressionContext,
	always = false,
): { from: number; items: Completion[] } | undefined {
	const before = text.slice(0, caret)
	const open = before.lastIndexOf("{{")
	const inside = always || (open >= 0 && before.lastIndexOf("}}") < open)
	if (!inside) return undefined
	const token = /[$\w.]*$/.exec(before)?.[0] ?? ""
	const from = caret - token.length
	const starts = (items: Completion[], prefix: string) => items.filter((item) => item.label.startsWith(prefix))
	const node = /^\$node\.([\w-]*)$/.exec(token)
	if (node) {
		return {
			from,
			items: context.nodes
				.filter((entry) => entry.id.startsWith(node[1] ?? ""))
				.map((entry) => ({ insert: `$node.${entry.id}.`, label: entry.id, detail: `The ${String(entry.type)} step` })),
		}
	}
	const field = /^\$node\.([\w-]+)\.(\w*)$/.exec(token)
	if (field) {
		return {
			from,
			items: starts(NODE_FIELDS, field[2] ?? "").map((item) => ({ ...item, insert: `$node.${field[1]}.${item.insert}` })),
		}
	}
	const vars = /^\$vars\.(\w*)$/.exec(token)
	if (vars) {
		return {
			from,
			items: context.inputs
				.filter((name) => name.startsWith(vars[1] ?? ""))
				.map((name) => ({ insert: `$vars.${name}`, label: name, detail: "An input of the pipeline" })),
		}
	}
	const run = /^\$run\.(\w*)$/.exec(token)
	if (run) {
		return {
			from,
			items: [
				{ insert: "$run.id", label: "id", detail: "This run's id" },
				{ insert: "$run.pipeline", label: "pipeline", detail: "This pipeline's name" },
			].filter((item) => item.label.startsWith(run[1] ?? "")),
		}
	}
	if (token.startsWith("$")) {
		return token.includes(".") ? undefined : { from, items: starts(ROOTS, token) }
	}
	if (token.includes(".")) return undefined
	const functions = context.functions
		.filter((name) => name.startsWith(token))
		.map((name) => ({ insert: `${name}(`, label: `${name}()`, detail: FUNCTION_HELP[name] ?? "A function" }))
	// Right after `{{` (or a space, an operator, a parenthesis): everything that starts an expression.
	return token ? (functions.length ? { from, items: functions } : undefined) : { from, items: [...ROOTS, ...functions] }
}
