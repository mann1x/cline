import { describe, expect, it } from "vitest";
import { resolveCliCheckpointConfig } from "./defaults";

/**
 * The CLI mirrors the extension's Checkpoints switch.
 *
 * Ruled after the switch was found to gate nothing: "CLI follow the plugin. if
 * enabled on Plugin by default it's the same for CLI unless disabled." The
 * extension defaults the switch on, so the CLI does too — and the CLI had no
 * way to turn it off at all, which is the half that was missing.
 */
describe("the CLI's checkpoints switch", () => {
	it("is on when nothing says otherwise, like the extension's", () => {
		expect(resolveCliCheckpointConfig(undefined)).toEqual({ enabled: true });
		expect(resolveCliCheckpointConfig({})).toEqual({ enabled: true });
	});

	// Commander turns `--no-checkpoints` into `checkpoints: false`.
	it("is off when the run says --no-checkpoints", () => {
		expect(resolveCliCheckpointConfig({ checkpoints: false })).toEqual({
			enabled: false,
		});
	});

	it("treats an explicit --checkpoints as on", () => {
		expect(resolveCliCheckpointConfig({ checkpoints: true })).toEqual({
			enabled: true,
		});
	});
});
