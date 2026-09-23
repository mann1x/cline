import { describe, expect, it } from "vitest";
import { readAgentsField } from "./spawn-agent-tool";

describe("readAgentsField", () => {
	it("takes an array as it is", () => {
		const input = { agents: [{ task: "a" }] };
		expect(readAgentsField(input as never)).toBe(input);
	});

	it("reads a list sent as JSON text", () => {
		expect(
			readAgentsField({ agents: '[{"task": "a"}]' } as never).agents,
		).toEqual([{ task: "a" }]);
	});

	it("reads the list with the call's other fields run on after it, and keeps them", () => {
		// pandorum 2026-09-23 (5rybo), twice: this string reached the batch,
		// which failed with `a.map is not a function`.
		const read = readAgentsField({
			task: "shared",
			agents: '[{"name": "CV-1", "task": "a"}], "merge": true, "count": 2',
		} as never);
		expect(read.agents).toEqual([{ name: "CV-1", task: "a" }]);
		expect(read.merge).toBe(true);
		expect(read.count).toBe(2);
		expect(read.task).toBe("shared");
	});

	it("lets a field the call set win over one that bled into the text", () => {
		const read = readAgentsField({
			merge: false,
			agents: '[{"task": "a"}], "merge": true',
		} as never);
		expect(read.merge).toBe(false);
	});

	it("takes nothing else from the text but the known fields", () => {
		const read = readAgentsField({
			agents: '[{"task": "a"}], "cwd": "/etc"',
		} as never) as Record<string, unknown>;
		expect(read.cwd).toBeUndefined();
	});

	it("refuses text that does not parse, saying how to send it", () => {
		expect(() => readAgentsField({ agents: '[{"task": "a"' } as never)).toThrow(
			/arrived as text.*array of objects/s,
		);
	});

	it("refuses an entry without a task, by index", () => {
		expect(() =>
			readAgentsField({ agents: [{ task: "a" }, { name: "b" }] } as never),
		).toThrow(/agents\[1\]` has no `task`/);
	});
});
