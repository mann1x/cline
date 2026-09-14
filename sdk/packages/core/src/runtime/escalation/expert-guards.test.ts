import type { AgentEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createExpertGuards, type ExpertGuardVerdict } from "./expert-guards";

function collector() {
	const seen: ExpertGuardVerdict[] = [];
	return {
		seen,
		onVerdict: (verdict: ExpertGuardVerdict) => seen.push(verdict),
	};
}

function toolCall(name: string, input: unknown): AgentEvent {
	return {
		type: "content_start",
		contentType: "tool",
		toolName: name,
		input,
	} as unknown as AgentEvent;
}

function turn(iteration: number): AgentEvent {
	return { type: "iteration_start", iteration } as unknown as AgentEvent;
}

describe("guards on the expert's channels", () => {
	it("says nothing while the expert is doing different things", () => {
		const { seen, onVerdict } = createGuardsWith();
		const guards = createExpertGuards({ onVerdict });

		guards.observe(turn(1));
		guards.observe(toolCall("editor", { path: "a.js", text: "one" }));
		guards.observe(toolCall("editor", { path: "b.js", text: "two" }));
		guards.observe(toolCall("read_files", { files: [{ path: "c.js" }] }));

		expect(seen).toEqual([]);
	});

	it("reports the expert repeating one call", () => {
		const { seen, onVerdict } = createGuardsWith();
		const guards = createExpertGuards({ onVerdict });
		const same = toolCall("editor", { path: "a.js", text: "one" });

		guards.observe(turn(1));
		for (let i = 0; i < 6; i += 1) {
			guards.observe(same);
		}

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.kind).toBe("loop");
		// Written about the expert, for the base model to read. A verdict
		// worded at the model that is looping tells the reader to stop doing
		// something it is not doing.
		expect(seen[0]?.text).toContain("The expert");
	});

	it("says the same thing once, however many times the evidence holds", () => {
		const { seen, onVerdict } = createGuardsWith();
		const guards = createExpertGuards({ onVerdict });
		const same = toolCall("editor", { path: "a.js", text: "one" });

		guards.observe(turn(1));
		for (let i = 0; i < 20; i += 1) {
			guards.observe(same);
		}

		const loops = seen.filter((verdict) => verdict.kind === "loop");
		expect(loops.length).toBeLessThan(4);
	});

	it("forgets everything when the escalation ends", () => {
		const { seen, onVerdict } = createGuardsWith();
		const guards = createExpertGuards({ onVerdict });
		const same = toolCall("editor", { path: "a.js", text: "one" });
		guards.observe(turn(1));
		for (let i = 0; i < 6; i += 1) {
			guards.observe(same);
		}
		const before = seen.length;

		guards.reset();
		for (let i = 0; i < 6; i += 1) {
			guards.observe(same);
		}

		// A second escalation is a second question. Carrying the first one's
		// repetitions into it would have the base told the expert is looping
		// before it has done anything.
		expect(seen.length).toBeGreaterThan(before);
	});

	function createGuardsWith() {
		return collector();
	}
});
