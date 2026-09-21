import { describe, expect, it } from "vitest";
import { resolveCliReasoning } from "./reasoning";

describe("resolveCliReasoning", () => {
	it("leaves reasoning unset when neither CLI nor persisted settings specify it", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
			}),
		).toEqual({
			thinking: undefined,
			reasoningEffort: undefined,
		});
	});

	it("preserves explicit --thinking none as disabled reasoning", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
				thinkingExplicitlySet: true,
			}),
		).toEqual({
			thinking: false,
			reasoningEffort: undefined,
		});
	});

	it("prefers explicit --thinking over persisted reasoning settings", () => {
		expect(
			resolveCliReasoning({
				thinking: true,
				thinkingExplicitlySet: true,
				reasoningEffort: "low",
				persistedReasoning: { enabled: false },
			}),
		).toEqual({
			thinking: true,
			reasoningEffort: "low",
		});
	});

	it("uses persisted disabled reasoning when --thinking is unset", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
				persistedReasoning: { enabled: false },
			}),
		).toEqual({
			thinking: false,
			reasoningEffort: undefined,
		});
	});

	it("uses persisted effort none as disabled reasoning when --thinking is unset", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
				persistedReasoning: { effort: "none" },
			}),
		).toEqual({
			thinking: false,
			reasoningEffort: undefined,
		});
	});

	it("uses persisted active effort when --thinking is unset", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
				persistedReasoning: { enabled: true, effort: "high" },
			}),
		).toEqual({
			thinking: true,
			reasoningEffort: "high",
		});
	});

	it("names no effort when persisted reasoning is enabled without one", () => {
		expect(
			resolveCliReasoning({
				thinking: false,
				persistedReasoning: { enabled: true },
			}),
		).toEqual({
			thinking: true,
			// Enabled without a level means "on, provider decides". Naming a
			// level here is not a harmless default: on Ollama a level *is* a
			// thinking budget and it outranks the model's own
			// `PARAMETER think_budget`, so `medium` capped an unbounded model at
			// 2,000 tokens and halved one declaring `high`. Measured on 0.34.2.
			reasoningEffort: undefined,
		});
	});
});
