/**
 * Zod Utilities
 *
 * Helper functions for working with Zod schemas.
 */

import { z } from "zod";

/**
 * Say which required fields are missing, in words rather than in Zod's.
 *
 * `z.prettifyError` renders an omitted string field as
 * `✖ Invalid input: expected string, received undefined → at path`, which
 * names the field only as the tail of a type complaint and never says the
 * field was required. Measured on a live session: a model sent `editor`
 * without `path` and got exactly that, with nothing telling it to add one.
 *
 * Only genuinely absent fields are rewritten. A field that is present but the
 * wrong type keeps Zod's message, which is already about the type.
 */
function valueAtPath(input: unknown, path: PropertyKey[]): unknown {
	let current = input;
	for (const segment of path) {
		if (current === null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<PropertyKey, unknown>)[segment];
	}
	return current;
}

/**
 * Say what the call did carry, alongside what it did not.
 *
 * The names it sent are the part of the call the model can recognise. A
 * transcript holds dozens of edits to one file, and "send `new_text` and call
 * again" identifies none of them; the arguments it did send do. It also shows
 * an argument that belongs to another tool sitting in this one — measured, an
 * `editor` call carrying `line_numbers` was a `read_files` call in the wrong
 * envelope, and nothing in the refusal said so.
 *
 * Names only, never values: a rejected call's values are the model's own text,
 * often the whole file, and echoing them back buys nothing.
 */
function describeCarriedFields(input: unknown, missing: Set<string>): string {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return "";
	}
	const carried = Object.keys(input as Record<string, unknown>).filter(
		(key) =>
			!missing.has(key) &&
			(input as Record<string, unknown>)[key] !== undefined,
	);
	if (carried.length === 0) {
		return "";
	}
	const names = carried.map((field) => `\`${field}\``).join(", ");
	return `\nThe call carried: ${names}.`;
}

/**
 * A key no model wrote, which means the arguments were not read as sent.
 *
 * A JSON object key cannot contain a raw quote or a newline: a well-formed
 * payload cannot produce one, so a key that does is the tail of a string some
 * lenient parse ran past the end of, promoted to a key. Measured on pandorum
 * 2026-09-18, session `elcud`, where an `editor` call arrived as
 * `end_line`, `new_text` and
 * `` `|function setupLevel|function initClouds|class Level<|"|>],task_progress` ``
 * -- and `path` was not missing, it was swallowed by the same misread.
 *
 * The distinction is the whole point. "Missing required argument `path`" is
 * advice a model can act on by adding `path`, and it did: it re-sent the same
 * payload, which was mangled the same way. A model told its arguments could not
 * be read has a reason to send them differently.
 *
 * Only the two characters that are impossible, never a length or a shape
 * heuristic: an odd-looking key that a model really did write must still be
 * reported as the extra argument it is.
 */
function misreadArgumentKey(input: unknown): boolean {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return false;
	}
	return Object.keys(input as Record<string, unknown>).some(
		(key) => key.includes('"') || key.includes("\n"),
	);
}

function describeMissingFields(
	error: z.ZodError,
	input: unknown,
): string | null {
	const missing = new Set<string>();
	for (const issue of error.issues) {
		// Zod's issue does not carry the offending value, and its message is
		// not a contract, so ask the input itself whether the field was there.
		const isAbsent =
			issue.code === "invalid_type" &&
			issue.path.length > 0 &&
			valueAtPath(input, [...issue.path]) === undefined;
		if (!isAbsent) {
			return null;
		}
		missing.add(issue.path.map((segment) => String(segment)).join("."));
	}
	if (missing.size === 0) {
		return null;
	}
	const fields = [...missing];
	// Asked before the missing-field wording is chosen, because the two answers
	// are mutually exclusive: an argument cannot be both absent and swallowed,
	// and only one of them is something the model can act on.
	if (misreadArgumentKey(input)) {
		const names = fields.map((field) => `\`${field}\``).join(", ");
		return (
			`The arguments of this call could not be read as sent: one of the keys that arrived ` +
			`is not a name anything could have written, so the payload was mis-parsed rather than ` +
			`mis-composed, and ${names} was lost with it.\n` +
			`Nothing is wrong with what you were trying to do. Send the call again, smaller: put the ` +
			`file path first, keep values short and free of unescaped quotes, and make one edit per ` +
			`call rather than rewriting the whole file in one.`
		);
	}
	const names = fields.map((field) => `\`${field}\``).join(", ");
	const carried = describeCarriedFields(input, missing);
	return fields.length === 1
		? `Missing required argument ${names}. Send it and call again.${carried}`
		: `Missing required arguments: ${names}. Send them and call again.${carried}`;
}

