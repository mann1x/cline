import { describe, expect, it } from "vitest";
import {
	applyCliCompactionMode,
	buildCliCompactionConfig,
	DEFAULT_CLI_COMPACTION_MODE,
	formatCliCompactionMode,
	getCliCompactionMode,
	getNextCliCompactionMode,
	parseCliCompactionMode,
} from "./compaction-mode";
import type { Config } from "./types";

function createConfig(compaction?: Config["compaction"]): Config {
	return { compaction } as Config;
}

describe("CLI compaction mode helpers", () => {
	it("defaults enabled compaction to agentic summarization", () => {
		expect(DEFAULT_CLI_COMPACTION_MODE).toBe("agentic");
		expect(getCliCompactionMode(createConfig())).toBe(
			DEFAULT_CLI_COMPACTION_MODE,
		);
		expect(formatCliCompactionMode(DEFAULT_CLI_COMPACTION_MODE)).toBe("LLM");
	});

	it("maps basic and off modes to core compaction config", () => {
		const config = createConfig({ enabled: true, preserveRecentTokens: 123 });

		applyCliCompactionMode(config, "basic");
		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "basic",
			preserveRecentTokens: 123,
		});
		expect(getCliCompactionMode(config)).toBe("basic");

		applyCliCompactionMode(config, "off");
		expect(config.compaction).toEqual({
			enabled: false,
			preserveRecentTokens: 123,
		});
		expect(getCliCompactionMode(config)).toBe("off");
	});

	it("builds default and explicit core compaction config", () => {
		expect(buildCliCompactionConfig()).toEqual({
			enabled: true,
		});
		expect(buildCliCompactionConfig("agentic")).toEqual({
			enabled: true,
			strategy: "agentic",
		});
		expect(buildCliCompactionConfig("off")).toEqual({ enabled: false });
	});

	it("parses one CLI spelling per compaction mode", () => {
		expect(parseCliCompactionMode("agentic")).toBe("agentic");
		expect(parseCliCompactionMode("basic")).toBe("basic");
		expect(parseCliCompactionMode("off")).toBe("off");
		expect(parseCliCompactionMode("llm")).toBeUndefined();
		expect(parseCliCompactionMode("truncation")).toBeUndefined();
		expect(parseCliCompactionMode("truncate")).toBeUndefined();
		expect(parseCliCompactionMode("none")).toBeUndefined();
		expect(parseCliCompactionMode("disabled")).toBeUndefined();
	});

	it("does not mutate compaction when applying an undefined mode", () => {
		const config = createConfig({ enabled: true, strategy: "agentic" });

		applyCliCompactionMode(config, undefined);

		expect(config.compaction).toEqual({
			enabled: true,
			strategy: "agentic",
		});
	});

	it("cycles TUI choices in a stable order", () => {
		expect(getNextCliCompactionMode("basic")).toBe("agentic");
		expect(getNextCliCompactionMode("agentic")).toBe("off");
		expect(getNextCliCompactionMode("off")).toBe("basic");
	});
});

/**
 * The compaction the tail stops surviving, as an arm can set it.
 *
 * The default is measured and lives in core; what the CLI owes is a way to run
 * the arm that checks it, including the arm that turns it off.
 */
describe("the forced full compaction", () => {
	it("is absent unless asked for, so core's measured default applies", () => {
		expect(buildCliCompactionConfig("agentic")).toEqual({
			enabled: true,
			strategy: "agentic",
		});
	});

	it("carries the compaction it starts at", () => {
		expect(buildCliCompactionConfig("agentic", 3)).toEqual({
			enabled: true,
			strategy: "agentic",
			forceFullFromCompaction: 3,
		});
	});

	// Zero is the off switch and has to survive as a value: a `?? default` or a
	// positive-only parser between here and core would read it as "unset" and
	// turn the behaviour back on.
	it("keeps a zero, which is how the behaviour is turned off", () => {
		expect(buildCliCompactionConfig("agentic", 0)).toEqual({
			enabled: true,
			strategy: "agentic",
			forceFullFromCompaction: 0,
		});
	});

	it("says nothing about the tail when compaction is off entirely", () => {
		expect(buildCliCompactionConfig("off", 2)).toEqual({ enabled: false });
	});
});
