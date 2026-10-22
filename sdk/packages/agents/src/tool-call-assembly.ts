/**
 * Turning a model's streamed tool-call events into the calls the agent runs.
 *
 * The runtime drives a `ToolCallAssembler` for every request, and
 * `finishToolCalls` is the same assembly for a caller that has the model's
 * events but no agent loop -- a harness measuring what the provider layer and
 * this step do to a tool call (automaticum's BFCL proxy cell, #1535). Both run
 * this code, so a measurement through the second is a measurement of the
 * first.
 */
import type {
	AgentMessagePart,
	AgentModelEvent,
	AgentModelFinishReason,
	AgentToolCallPart,
	UnparsedToolCall,
} from "@cline/shared";
import {
	normalizeJsonLikeStringsForSchema,
	unparsedToolCallInText,
} from "@cline/shared";
import { nanoid } from "nanoid";

export type ToolCallDeltaEvent = Extract<
	AgentModelEvent,
	{ type: "tool-call-delta" }
>;

/** A call the model made that cannot be run, and why. */
export interface InvalidToolCall {
	toolCallId: string;
	toolName?: string;
	input: Record<string, unknown>;
	reason: "missing_name" | "missing_arguments" | "invalid_arguments";
}

/** One call as its deltas have assembled it so far. */
export interface ToolCallAssembly {
	toolCallId: string;
	toolName?: string;
	/** The argument text exactly as the model streamed it. */
	inputText: string;
	/** Arguments a provider handed over already parsed. */
	inputValue?: unknown;
	metadata?: unknown;
}

/** What one assembled call came to. */
export interface FinishedToolCall {
	/** Absent when the call has no name: there is nothing to run. */
	call?: AgentToolCallPart;
	invalid?: InvalidToolCall;
}

/**
 * Assembles tool calls from `tool-call-delta` events, keyed the way providers
 * address them: by call id, else by index, else in arrival order.
 *
 * Calls whose execution belongs to the provider (`event.execution` set) are
 * not assembled here; the runtime reports those as they happen.
 */
export class ToolCallAssembler {
	private readonly assemblies = new Map<string, ToolCallAssembly>();
	private nextIndex = 0;

	/**
	 * Add one delta. `created` is true for the first delta of a call, which is
	 * where the call sits among the turn's text and reasoning.
	 */
	add(event: ToolCallDeltaEvent): { key: string; created: boolean } {
		const key = event.toolCallId ?? `tool_${event.index ?? this.nextIndex}`;
		if (event.index == null && event.toolCallId == null) {
			this.nextIndex += 1;
		}
		let assembly = this.assemblies.get(key);
		const created = assembly === undefined;
		if (!assembly) {
			assembly = {
				toolCallId: event.toolCallId ?? `tool_${nanoid(8)}`,
				inputText: "",
			};
			this.assemblies.set(key, assembly);
		}
		if (event.toolCallId) {
			assembly.toolCallId = event.toolCallId;
		}
		if (event.toolName) {
			assembly.toolName = event.toolName;
		}
		if (event.input !== undefined) {
			assembly.inputValue = event.input;
		}
		if (event.metadata !== undefined) {
			assembly.metadata = mergeToolMetadata(assembly.metadata, event.metadata);
		}
		if (event.inputText) {
			assembly.inputText = mergeToolInputText(
				assembly.inputText,
				event.inputText,
			);
		}
		return { key, created };
	}

	get(key: string): Readonly<ToolCallAssembly> | undefined {
		return this.assemblies.get(key);
	}

	/** Argument characters assembled across every call so far. */
	inputChars(): number {
		let sum = 0;
		for (const assembly of this.assemblies.values()) {
			sum += toolInputLength(assembly);
		}
		return sum;
	}

	/**
	 * The call `key` names, parsed. `finishReason` matters: a call cut off at
	 * the output cap is told so, not that its JSON was invalid. `lastOfTurn`
	 * says it is the call that was being written when the turn ended -- the
	 * only one a cap can have cut.
	 */
	finish(
		key: string,
		finishReason?: AgentModelFinishReason,
		lastOfTurn = false,
	): FinishedToolCall {
		const assembly = this.assemblies.get(key);
		if (!assembly?.toolName) {
			return {
				invalid: {
					toolCallId: assembly?.toolCallId ?? key,
					input: buildInvalidToolInput(assembly?.inputText ?? ""),
					reason: "missing_name",
				},
			};
		}
		const parsed = parseToolInput(assembly, finishReason, lastOfTurn);
		const call: AgentToolCallPart = {
			type: "tool-call",
			toolCallId: assembly.toolCallId,
			toolName: assembly.toolName,
			input: parsed.input,
			metadata: parsed.parseError
				? mergeToolMetadata(assembly.metadata, {
						inputParseError: parsed.parseError,
						rawInputText: assembly.inputText,
					})
				: assembly.metadata,
		};
		return parsed.reason
			? {
					call,
					invalid: {
						toolCallId: assembly.toolCallId,
						toolName: assembly.toolName,
						input: parsed.invalidInput,
						reason: parsed.reason,
					},
				}
			: { call };
	}
}

