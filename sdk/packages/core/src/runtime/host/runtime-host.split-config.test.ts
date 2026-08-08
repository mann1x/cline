import { describe, expect, it } from "vitest";
import { splitCoreSessionConfig } from "./runtime-host";

/**
 * `splitCoreSessionConfig` decides which half of the session config crosses a
 * transport and which stays local. Anything carrying a callback has to stay
 * local — and a field on the wrong side fails silently: the runtime simply
 * never sees it, and the feature it drives looks like the model declining to
 * use it. Measured: with `taskProgress` on the transport side, two full live
 * sessions produced zero `task_progress` values.
 */
describe("splitCoreSessionConfig", () => {
	const base = {
		providerId: "ollama",
		modelId: "m",
		cwd: "/tmp",
		systemPrompt: "s",
	} as never;

	it("keeps taskProgress on the local runtime, not the transport", () => {
		const onUpdate = () => {};
		const split = splitCoreSessionConfig({
			...(base as object),
			taskProgress: { enabled: true, reminderInterval: 6, onUpdate },
		} as never);

		expect(split.localRuntime?.taskProgress).toMatchObject({
			enabled: true,
			reminderInterval: 6,
		});
		expect(split.localRuntime?.taskProgress?.onUpdate).toBe(onUpdate);
		expect(
			(split.config as Record<string, unknown>).taskProgress,
		).toBeUndefined();
	});

	it("omits it entirely when the host did not ask for a checklist", () => {
		const split = splitCoreSessionConfig({ ...(base as object) } as never);
		expect(split.localRuntime?.taskProgress).toBeUndefined();
	});

	it("carries every compaction field except the callback across the transport", () => {
		// The whole compaction config minus `compact`, checked by subtraction:
		// this used to be a list of five fields, and the seven added after it
		// was written were dropped on the way to the runtime — including the
		// thinking budget, without which the capped-thinking condenser arms and
		// can never detect anything. A test naming one field would have gone
		// stale the same way the implementation did.
		const compact = () => undefined;
		const compaction = {
			enabled: true,
			strategy: "agentic",
			summaryPrompt: "summarise like this",
			thinkingSummaryEnabled: true,
			thinkingSummaryPrompt: "retrospect like this",
			cappedThinkingEnabled: true,
			cappedThinkingPrompt: "note like this",
			cappedThinkingBudgetMessage: "I have used my thinking budget.",
			thinkingBudgetTokens: 16_000,
			preserveRecentTokens: 4_000,
			preserveRecentMessagesRatio: 0.5,
			summarizer: { providerId: "ollama", modelId: "m" },
			compact,
		};

		const split = splitCoreSessionConfig({
			...(base as object),
			compaction,
		} as never);

		const { compact: _omitted, ...expected } = compaction;
		expect(split.config.compaction).toEqual(expected);
		expect(
			(split.config.compaction as Record<string, unknown>).compact,
		).toBeUndefined();
		// The callback keeps the whole thing local as well, so a host that
		// supplies one still gets its own fields back.
		expect(split.localRuntime?.compaction?.compact).toBe(compact);
	});
});
