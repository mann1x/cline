import { describe, expect, it } from "vitest";
import {
	createCompactionProgress,
	planCompactionSteps,
} from "./agentic-compaction";

describe("planCompactionSteps", () => {
	it("counts the summary, the retrospective and the council's three", () => {
		expect(
			planCompactionSteps({
				thinkingSummaryEnabled: true,
				councilEnabled: true,
			}),
		).toBe(5);
	});

	it("counts only what is switched on", () => {
		expect(
			planCompactionSteps({
				thinkingSummaryEnabled: false,
				councilEnabled: false,
			}),
		).toBe(1);
		expect(
			planCompactionSteps({
				thinkingSummaryEnabled: true,
				councilEnabled: false,
			}),
		).toBe(2);
	});
});

describe("createCompactionProgress", () => {
	function record(total: number) {
		const seen: string[] = [];
		const progress = createCompactionProgress(total, (p) =>
			seen.push(`${p.stepLabel} ${p.step}/${p.stepTotal}`),
		);
		return { seen, progress };
	}

	it("walks the plan", () => {
		const { seen, progress } = record(5);

		progress.step("summary");
		progress.step("retrospective");
		progress.step("review");

		expect(seen).toEqual(["summary 1/5", "retrospective 2/5", "review 3/5"]);
	});

	it("grows the total when a stage is retried", () => {
		// The retry is an extra call, not a stage that vanished. A total that
		// stayed put would print (4/4) with the summary written three times and
		// the council still to come -- a number that says the opposite of what
		// is happening.
		const { seen, progress } = record(2);

		progress.step("summary");
		progress.step("summary");
		progress.step("summary");
		progress.step("retrospective");

		expect(seen).toEqual([
			"summary 1/2",
			"summary 2/2",
			"summary 3/3",
			"retrospective 4/4",
		]);
	});

	it("never reports a step past its own total", () => {
		const { seen, progress } = record(1);

		for (let i = 0; i < 6; i += 1) {
			progress.step("summary");
		}

		for (const line of seen) {
			const [step, total] = line.split(" ")[1].split("/").map(Number);
			expect(step).toBeLessThanOrEqual(total);
		}
	});
});