/** Longest preview of the offending input included in an error. */
const RECEIVED_PREVIEW_LIMIT = 300;

/**
 * Say what was actually sent, when nothing else in the error does.
 *
 * A union that matches no branch prettifies to bare `✖ Invalid input`: no
 * path, no field, no type. Measured on a live session, `run_commands` answered
 * exactly that to every call, the model could not tell what to change, sent the
 * identical arguments five times, and the loop guard stopped the task. A model
 * cannot fix what it is not told, so at minimum it is shown its own arguments
 * back and can compare them against the schema in the tool description.
 */
function describeReceived(input: unknown): string | null {
	let rendered: string;
	try {
		rendered = JSON.stringify(input);
	} catch {
		return null;
	}
	if (rendered === undefined) {
		return `Received: ${String(input)}`;
	}
	const preview =
		rendered.length > RECEIVED_PREVIEW_LIMIT
			? `${rendered.slice(0, RECEIVED_PREVIEW_LIMIT)}…`
			: rendered;
	return `Received: ${preview}`;
}

/** Whether the message already points at a field the caller can act on. */
function namesAField(message: string): boolean {
	return message.includes("→ at ");
}

/** Every argument name a schema declares, across union branches. */
const schemaPropertyNames = new WeakMap<z.ZodType, Set<string>>();

function propertyNamesOf(schema: z.ZodType): Set<string> {
	const cached = schemaPropertyNames.get(schema);
	if (cached) {
		return cached;
	}
	const names = new Set<string>();
	const collect = (node: unknown): void => {
		if (!node || typeof node !== "object") {
			return;
		}
		const record = node as Record<string, unknown>;
		const properties = record.properties;
		if (properties && typeof properties === "object") {
			for (const name of Object.keys(properties)) {
				names.add(name);
			}
		}
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const branches = record[key];
			if (Array.isArray(branches)) {
				for (const branch of branches) {
					collect(branch);
				}
			}
		}
	};
	try {
		collect(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
	} catch {
		// A schema that cannot be described has no names to check against, and
		// the check below then finds nothing: silence, never a guess.
	}
	schemaPropertyNames.set(schema, names);
	return names;
}

/** What a string was closed with instead of its own delimiter. */
const WRONG_CLOSER = String.raw`\x60|"|'|<\/[A-Za-z][\w-]*>`;
/** One argument written after it: `,name: value`, a value of plain shape. */
const SWALLOWED_PAIR = String.raw`\s*,\s*[A-Za-z_]\w*\s*:\s*(?:\x60[^\x60\n]*\x60|"[^"\n]*"|'[^'\n]*'|-?\d+(?:\.\d+)?|true|false|null)`;
const SWALLOWED_TAIL = new RegExp(
	// Spaces only after it, never a newline: the repair closes the string
	// before any trailing whitespace, and a newline is the way out the
	// refusal offers for text that really ends like this.
	String.raw`(${WRONG_CLOSER})((?:${SWALLOWED_PAIR})+)[ \t]*\}?[ \t]*$`,
);
const SWALLOWED_PAIRS =
	/\s*,\s*([A-Za-z_]\w*)\s*:\s*(\x60[^\x60\n]*\x60|"[^"\n]*"|'[^'\n]*'|[^,\s}]+)/g;

interface SwallowedArguments {
	field: string;
	closer: string;
	pairs: Array<{ name: string; value: string }>;
	tail: string;
}

