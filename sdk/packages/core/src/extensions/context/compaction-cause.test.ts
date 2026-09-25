import type * as LlmsProviders from "@cline/llms";
import {
	recordOpencotiWindowFloor,
	recordPolykvGrantedWindow,
	resetOpencotiPressure,
	resetOpencotiWindowFloors,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "@cline/llms";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import { resolveCompactionCause } from "./compaction-cause";
import { resetKvPressureState } from "./kv-pressure";
import { clearPolykvAllocationCache } from "./polykv-session";

const base = {
	mode: "auto" as const,
	contextOverflow: false,
	overOwnThreshold: false,
	outputCapStarved: false,
	pressure: false,
};

describe("why a compaction ran", () => {
	it("is manual when the user asked for it, whatever else is true", () => {
		expect(
			resolveCompactionCause({
				...base,
				mode: "manual",
				overOwnThreshold: true,
				pressure: true,
			}),
		).toBe("manual");
	});

	it("is overflow recovery after the provider rejected the request", () => {
		expect(resolveCompactionCause({ ...base, mode: "overflow_recovery" })).toBe(
			"overflow",
		);
		expect(resolveCompactionCause({ ...base, contextOverflow: true })).toBe(
			"overflow",
		);
	});

	it("is the agent's own threshold when it crossed it, even under pressure", () => {
		expect(
			resolveCompactionCause({
				...base,
				overOwnThreshold: true,
				pressure: true,
			}),
		).toBe("auto");
		expect(resolveCompactionCause({ ...base, outputCapStarved: true })).toBe(
			"auto",
		);
	});

	it("is pressure only when pressure is the reason it compacted at all", () => {
		expect(resolveCompactionCause({ ...base, pressure: true })).toBe(
			"pressure",
		);
	});
});

// End to end through the pipeline's turn boundary against a stub engine: the
// notice the per-agent counter reads carries the cause.
const SESSION = "lead~agent-cause";
const ACTIVE = {
	window_s: 60,
	refused_60s: 4,
	refused_min_needed_min_60s: 65_536,
	last_refusal_age_s: 3,
	refusals_total: 20,
};

function json(value: unknown) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function engine(pressure: Record<string, unknown> | undefined) {
	return (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/props") {
			return json({
				features: ["kv_status_v1", "kv_pressure_v1", "kv_resize_v1"],
			});
		}
		if (url.pathname === "/kv") {
			return json({
				allocations: [
					{
						session_id: SESSION,
						window: 262_144,
						used: 150_000,
						pressure: 150_000 / 262_144,
					},
				],
				...(pressure ? { pressure } : {}),
			});
		}
		if (url.pathname.endsWith("/resize")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			return json({ ok: true, window: 262_144, window_new: body.num_ctx });
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
}

async function compactOnce(options: {
	pressure?: Record<string, unknown>;
	contextWindow: number;
}) {
	const notices: Array<{
		message: string;
		metadata?: Record<string, unknown>;
	}> = [];
	const prepareTurn = createContextCompactionPrepareTurn({
		providerId: "opencoti",
		modelId: "m",
		sessionId: SESSION,
		providerConfig: {
			providerId: "opencoti",
			modelId: "m",
			baseUrl: "http://engine/v1",
			fetch: engine(options.pressure),
			polykv: { enabled: false },
			engineSessionId: SESSION,
		} as unknown as LlmsProviders.ProviderConfig,
		compaction: {
			enabled: true,
			strategy: "basic",
			compact: async () => ({
				messages: [{ role: "user", content: "summary ".repeat(200) }],
			}),
		} as never,
	});
	const messages: LlmsProviders.Message[] = [
		{ role: "user", content: "x".repeat(600_000) },
	];
	await prepareTurn?.({
		agentId: "agent-1",
		conversationId: SESSION,
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
			info: { id: "m", contextWindow: options.contextWindow, maxTokens: 8_192 },
		},
		emitStatusNotice: (message: string, metadata?: Record<string, unknown>) =>
			notices.push({ message, metadata }),
	} as never);
	return notices.find((notice) => notice.metadata?.phase === "completed");
}

describe("the completed-compaction notice", () => {
	beforeEach(() => {
		resetPolykvSessions();
		resetPolykvAvailability();
		resetOpencotiPressure();
		resetOpencotiWindowFloors();
		resetKvPressureState();
		clearPolykvAllocationCache();
		recordPolykvGrantedWindow(SESSION, 262_144, { asked: 262_144 });
		recordOpencotiWindowFloor(SESSION, 1_000);
	});
	afterEach(() => {
		resetPolykvSessions();
	});

	it("says pressure when the server's KV pressure asked for it", async () => {
		const completed = await compactOnce({
			pressure: ACTIVE,
			contextWindow: 262_144,
		});
		expect(completed?.metadata).toMatchObject({
			kind: "auto_compaction",
			cause: "pressure",
		});
	});

	it("says auto when the agent filled its own window", async () => {
		recordPolykvGrantedWindow(SESSION, 65_536, { asked: 65_536 });
		const completed = await compactOnce({ contextWindow: 65_536 });
		expect(completed?.metadata).toMatchObject({
			kind: "auto_compaction",
			cause: "auto",
		});
	});
});
