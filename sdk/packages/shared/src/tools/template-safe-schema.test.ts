import { describe, expect, it } from "vitest";
import {
	listTypesOnItems,
	templateSafeToolSchema,
} from "./template-safe-schema";

describe("templateSafeToolSchema", () => {
	it("says an items list type as anyOf, the shape the Gemma 4 template renders (mail #2357)", () => {
		const schema = {
			type: "object",
			properties: {
				check: {
					type: "array",
					items: { type: ["integer", "string"] },
					description: "d",
				},
			},
		};
		const safe = templateSafeToolSchema(schema);
		expect(safe).toEqual({
			type: "object",
			properties: {
				check: {
					type: "array",
					items: { anyOf: [{ type: "integer" }, { type: "string" }] },
					description: "d",
				},
			},
		});
		expect(listTypesOnItems(safe)).toEqual([]);
		// The original, which may be someone else's (an MCP server's), is untouched.
		expect(schema.properties.check.items.type).toEqual(["integer", "string"]);
	});

	it("leaves list types the template renders fine, and returns the same object", () => {
		const schema = {
			type: "object",
			properties: {
				args: { type: ["string", "null"] },
				files: {
					type: "array",
					items: {
						type: "object",
						properties: { line_numbers: { type: ["boolean", "null"] } },
					},
				},
			},
		};
		expect(templateSafeToolSchema(schema)).toBe(schema);
	});

	it("reaches nested arrays, tuple items, and keeps an existing anyOf", () => {
		const schema = {
			type: "object",
			properties: {
				grid: {
					type: "array",
					items: { type: "array", items: { type: ["number", "null"] } },
				},
				pair: {
					type: "array",
					items: [{ type: ["string", "integer"] }, { type: "boolean" }],
				},
				odd: {
					type: "array",
					items: {
						type: ["string", "integer"],
						anyOf: [{ minLength: 1 }, { minimum: 0 }],
					},
				},
				one: { type: "array", items: { type: ["string"] } },
			},
		};
		const safe = templateSafeToolSchema(schema) as typeof schema;
		expect(listTypesOnItems(safe)).toEqual([]);
		expect(safe.properties.grid.items.items).toEqual({
			anyOf: [{ type: "number" }, { type: "null" }],
		});
		expect(safe.properties.pair.items[0]).toEqual({
			anyOf: [{ type: "string" }, { type: "integer" }],
		});
		expect(safe.properties.odd.items).toEqual({
			allOf: [
				{ anyOf: [{ minLength: 1 }, { minimum: 0 }] },
				{ anyOf: [{ type: "string" }, { type: "integer" }] },
			],
		});
		expect(safe.properties.one.items).toEqual({ type: "string" });
	});

	it("finds the shape where it is", () => {
		expect(
			listTypesOnItems({
				properties: {
					check: { type: "array", items: { type: ["integer", "string"] } },
				},
			}),
		).toEqual(["properties.check.items.type"]);
	});
});