/**
 * Arguments a lenient parse folded into the end of a string argument.
 *
 * The model closed a string with a backtick (or a quote, or `</code>`) instead
 * of the delimiter that opened it. Ollama's Gemma 4 parser then repairs the
 * call by closing the string at the very end, so every argument written after
 * it -- `start_line: 337`, which the model did write -- arrives as the tail of
 * `new_text`, and the call is well-formed with that argument missing. The
 * editor then said, truthfully, that the call had no `start_line`, and the
 * model, which had written one, sent the identical call again: five times in
 * a row on pandorum (2026-11-14, t9vz7). Across the archived sessions this
 * shape is 102 calls in 38 sessions, and before the editor refused an
 * `end_line` without a `start_line`, 21 of them replaced a whole file with
 * one line and the swallowed text.
 *
 * Only a tail that is nothing but `,name: value` pairs after the wrong closer,
 * every name an argument of this tool that the call does not carry. Text a
 * model meant to send cannot end that way without also leaving those very
 * arguments absent, and if it ever does, the refusal says how to send it.
 */
function findSwallowedArguments(
	schema: z.ZodType,
	input: unknown,
): SwallowedArguments | undefined {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	let names: Set<string> | undefined;
	for (const [field, value] of Object.entries(record)) {
		if (typeof value !== "string") {
			continue;
		}
		const tail = SWALLOWED_TAIL.exec(value);
		if (!tail) {
			continue;
		}
		names ??= propertyNamesOf(schema);
		const pairs = [...(tail[2] ?? "").matchAll(SWALLOWED_PAIRS)].map(
			(pair) => ({ name: pair[1] ?? "", value: pair[2] ?? "" }),
		);
		const swallowed =
			pairs.length > 0 &&
			pairs.every(
				(pair) =>
					pair.name !== field &&
					names?.has(pair.name) &&
					record[pair.name] === undefined,
			);
		if (swallowed) {
			// The "closer" can itself be the closing quote of an argument that
			// was swallowed too but is no name this tool has (`path: '...'`).
			// Then what really ended the string is further left and unknown,
			// and naming the quote would send the model looking for the wrong
			// mistake.
			const before = value.slice(0, tail.index + 1);
			const endsAValue =
				/,\s*[A-Za-z_]\w*\s*:\s*(?:\x60[^\x60\n]*|"[^"\n]*|'[^'\n]*)[\x60"']$/.test(
					before,
				);
			return {
				field,
				closer: endsAValue ? "" : (tail[1] ?? ""),
				pairs,
				tail: tail[0],
			};
		}
	}
	return undefined;
}

function describeSwallowedArguments(found: SwallowedArguments): string {
	const closer = !found.closer
		? ""
		: found.closer === "\x60"
			? "a backtick (\x60)"
			: found.closer === '"' || found.closer === "'"
				? `a quote (${found.closer})`
				: `\x60${found.closer}\x60`;
	const written = found.pairs
		.map((pair) => `\x60${pair.name}: ${pair.value}\x60`)
		.join(", ");
	const them = found.pairs.length === 1 ? "it" : "them";
	return (
		`This call was not run. Its \x60${found.field}\x60 ends with ${JSON.stringify(found.tail.trim())}: ` +
		`${closer ? `the string was closed with ${closer} instead of the delimiter that opened it` : "the string was not closed by the delimiter that opened it"}, so the parser read on past it, ` +
		`and ${written}, which you did write, arrived as the end of \x60${found.field}\x60 instead of as ${them === "it" ? "its own argument" : "their own arguments"}. ` +
		`Send the call again with \x60${found.field}\x60 closed by the same delimiter that opened it, and nothing after its last character. ` +
		`(If that text really is the end of what \x60${found.field}\x60 should hold, end it with a newline after it.)`
	);
}

/**
 * Validate input using a Zod schema
 * Throws a formatted error if validation fails
 */
export function validateWithZod<T>(schema: z.ZodType<T>, input: unknown): T {
	const swallowed = findSwallowedArguments(schema, input);
	if (swallowed) {
		throw new Error(describeSwallowedArguments(swallowed));
	}
	const result = schema.safeParse(input);
	if (!result.success) {
		const missing = describeMissingFields(result.error, input);
		if (missing) {
			throw new Error(missing);
		}
		const prettified = z.prettifyError(result.error);
		if (namesAField(prettified)) {
			throw new Error(prettified);
		}
		const received = describeReceived(input);
		throw new Error(received ? `${prettified}\n${received}` : prettified);
	}
	return result.data;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	return z.toJSONSchema(schema);
}
