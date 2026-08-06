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
});
