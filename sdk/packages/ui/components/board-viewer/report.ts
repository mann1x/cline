import {
	formatDuration,
	type ViewerEvent,
	type ViewerNodeState,
	type ViewerPipelineDefinition,
	type ViewerRun,
} from "./model.js";

/**
 * A run's report (plan section 9, Report tab): what ran, how it ended, what
 * failed, and what its `check` and `agent` nodes found, as Markdown the
 * person can copy or save.
 */

const MAX_FINDING = 400;

const cell = (text: string) =>
	text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

const when = (ts: number | undefined) => {
	if (ts === undefined) return "";
	const date = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

function outputLine(state: ViewerNodeState | undefined): string {
	const output = state?.output;
	if (!output) return state?.reason ?? "";
	const items = Array.isArray(output.items) ? output.items.length : 0;
	const parts = [
		`${items} item${items === 1 ? "" : "s"}${output.port && output.port !== "out" ? ` on ${output.port}` : ""}`,
	];
	if (output.exit !== undefined) parts.push(`exit ${output.exit}`);
	if (output.status !== undefined) parts.push(`HTTP ${output.status}`);
	return parts.join(", ");
}

/** The node order for a run: its definition's, then any node only its journal names. */
export function runNodeOrder(
	run: ViewerRun,
	definition: ViewerPipelineDefinition | undefined,
): string[] {
	const order = (definition?.nodes ?? [])
		.map((node) => node.id)
		.filter((id) => typeof id === "string");
	for (const id of Object.keys(run.nodes)) {
		if (!order.includes(id)) order.push(id);
	}
	return order;
}

export function runReport(
	run: ViewerRun,
	definition: ViewerPipelineDefinition | undefined = run.definition,
): string {
	const lines: string[] = [];
	const types = new Map(
		(definition?.nodes ?? []).map((node) => [node.id, node.type]),
	);
	lines.push(`# Run ${run.id}: ${run.status}`, "");
	lines.push(
		`- Pipeline: ${run.pipeline}${run.hash ? ` (version ${run.hash})` : ""}`,
	);
	if (run.startedAt !== undefined) {
		const took =
			run.endedAt !== undefined
				? `, took ${formatDuration(run.endedAt - run.startedAt)}`
				: "";
		lines.push(`- Started: ${when(run.startedAt)}${took}`);
	}
	if (Object.keys(run.inputs).length > 0)
		lines.push(`- Inputs: \`${JSON.stringify(run.inputs)}\``);
	if (run.from)
		lines.push(`- Re-run of ${run.from}: unchanged nodes reused its outputs`);
	if (run.parent) lines.push(`- Sub-run of ${run.parent}`);
	if (run.task) lines.push(`- Board task: ${run.task}`);
	if (run.error) lines.push(`- Error: ${run.error}`);
	lines.push("");

	const order = runNodeOrder(run, definition);
	if (order.length > 0) {
		lines.push(
			"## Nodes",
			"",
			"| Node | Type | Status | Attempts | Time | Output |",
			"|---|---|---|---|---|---|",
		);
		for (const id of order) {
			const state = run.nodes[id];
			const time =
				state?.startedAt !== undefined && state.endedAt !== undefined
					? formatDuration(state.endedAt - state.startedAt)
					: "";
			const status = state
				? state.reused
					? `${state.status} (reused)`
					: state.status
				: "not reached";
			lines.push(
				`| ${cell(id)} | ${cell(types.get(id) ?? "")} | ${status} | ${state?.attempts ?? 0} | ${time} | ${cell(outputLine(state))} |`,
			);
		}
		lines.push("");
	}

	const failures = order.filter((id) => run.nodes[id]?.status === "failed");
	if (failures.length > 0) {
		lines.push("## Failures", "");
		for (const id of failures) {
			const state = run.nodes[id];
			const tries =
				state.attempts > 1 ? ` (after ${state.attempts} attempts)` : "";
			lines.push(`- **${id}**${tries}: ${state.error ?? "failed"}`);
		}
		lines.push("");
	}

	const findings: string[] = [];
	for (const id of order) {
		const type = types.get(id);
		const state = run.nodes[id];
		if (!state?.output || (type !== "check" && type !== "agent")) continue;
		const text = (state.output.text ?? state.output.stdout ?? "").trim();
		// A check that fails fails its node (listed above); one with an output passed.
		const verdict = type === "check" ? "passed" : "answered";
		const body = text
			? `: ${text.length > MAX_FINDING ? `${text.slice(0, MAX_FINDING)}…` : text}`
			: "";
		findings.push(`- ${type} **${id}** ${verdict}${body.replace(/\n+/g, " ")}`);
	}
	if (findings.length > 0) {
		lines.push("## Findings", "", ...findings, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One journal event in words, for Activity and the inspector. */
export function eventSummary(event: ViewerEvent): string {
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	switch (event.t) {
		case "run": {
			const inputs =
				event.inputs && typeof event.inputs === "object"
					? Object.keys(event.inputs).length
					: 0;
			const extra = [
				text(event.from) && `re-run of ${text(event.from)}`,
				text(event.parent) && `sub-run of ${text(event.parent)}`,
			].filter(Boolean);
			return [
				`started ${text(event.pipeline)}`,
				inputs ? plural(inputs, "input") : "",
				...extra,
			]
				.filter(Boolean)
				.join(", ");
		}
		case "start":
			return typeof event.attempt === "number"
				? `attempt ${event.attempt}`
				: "started";
		case "end": {
			const output = (event.output ?? {}) as {
				items?: unknown;
				port?: unknown;
			};
			const items = Array.isArray(output.items) ? output.items.length : 0;
			const port = text(output.port);
			return [
				`${plural(items, "item")}${port && port !== "out" ? ` on ${port}` : ""}`,
				text(event.reused) && `reused from ${text(event.reused)}`,
				event.pinned ? "pinned" : "",
			]
				.filter(Boolean)
				.join(", ");
		}
		case "retry":
			return `attempt ${event.attempt ?? "?"} failed: ${text(event.error)}; again in ${event.wait ?? "?"} s`;
		case "skip":
			return text(event.reason) || "skipped";
		case "fail":
			return text(event.error) || "failed";
		case "wait":
			return `waiting on ${text(event.on)}`;
		case "resume":
			return "resumed";
		case "done":
			return [text(event.status), text(event.error)].filter(Boolean).join(": ");
		default:
			return "";
	}
}