/** The tools a turn was offered, as far as finishing their calls needs. */
export interface FinishToolCallsTool {
	name: string;
	inputSchema: Record<string, unknown>;
}

export interface FinishedTurn {
	/** Text, reasoning and tool calls in the order the model produced them. */
	content: AgentMessagePart[];
	/** The calls that would be run, inputs normalised as the runtime does. */
	toolCalls: AgentToolCallPart[];
	invalidToolCalls: InvalidToolCall[];
	text: string;
	reasoning: string;
	finishReason: AgentModelFinishReason;
	/**
	 * A tool call the model wrote as text, which the provider could not read.
	 * Looked for only when the turn made no calls, as the runtime does.
	 */
	unparsedToolCall?: UnparsedToolCall;
	/** The provider's error, when the stream ended on one. */
	error?: string;
}

/**
 * Everything between a model's events and the calls the runtime would run,
 * without the agent loop: assembly, argument parsing, the cut-off verdict,
 * schema normalisation of JSON-like strings, and the scan for a call written
 * as text. Nothing is executed.
 *
 * Pass `tools` to normalise each call's input against its tool's schema, the
 * step the runtime takes just before running a call. A call to a tool not in
 * the list is returned as parsed.
 */
export async function finishToolCalls(
	events: Iterable<AgentModelEvent> | AsyncIterable<AgentModelEvent>,
	options: { tools?: readonly FinishToolCallsTool[] } = {},
): Promise<FinishedTurn> {
	const assembler = new ToolCallAssembler();
	const sequence: Array<
		{ type: "tool"; key: string } | { type: "part"; part: AgentMessagePart }
	> = [];
	let text = "";
	let reasoning = "";
	let finishReason: AgentModelFinishReason = "unknown";
	let error: string | undefined;
	for await (const event of events) {
		switch (event.type) {
			case "text-delta": {
				text += event.text;
				const last = sequence.at(-1);
				if (last?.type === "part" && last.part.type === "text") {
					last.part.text += event.text;
				} else {
					sequence.push({
						type: "part",
						part: { type: "text", text: event.text },
					});
				}
				break;
			}
			case "reasoning-delta": {
				reasoning += event.text;
				const last = sequence.at(-1);
				if (last?.type === "part" && last.part.type === "reasoning") {
					last.part.text += event.text;
					last.part.redacted = event.redacted ?? last.part.redacted;
					last.part.metadata = event.metadata ?? last.part.metadata;
				} else {
					sequence.push({
						type: "part",
						part: {
							type: "reasoning",
							text: event.text,
							redacted: event.redacted,
							metadata: event.metadata,
						},
					});
				}
				break;
			}
			case "tool-call-delta": {
				if (event.execution) {
					break;
				}
				const { key, created } = assembler.add(event);
				if (created) {
					sequence.push({ type: "tool", key });
				}
				break;
			}
			case "finish": {
				finishReason = event.reason;
				error = event.error;
				break;
			}
		}
	}
	const schemas = new Map(
		(options.tools ?? []).map((tool) => [tool.name, tool.inputSchema]),
	);
	const content: AgentMessagePart[] = [];
	const toolCalls: AgentToolCallPart[] = [];
	const invalidToolCalls: InvalidToolCall[] = [];
	let lastToolKey: string | undefined;
	for (const item of sequence) {
		if (item.type === "tool") lastToolKey = item.key;
	}
	for (const item of sequence) {
		if (item.type === "part") {
			content.push(item.part);
			continue;
		}
		const finished = assembler.finish(
			item.key,
			finishReason,
			item.key === lastToolKey,
		);
		if (finished.invalid) {
			invalidToolCalls.push(finished.invalid);
		}
		if (!finished.call) {
			continue;
		}
		content.push(finished.call);
		if (finished.invalid) {
			continue;
		}
		const schema = schemas.get(finished.call.toolName);
		toolCalls.push(
			schema
				? {
						...finished.call,
						input: normalizeJsonLikeStringsForSchema(
							finished.call.input,
							schema,
						),
					}
				: finished.call,
		);
	}
	const unparsedToolCall =
		toolCalls.length === 0 && invalidToolCalls.length === 0
			? unparsedToolCallInText(text)
			: undefined;
	return {
		content,
		toolCalls,
		invalidToolCalls,
		text,
		reasoning,
		finishReason,
		...(unparsedToolCall ? { unparsedToolCall } : {}),
		...(error ? { error } : {}),
	};
}

