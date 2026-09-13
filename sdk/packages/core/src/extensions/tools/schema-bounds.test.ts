import { describe, expect, it } from "vitest";
import * as schemas from "./schemas";

/**
 * A bound the model cannot see is a bound it will keep hitting.
 *
 * Reported from a real session: `grep` was called with more context lines than
 * the schema allows and came back with
 * `✗ Too big: expected number to be <=20 → at context`. The tool's own
 * description said only "How many lines of context to show either side of a
 * match", so nothing the model was given named 20 -- it asked for a reasonable
 * number, was refused, and had no way to learn the limit except by hitting it
 * again. Three capped fields were in that state.
 *
 * Written against every schema in the file rather than the three, because the
 * next capped field will be added by someone who has not read this.
 */
describe("numeric bounds are stated where the model can read them", () => {
	/** Pull `{field, max, description}` for every capped number in a zod object. */
	function cappedNumbers(shape: Record<string, unknown>) {
		const found: Array<{ field: string; max: number; description: string }> =
			[];
		for (const [field, value] of Object.entries(shape)) {
			let node = value as
				| {
						def?: { type?: string; innerType?: unknown; checks?: unknown[] };
						description?: string;
				  }
				| undefined;
			let description: string | undefined;
			let max: number | undefined;
			// Unwrap optional/nullable/coerce layers, collecting checks and the
			// outermost description on the way down.
			for (let depth = 0; node && depth < 8; depth += 1) {
				description ??= node.description;
				for (const check of node.def?.checks ?? []) {
					const bound = check as {
						_zod?: { def?: { check?: string; value?: number } };
					};
					if (
						bound._zod?.def?.check === "less_than" ||
						bound._zod?.def?.check === "max_length"
					) {
						max ??= bound._zod.def.value;
					}
				}
				node = node.def?.innerType as typeof node;
			}
			if (max !== undefined) {
				found.push({ field, max, description: description ?? "" });
			}
		}
		return found;
	}

	const objectSchemas = Object.entries(schemas).filter(
		([name, value]) =>
			name.endsWith("InputSchema") &&
			typeof value === "object" &&
			value !== null &&
			"shape" in (value as object),
	) as unknown as Array<[string, { shape: Record<string, unknown> }]>;

	it("finds schemas to check at all", () => {
		expect(objectSchemas.length).toBeGreaterThan(0);
	});

	for (const [name, schema] of objectSchemas) {
		const capped = cappedNumbers(schema.shape);
		if (capped.length === 0) {
			continue;
		}
		it(`${name} names every maximum in the field's own description`, () => {
			const silent = capped.filter(
				(entry) => !entry.description.includes(String(entry.max)),
			);
			expect(
				silent.map(
					(entry) => `${entry.field} (max ${entry.max}): ${entry.description}`,
				),
			).toEqual([]);
		});
	}
});
