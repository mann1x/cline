import { describe, expect, it } from "vitest";
import { GatewayRegistry } from "./registry";

/**
 * The replay settings have to survive **both** explicit copies in the registry.
 *
 * `configureProvider` stores the host's config and `createProvider` rebuilds it
 * for the request, each naming every field it copies. The object the second one
 * returns is `context.config` at request time, so a field missing from either
 * reads as `undefined` at the only place that decides how much prior reasoning
 * to replay — with nothing logged and no type error.
 *
 * That is what happened: `reasoningHistory` was declared on
 * `GatewayProviderSettings`, set by the host, carried correctly through
 * `handler-factory`, and dropped by both lists. Every setting — `auto`, `none`,
 * `last`, `all` — produced the same request, and a transcript holding 2,297
 * characters of reasoning replayed none of it.
 */
describe("the registry keeps the replay settings", () => {
	function resolved(settings: {
		reasoningHistory?: string;
		reasoningInline?: boolean;
	}) {
		const registry = new GatewayRegistry();
		registry.registerProvider({
			manifest: {
				id: "ollama",
				name: "Ollama",
				defaultModelId: "m",
				models: [{ id: "m", providerId: "ollama" }],
			},
			createProvider: () => ({}) as never,
		} as never);
		registry.configureProvider({
			providerId: "ollama",
			...settings,
		} as never);
		return registry.createProvider("ollama");
	}

	it("carries them through configure and create", async () => {
		const { config } = (await resolved({
			reasoningHistory: "all",
			reasoningInline: false,
		})) as {
			config: { reasoningHistory?: unknown; reasoningInline?: unknown };
		};

		expect(config.reasoningHistory).toBe("all");
		expect(config.reasoningInline).toBe(false);
	});

	it("leaves them undefined when the host set neither", async () => {
		const { config } = (await resolved({})) as {
			config: { reasoningHistory?: unknown };
		};

		expect(config.reasoningHistory).toBeUndefined();
	});
});