export function mergeToolMetadata(current: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return patch;
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return patch;
	}
	return {
		...(current as Record<string, unknown>),
		...patch,
	};
}

function toolInputLength(assembly: ToolCallAssembly): number {
	if (assembly.inputText) return assembly.inputText.length;
	if (assembly.inputValue === undefined) return 0;
	try {
		return JSON.stringify(assembly.inputValue)?.length ?? 0;
	} catch {
		return 0;
	}
}

function parseToolInput(
	assembly: ToolCallAssembly,
	finishReason?: AgentModelFinishReason,
	lastOfTurn = false,
): {
	input: unknown;
	parseError?: string;
	invalidInput: Record<string, unknown>;
	reason?: InvalidToolCall["reason"];
} {
	// Arguments that parse are not arguments that finished. A server that
	// closes an open call when the cap is reached (xOllama does) hands over
	// valid JSON holding half of what the model meant: f099u (pandorum,
	// 2026-10-22) ended at exactly its 92,662-token cap with an `editor` call
	// whose `new_text` stopped mid-statement, and it ran. It was refused only
	// for lacking a `start_line`; with one, the half would have been written.
	if (finishReason === "max-tokens" && lastOfTurn) {
		const raw =
			assembly.inputValue !== undefined
				? JSON.stringify(assembly.inputValue)
				: assembly.inputText;
		if (raw.trim()) {
			return {
				input: {},
				invalidInput: buildInvalidToolInput(raw),
				parseError: `Tool call ${assembly.toolName ?? assembly.toolCallId} was cut off by the output budget: the turn ended at the cap while this call was being written, ${raw.length} characters into its arguments, so what arrived may not be all of it, and it was not run. Send the same work in smaller pieces: edit one region per call rather than rewriting the file, and keep each call's arguments short enough to complete.`,
				reason: "invalid_arguments",
			};
		}
	}
	if (assembly.inputValue !== undefined) {
		return {
			input: assembly.inputValue,
			invalidInput: buildInvalidToolInput(JSON.stringify(assembly.inputValue)),
		};
	}
	if (!assembly.inputText.trim()) {
		return {
			input: {},
			invalidInput: {},
		};
	}
	const parsed = parseToolArguments(assembly.inputText);
	if (parsed.ok) {
		return {
			input: parsed.value,
			invalidInput: buildInvalidToolInput(assembly.inputText),
		};
	}
	// A turn that ended at the cap did not write bad JSON, it was cut off
	// mid-write -- and the two need completely different answers. Measured on
	// pandorum 2026-09-18: `resolveGatewayOutputCap` takes the smallest of
	// {configured, model max, window - input - reserve}, so the cap decays every
	// turn (96,000 -> 12,286 across one session), and the malformed calls appear
	// exactly at the thin end: one `editor` call of 101,300 raw characters
	// against a 40,774-token cap, another carrying `end_line`, `intent` and
	// `new_text` but no `path`, each immediately followed by a compaction. Told
	// its JSON was invalid, the model goes looking for a syntax error that is
	// not there; what it has to do is write less in one call.
	const truncated = finishReason === "max-tokens";
	const explanation = truncated
		? `was cut off by the output budget before its arguments finished: the turn ended at the cap with ${assembly.inputText.length} characters of arguments written. Nothing is wrong with the payload you were writing -- there was no room left to finish it. Send the same work in smaller pieces: edit one region per call rather than rewriting the file, and keep each call's arguments short enough to complete.`
		: `emitted invalid JSON arguments: ${parsed.error}`;
	return {
		input: {},
		invalidInput: buildInvalidToolInput(assembly.inputText, parsed.error),
		parseError: `Tool call ${assembly.toolName ?? assembly.toolCallId} ${explanation}`,
		reason: "invalid_arguments",
	};
}

export function buildInvalidToolInput(
	value: string,
	parseError?: string,
): Record<string, unknown> {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	return parseError
		? { rawInputText: value, parseError }
		: { rawInputText: value };
}

function parseToolArguments(
	value: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: "Tool call arguments were empty.",
		};
	}

	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		// Fall through to a normalized error below.
	}

	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return {
			ok: false,
			error: "Tool call arguments must be encoded as a JSON object or array.",
		};
	}

	return {
		ok: false,
		error:
			"Tool call arguments could not be parsed as JSON. Ensure the outer tool payload is valid JSON and escape embedded quotes/newlines inside string fields.",
	};
}

function mergeToolInputText(current: string, incoming: string): string {
	if (!current) {
		return incoming;
	}
	const trimmed = incoming.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return incoming;
	}
	return current + incoming;
}
