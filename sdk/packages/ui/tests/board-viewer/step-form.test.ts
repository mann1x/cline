import { describe, expect, it } from "vitest";
import { PALETTE_TYPES } from "../../components/board-viewer/edit.js";
import {
	afterOptions,
	COMMON_FIELDS,
	expressionCompletions,
	STEP_FIELDS,
	STEP_HELP,
	stepPorts,
} from "../../components/board-viewer/step-form.js";

/** The step form's knowledge (owner, 2026-11-27: hover help and completion for pipelines). */

const context = {
	nodes: [
		{ id: "build", type: "command" },
		{ id: "check", type: "if" },
	],
	inputs: ["version", "channel"],
	functions: ["len", "join", "lower"],
};

const labels = (result: ReturnType<typeof expressionCompletions>) =>
	result?.items.map((item) => item.label);

describe("the step form", () => {
	it("knows every step type the palette adds, and explains every field", () => {
		for (const type of PALETTE_TYPES) {
			expect(STEP_HELP[type], type).toBeTruthy();
			expect(STEP_FIELDS[type], type).toBeTruthy();
		}
		for (const field of [
			...Object.values(STEP_FIELDS).flat(),
			...COMMON_FIELDS,
		]) {
			expect(field.help.length, field.key).toBeGreaterThan(10);
		}
	});

	it("offers each step and the outputs of a branching one to run after, not itself", () => {
		const nodes = [
			{ id: "build", type: "command" },
			{ id: "check", type: "if" },
			{ id: "route", type: "switch", cases: ["beta", "stable"] },
			{ id: "risky", type: "http", onError: "route" },
		];
		expect(afterOptions(nodes, "risky").map((option) => option.value)).toEqual([
			"build",
			"check.true",
			"check.false",
			"route.beta",
			"route.stable",
			"route.default",
		]);
		expect(stepPorts({ type: "approval" })).toEqual(["approve", "reject"]);
		expect(
			afterOptions(nodes, "build").map((option) => option.value),
		).toContain("risky.error");
	});

	it("completes an expression's names and functions at the caret, only inside {{ }} unless it is a condition", () => {
		expect(expressionCompletions("echo $no", 8, context)).toBeUndefined();
		const roots = expressionCompletions("echo {{ $no", 11, context);
		expect(labels(roots)).toEqual(["$node"]);
		expect(roots?.from).toBe(8);
		expect(labels(expressionCompletions("{{ $node.", 9, context))).toEqual([
			"build",
			"check",
		]);
		expect(
			expressionCompletions("{{ $node.b", 10, context)?.items[0]?.insert,
		).toBe("$node.build.");
		expect(
			labels(expressionCompletions("{{ $node.build.st", 17, context)),
		).toEqual(["stdout", "stderr"]);
		expect(labels(expressionCompletions("{{ $vars.v", 10, context))).toEqual([
			"version",
		]);
		expect(labels(expressionCompletions("{{ jo", 5, context))).toEqual([
			"join()",
		]);
		expect(
			expressionCompletions("{{ len(", 7, context)?.items.length,
		).toBeGreaterThan(3);
		// A condition is an expression throughout.
		expect(
			labels(expressionCompletions("$node.check.p", 13, context, true)),
		).toEqual(["port"]);
		// Past the closing braces it is text again.
		expect(
			expressionCompletions("{{ $item }} $no", 15, context),
		).toBeUndefined();
	});
});
