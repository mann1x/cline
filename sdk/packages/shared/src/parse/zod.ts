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
	const names = fields.map((field) => `\`${field}\``).join(", ");
	return fields.length === 1
		? `Missing required argument ${names}. Send it and call again.`
		: `Missing required arguments: ${names}. Send them and call again.`;
}

/**
 * Validate input using a Zod schema
 * Throws a formatted error if validation fails
 */
export function validateWithZod<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new Error(
			describeMissingFields(result.error, input) ??
				z.prettifyError(result.error),
		);
	}
	return result.data;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
	return z.toJSONSchema(schema);
}
