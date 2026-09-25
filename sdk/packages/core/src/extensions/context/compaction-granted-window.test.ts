import type * as LlmsProviders from "@cline/llms";
import {
	recordPolykvGrantedWindow,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import { clearPolykvAllocationCache } from "./polykv-session";

/**
 * A conversation negotiated down to 32k of a configured 128k holds 32k for its
 * life. Every compaction threshold computed against 128k fires after the real
 * window has already run out, so compaction sizes against the grant.
 */
describe("compaction on a negotiated-down window", () => {
	afterEach(resetPolykvSessions);

	async function measuredMaxInput(sessionId: string, providerId: string) {
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId,
			modelId: "m",
			sessionId,
			providerConfig: {
				providerId,
				modelId: "m",
			} as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic" },
			logger: undefined,
		});
		const notices: Array<Record<string, unknown>> = [];
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "start" },
		];
		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: sessionId,
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "m",
				provider: providerId,
				info: { id: "m", contextWindow: 131_072, maxTokens: 8_192 },
			},
			emitStatusNotice: (
				_message: string,
				metadata?: Record<string, unknown>,
			) => {
				if (metadata) {
					notices.push(metadata);
				}
			},
		} as never);
		return notices.find((notice) => notice.kind === "context_breakdown")
			?.maxInputTokens as number | undefined;
	}

	it("sizes against the granted window when it is smaller", async () => {
		recordPolykvGrantedWindow("conv-granted", 32_768, { asked: 131_072 });
		const granted = await measuredMaxInput("conv-granted", "opencoti");
		expect(granted).toBeLessThanOrEqual(32_768);
	});

	it("sizes against the configured window when nothing smaller was granted", async () => {
		const configured = await measuredMaxInput("conv-free", "opencoti");
		expect(configured).toBeGreaterThan(32_768);
	});
});

/**
 * A delegated agent on a PolyKV node: its compaction reads the pressure of the
 * booking it lives in and sizes against the window it actually has. Both were
 * missing for every worker -- it read no `/kv` row, and it sized against the
 * node's static 256k while its owner held a fraction of that.
 */
describe("compaction in a delegated agent on a PolyKV node", () => {
	afterEach(() => {
		resetPolykvSessions();
		resetPolykvAvailability();
		clearPolykvAllocationCache();
	});

	function kvEngine(allocations: Array<Record<string, unknown>>) {
		return (async (input: unknown) => {
			const url = new URL(String(input));
			if (url.pathname === "/props") {
				return Response.json({ features: ["kv_status_v1"] });
			}
			if (url.pathname === "/kv") {
				return Response.json({ allocations });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
	}

	async function diagnose(
		sessionId: string,
		fetchImpl: typeof fetch,
		contextWindow = 256_000,
	) {
		const diagnostics: Array<Record<string, unknown>> = [];
		const logger = {
			debug: (message: string, metadata?: Record<string, unknown>) => {
				if (message === "Context compaction diagnostics" && metadata) {
					diagnostics.push(metadata);
				}
			},
			log: () => {},
		};
		const prepareTurn = createContextCompactionPrepareTurn({
			providerId: "opencoti",
			modelId: "m",
			sessionId,
			providerConfig: {
				providerId: "opencoti",
				modelId: "m",
				baseUrl: "http://engine/v1",
				fetch: fetchImpl,
				polykv: { compactionPressureThreshold: 0.85 },
				engineSessionId: sessionId,
				polykvWorker: { group: "lead", layers: 2, attachOnly: true },
			} as unknown as LlmsProviders.ProviderConfig,
			compaction: { enabled: true, strategy: "basic" },
			logger: logger as never,
		});
		const messages: LlmsProviders.Message[] = [
			{ role: "user", content: "start" },
		];
		await prepareTurn?.({
			agentId: "agent-1",
			conversationId: sessionId,
			parentAgentId: null,
			iteration: 1,
			abortSignal: new AbortController().signal,
			systemPrompt: "You are helpful.",
			tools: [],
			messages,
			apiMessages: messages,
			model: {
				id: "m",
				provider: "opencoti",
				info: { id: "m", contextWindow, maxTokens: 8_192 },
			},
		} as never);
		return diagnostics[0];
	}

	it("compacts at the threshold on its own row's pressure", async () => {
		const found = await diagnose(
			"lead~agent-p",
			kvEngine([
				{
					session_id: "lead~agent-p",
					window: 65_536,
					used: 58_982,
					pressure: 0.9,
				},
			]),
		);
		expect(found?.polykvRawPressure).toBe(0.9);
		expect(found?.polykvPressure).toBe(true);
		expect(found?.shouldCompact).toBe(true);
	});

	it("does not compact below the threshold", async () => {
		const found = await diagnose(
			"lead~agent-q",
			kvEngine([
				{ session_id: "lead~agent-q", window: 65_536, used: 1, pressure: 0.5 },
			]),
		);
		expect(found?.polykvRawPressure).toBe(0.5);
		expect(found?.shouldCompact).toBe(false);
	});

	it("sizes against the window the worker's turns were served in, not 256000", async () => {
		// What the worker's fetch records off `X-Context-Window`.
		recordPolykvGrantedWindow("lead~agent-w", 65_536);
		const found = await diagnose("lead~agent-w", kvEngine([]));
		expect(found?.grantedContextWindow).toBe(65_536);
		expect(found?.maxInputTokens as number).toBeLessThanOrEqual(65_536);
	});
});
