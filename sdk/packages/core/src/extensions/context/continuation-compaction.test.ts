import type * as LlmsProviders from "@cline/llms";
import {
	getPolykvSession,
	resetPolykvAvailability,
	resetPolykvSessions,
	setPolykvSession,
} from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { describeReplaySpan, runAgenticCompaction } from "./agentic-compaction";
import { resolveRecencyBounds } from "./compaction-shared";
import {
	type ContinuationCall,
	ContinuationCallError,
	type ContinuationCallResult,
	createCompactionMeter,
	describeCompactionRun,
	exactBooking,
	type PrepareContinuationInput,
	prepareCompactionContinuation,
} from "./continuation-compaction";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
	reasoningHistoryModeForProvider: () => "all",
}));

const FEATURES = {
	guaranteed: "elastic_guaranteed_alloc_v1",
	kv: "kv_status_v1",
	subpools: "polykv_subpools_v1",
	close: "session_close_v1",
	privateWindow: "polykv_private_window_v1",
};
const POOLED = [
	FEATURES.guaranteed,
	FEATURES.kv,
	FEATURES.subpools,
	FEATURES.close,
];

interface EngineOptions {
	features?: string[];
	poolsEnabled?: boolean;
	allocations?: Array<{ session_id: string; window: number; used: number }>;
	/** The owner every pool the engine makes reports; "" is unowned. */
	owner?: string;
	/** Path substrings answered 500. */
	fail?: string[];
	prefixLen?: number;
}

/**
 * A stand-in opencoti that keeps the books a leak test needs: which pools
 * exist and are pinned, which sessions were closed, which slots erased.
 */
function engine(options: EngineOptions = {}) {
	const calls: string[] = [];
	const pools = new Map<string, { pinned: boolean; parent: string }>();
	const closed: string[] = [];
	const erased: string[] = [];
	let seq = 0;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		const path = `${url.pathname}${url.search}`;
		calls.push(`${method} ${path}`);
		if (options.fail?.some((part) => path.includes(part))) {
			return new Response("nope", { status: 500 });
		}
		if (url.pathname === "/props") {
			return Response.json({
				features: options.features ?? POOLED,
				opencoti: { polykv: { pools_enabled: options.poolsEnabled ?? true } },
			});
		}
		if (url.pathname === "/kv") {
			return Response.json({ allocations: options.allocations ?? [] });
		}
		if (url.pathname === "/polykv/pools" && method === "POST") {
			const id = String(seq++);
			pools.set(id, { pinned: body.pin === true, parent: "-1" });
			return Response.json({
				pool_id: id,
				parent: -1,
				prefix_len: options.prefixLen ?? 2_950,
				owner: options.owner ?? "",
			});
		}
		const fork = /^\/polykv\/pools\/([^/]+)\/fork$/.exec(url.pathname);
		if (fork) {
			const id = String(seq++);
			pools.set(id, { pinned: body.pin === true, parent: fork[1] });
			return Response.json({
				pool_id: id,
				parent: Number(fork[1]),
				prefix_len: Number(body.branch_pos) + 480,
				owner: options.owner ?? "",
			});
		}
		const action = /^\/polykv\/pools\/([^/]+)\/(pin|unpin|release)$/.exec(
			url.pathname,
		);
		if (action) {
			const pool = pools.get(action[1]);
			if (action[2] === "release") {
				pools.delete(action[1]);
			} else if (pool) {
				pool.pinned = action[2] === "pin";
			}
			return new Response(null, { status: 204 });
		}
		const close = /^\/sessions\/([^/]+)\/close$/.exec(url.pathname);
		if (close) {
			closed.push(decodeURIComponent(close[1]));
			return Response.json({ found: true, kv_dropped: true });
		}
		if (url.pathname === "/slots") {
			return Response.json([{ id: 4, opencoti: { session_id: "lead" } }]);
		}
		if (url.pathname === "/slots/4") {
			erased.push("lead");
			return Response.json({ id_slot: 4, n_erased: 9_000 });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls, pools, closed, erased };
}

const SUMMARY = [
	"## First\nRead the files and found the bug in the parser.",
	"<<<HALFWAY>>>",
	"## Second\nFixed the parser; the next step is the test.",
].join("\n\n");

/** A model that answers by purpose and records what it was sent. */
function model(
	options: {
		cached?: Partial<Record<ContinuationCall["purpose"], number>>;
		fail?: (call: ContinuationCall, index: number) => Error | undefined;
		onCall?: (call: ContinuationCall) => void;
	} = {},
) {
	const calls: ContinuationCall[] = [];
	const fn = async (
		call: ContinuationCall,
	): Promise<ContinuationCallResult> => {
		calls.push(call);
		options.onCall?.(call);
		const failure = options.fail?.(call, calls.length - 1);
		if (failure) {
			throw failure;
		}
		const text =
			call.purpose === "writer"
				? SUMMARY
				: call.purpose === "critic"
					? call.messages.at(-1)?.content.toString().includes("first")
						? "## First\nRead the files; the bug is in the parser."
						: "## Second\nFixed the parser; the test is next."
					: call.purpose === "synthesizer"
						? "## Merged\nThe parser is fixed; the test is next."
						: "retrospective";
		return {
			text,
			reasoningChars: 0,
			timings: {
				engine: "llamacpp",
				promptTokens: 40,
				cachedTokens: options.cached?.[call.purpose] ?? 2_900,
			},
		};
	};
	return { fn, calls };
}

function messages(): MessageWithMetadata[] {
	const out: MessageWithMetadata[] = [
		{
			role: "user",
			content: "fix the parser, and never touch generated files",
		},
	];
	for (let index = 0; index < 6; index += 1) {
		out.push({
			role: "assistant",
			content: [
				{ type: "text", text: `step ${index}. ${"detail ".repeat(150)}` },
				{
					type: "tool_use",
					id: `t${index}`,
					name: "read_files",
					input: { path: `file-${index}.ts` },
				},
			],
		});
		out.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `t${index}`,
					name: "read_files",
					content: `result ${index}. ${"line ".repeat(150)}`,
				},
			],
		});
	}
	return out;
}

function input(
	server: ReturnType<typeof engine>,
	overrides: Omit<Partial<PrepareContinuationInput>, "providerConfig"> & {
		providerConfig?: Record<string, unknown>;
	} = {},
): PrepareContinuationInput {
	const { providerConfig, ...rest } = overrides;
	return {
		providerConfig: {
			providerId: "opencoti",
			modelId: "m",
			baseUrl: "http://engine/v1",
			fetch: server.fetch,
			...providerConfig,
		} as never,
		sessionId: "lead",
		systemPrompt: "You are the agent.",
		tools: [{ name: "read_files", description: "reads", inputSchema: {} }],
		apiMessages: messages(),
		contextWindow: 65_536,
		requestTokens: 20_000,
		observedRequestTokens: 20_000,
		reasoning: { thinking: true, thinkingBudgetTokens: 4_096 },
		separateSummarizer: false,
		kvPressureActive: false,
		overflowRecovery: false,
		sleep: async () => {},
		serial: 1,
		...rest,
	};
}

/** Nothing the compaction made is still standing. */
function expectNothingLeft(server: ReturnType<typeof engine>): void {
	expect([...server.pools.keys()]).toEqual([]);
}

afterEach(() => {
	resetPolykvSessions();
	resetPolykvAvailability();
	createHandlerMock.mockReset();
});

describe("whether a compaction can continue the session", () => {
	it("is off when the setting says so", async () => {
		const server = engine();
		const prepared = await prepareCompactionContinuation(
			input(server, {
				providerConfig: { polykv: { continuationCompaction: false } },
			}),
		);
		expect(prepared.continuation).toBeUndefined();
		expect(prepared.reason).toContain("switched off");
		expect(server.calls).toEqual([]);
	});

	it("is off for a summarizer of its own, a hosted API, and overflow recovery", async () => {
		const server = engine();
		for (const [override, words] of [
			[{ separateSummarizer: true }, "summarizer model of its own"],
			[{ providerConfig: { providerId: "anthropic" } }, "keeps no prefix"],
			[{ overflowRecovery: true }, "overflow recovery"],
			[{ requestTokens: 64_000 }, "no room in the window"],
		] as const) {
			const prepared = await prepareCompactionContinuation(
				input(server, override as never),
			);
			expect(prepared.continuation).toBeUndefined();
			expect(prepared.reason).toContain(words);
		}
		expect(server.calls).toEqual([]);
	});

	// Ollama and llama.cpp keep the previous prompt's cache: steps 1 and 3
	// still apply, the pool steps are skipped.
	it("continues on ollama without a single control-plane call", async () => {
		const server = engine();
		const m = model();
		const prepared = await prepareCompactionContinuation(
			input(server, {
				providerConfig: { providerId: "ollama" },
				model: m.fn,
			}),
		);
		const c = prepared.continuation;
		expect(c?.path).toBe("continuation");
		await c?.write("write the replay", 2_000);
		const plan = await c?.afterWriter(SUMMARY.length, 2_000);
		expect(plan?.critics).toBe("serial");
		await c?.critic("first", "critic", "first half", 2_000);
		await c?.dispose();
		expect(server.calls).toEqual([]);
		// The writer is the session's next turn: its prompt, tools and
		// messages, plus the instruction, with tools off.
		const writer = m.calls[0];
		expect(writer?.systemPrompt).toBe("You are the agent.");
		expect(writer?.tools).toHaveLength(1);
		expect(writer?.toolChoice).toBe("none");
		expect(writer?.messages).toHaveLength(messages().length + 1);
		expect(writer?.reasoning).toEqual({
			thinking: true,
			thinkingBudgetTokens: 4_096,
		});
		// The critic continues the writer's turn.
		const critic = m.calls[1];
		expect(critic?.messages).toHaveLength(messages().length + 3);
		expect(critic?.messages.at(-2)).toMatchObject({ role: "assistant" });
	});

	it("is a plain continuation on an opencoti without pools", async () => {
		const server = engine({ poolsEnabled: false });
		const prepared = await prepareCompactionContinuation(
			input(server, { model: model().fn }),
		);
		expect(prepared.continuation?.path).toBe("continuation");
		expect(prepared.reason).toContain("does not advertise");
		await prepared.continuation?.dispose();
		expectNothingLeft(server);
	});

	it("takes no pools and no bookings while the server refuses them", async () => {
		const server = engine();
		const prepared = await prepareCompactionContinuation(
			input(server, { kvPressureActive: true, model: model().fn }),
		);
		expect(prepared.continuation?.path).toBe("continuation");
		expect(server.calls.some((c) => c.includes("/polykv/pools"))).toBe(false);
		await prepared.continuation?.dispose();
	});
});

describe("the pooled continuation on an owned session", () => {
	const held = [{ session_id: "lead", window: 65_536, used: 21_000 }];

	it("freezes P, writes, forks P' at the writer's cache, and releases leaves first", async () => {
		// The session's head is its own root pool: dropping its slot is free.
		setPolykvSession("lead", { poolId: "root", prefixTokens: 1_200 });
		const server = engine({ allocations: held, owner: "lead" });
		const m = model({ cached: { writer: 2_922 } });
		const prepared = await prepareCompactionContinuation(
			input(server, { model: m.fn }),
		);
		const c = prepared.continuation;
		expect(c?.path).toBe("pooled");
		expect(server.calls).toContain("POST /polykv/pools");

		await c?.write("write the replay", 2_000);
		// A held booking: the writer runs in it, and books nothing more.
		expect(m.calls[0]?.providerConfig.polykvBooking).toBeUndefined();

		const plan = await c?.afterWriter(SUMMARY.length, 2_000);
		expect(plan?.critics).toBe("concurrent");
		const forkCall = server.calls.find((call) => call.endsWith("/fork"));
		expect(forkCall).toBe("POST /polykv/pools/0/fork");

		await Promise.all([
			c?.critic("first", "critic", "first half", 2_000),
			c?.critic("second", "critic", "second half", 2_000),
		]);
		// Each critic attaches P' under its own id, and is closed once it answers.
		const criticIds = m.calls
			.filter((call) => call.purpose === "critic")
			.map((call) => call.providerConfig.engineSessionId);
		expect(criticIds).toEqual([
			"lead~cc1-critic-first",
			"lead~cc1-critic-second",
		]);
		expect(server.closed).toEqual(criticIds);
		expect(getPolykvSession("lead~cc1-critic-first")).toBeUndefined();
		// Workers of the owner: no booking of their own.
		for (const call of m.calls.filter((x) => x.purpose === "critic")) {
			expect(call.providerConfig.polykvBooking).toBeUndefined();
		}

		await c?.release();
		const order = server.calls.filter(
			(call) => call.includes("/release") || call.includes("/slots/"),
		);
		// P' before P, then the session's slot -- erased, its booking kept.
		expect(order).toEqual([
			"POST /polykv/pools/1/release",
			"POST /polykv/pools/0/release",
			"POST /slots/4?action=erase",
		]);
		expect(server.closed).not.toContain("lead");
		expectNothingLeft(server);
		expect(c?.meter.writerCacheN).toBe(2_922);
		expect(c?.meter.leaked).toEqual([]);
	});

	it("runs the critics one at a time when the owner's room fits only one", async () => {
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 61_000 }],
			owner: "lead",
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.write("write", 1_000);
		expect((await c?.afterWriter(SUMMARY.length, 1_000))?.critics).toBe(
			"serial",
		);
		await c?.dispose();
		expectNothingLeft(server);
	});

	// A compaction never books past the window: no growth for a critic.
	it("skips the critics when the owner has no room for one", async () => {
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 65_000 }],
			owner: "lead",
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.write("write", 1_000);
		expect((await c?.afterWriter(SUMMARY.length, 1_000))?.critics).toBe("skip");
		await c?.dispose();
		expect(server.calls.some((call) => call.includes("kv_resize"))).toBe(false);
		expectNothingLeft(server);
	});

	it("freezes P' as a root when the fork is refused", async () => {
		const server = engine({
			allocations: held,
			owner: "lead",
			fail: ["/fork"],
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.write("write", 1_000);
		await c?.afterWriter(SUMMARY.length, 1_000);
		expect(
			server.calls.filter((call) => call === "POST /polykv/pools"),
		).toHaveLength(2);
		await c?.dispose();
		expectNothingLeft(server);
	});

	it("continues without pools when the freeze is refused", async () => {
		const server = engine({ allocations: held, fail: ["/polykv/pools"] });
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		expect(c?.path).toBe("continuation");
		expect(c?.reason).toContain("freeze refused");
		await c?.dispose();
	});
});

describe("the pooled continuation on a session without a booking", () => {
	// A per-request session would be admitted at the server's per-session
	// maximum. The writer books exactly what it needs instead.
	it("books the writer exactly, and closes that booking at the release", async () => {
		const server = engine({ owner: "lead" });
		const m = model();
		const c = (
			await prepareCompactionContinuation(input(server, { model: m.fn }))
		).continuation;
		await c?.write("write the replay", 2_000);
		const booking = m.calls[0]?.providerConfig.polykvBooking?.numCtx ?? 0;
		expect(booking).toBeGreaterThan(22_000);
		expect(booking).toBeLessThan(26_000);
		expect(booking % 256).toBe(0);
		expect(m.calls[0]?.providerConfig.polykvLeadPool).toBe(false);
		await c?.afterWriter(SUMMARY.length, 2_000);
		await c?.release();
		// Its booking and its slot, together.
		expect(server.closed).toContain("lead");
		expect(server.erased).toEqual([]);
		expect(c?.meter.peakBookedCells).toBe(booking);
		expectNothingLeft(server);
	});

	// An unowned P' charges nobody: each critic books its own exact window.
	it("gives the critics of an unowned P' exact bookings of their own", async () => {
		const server = engine({
			owner: "",
			features: [...POOLED, FEATURES.privateWindow],
			allocations: [],
		});
		const m = model();
		const c = (
			await prepareCompactionContinuation(
				input(server, {
					model: m.fn,
					providerConfig: { polykvWorker: { group: "lead", layers: 0 } },
				}),
			)
		).continuation;
		await c?.write("write", 1_000);
		// A worker's writer is charged to its owner: no booking.
		expect(m.calls[0]?.providerConfig.polykvBooking).toBeUndefined();
		expect((await c?.afterWriter(SUMMARY.length, 1_000))?.critics).toBe(
			"concurrent",
		);
		await Promise.all([
			c?.critic("first", "critic", "first half", 1_000),
			c?.critic("second", "critic", "second half", 1_000),
		]);
		for (const call of m.calls.filter((x) => x.purpose === "critic")) {
			const exact = call.providerConfig.polykvBooking?.numCtx ?? 0;
			expect(exact).toBeGreaterThan(1_000);
			expect(exact).toBeLessThan(4_096);
			expect(call.providerConfig.polykvWorker).toBeUndefined();
		}
		await c?.dispose();
		expectNothingLeft(server);
	});
});

describe("refusals", () => {
	const refusal = () =>
		new ContinuationCallError("503 no KV cells available", "rate_limited");

	it("the writer waits out refusals for as long as they last", async () => {
		const server = engine({ poolsEnabled: false });
		const waits: number[] = [];
		const m = model({
			fail: (call, index) =>
				call.purpose === "writer" && index < 8 ? refusal() : undefined,
		});
		const c = (
			await prepareCompactionContinuation(
				input(server, {
					model: m.fn,
					sleep: async (ms) => {
						waits.push(ms);
					},
				}),
			)
		).continuation;
		const result = await c?.write("write", 1_000);
		expect(result?.text).toBe(SUMMARY);
		expect(waits).toHaveLength(8);
		expect(Math.max(...waits)).toBe(30_000);
		await c?.dispose();
	});

	it("an optional call declines after a bounded wait, and a real error is not retried", async () => {
		const server = engine({ poolsEnabled: false });
		const m = model({
			fail: (call) =>
				call.purpose === "critic"
					? refusal()
					: call.purpose === "synthesizer"
						? new Error("400 bad request")
						: undefined,
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: m.fn }))
		).continuation;
		await c?.write("write", 1_000);
		await c?.afterWriter(SUMMARY.length, 1_000);
		await expect(c?.critic("first", "s", "r", 1_000)).rejects.toThrow("503");
		expect(m.calls.filter((x) => x.purpose === "critic")).toHaveLength(4);
		await expect(
			c?.fresh("synthesizer", "s", "r", 1_000, input(server).providerConfig),
		).rejects.toThrow("400");
		expect(m.calls.filter((x) => x.purpose === "synthesizer")).toHaveLength(1);
		await c?.dispose();
	});
});

describe("the leak test", () => {
	const held = [{ session_id: "lead", window: 65_536, used: 21_000 }];

	it("releases every pool and session when a critic throws mid-flight", async () => {
		const server = engine({ allocations: held, owner: "lead" });
		const m = model({
			fail: (call) =>
				call.purpose === "critic" ? new Error("stream broke") : undefined,
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: m.fn }))
		).continuation;
		await c?.write("write", 1_000);
		await c?.afterWriter(SUMMARY.length, 1_000);
		await expect(c?.critic("first", "s", "r", 1_000)).rejects.toThrow();
		expect(server.closed).toContain("lead~cc1-critic-first");
		await c?.dispose();
		expectNothingLeft(server);
	});

	it("releases P when the writer never answers", async () => {
		const server = engine({ allocations: held, owner: "lead" });
		const m = model({ fail: () => new Error("400 template error") });
		const c = (
			await prepareCompactionContinuation(input(server, { model: m.fn }))
		).continuation;
		await expect(c?.write("write", 1_000)).rejects.toThrow("400");
		expect(server.pools.size).toBe(1);
		await c?.dispose();
		expectNothingLeft(server);
	});

	it("closes the synthesizer's exact booking even when it fails", async () => {
		const server = engine({ allocations: held, owner: "lead" });
		const m = model({
			fail: (call) =>
				call.purpose === "synthesizer" ? new Error("boom") : undefined,
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: m.fn }))
		).continuation;
		await c?.release();
		await expect(
			c?.fresh("synthesizer", "s", "r", 1_000, input(server).providerConfig),
		).rejects.toThrow("boom");
		const synth = m.calls.find((x) => x.purpose === "synthesizer");
		expect(synth?.providerConfig.engineSessionId).toBe("lead~cc1-synthesizer");
		expect(synth?.providerConfig.polykvBooking?.numCtx).toBe(
			exactBooking(2, 1_000),
		);
		expect(server.closed).toContain("lead~cc1-synthesizer");
		await c?.dispose();
		expectNothingLeft(server);
	});

	it("is idempotent: a second dispose sends nothing", async () => {
		const server = engine({ allocations: held, owner: "lead" });
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.dispose();
		const after = server.calls.length;
		await c?.dispose();
		await c?.release();
		expect(server.calls.length).toBe(after);
	});

	it("reports a release that failed instead of hiding it", async () => {
		const server = engine({
			allocations: held,
			owner: "lead",
			fail: ["/release"],
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.dispose();
		expect(c?.meter.leaked.join(" ")).toContain("pool 0");
		const line = describeCompactionRun({
			path: "pooled",
			reason: "test",
			meter: c?.meter ?? createCompactionMeter(),
			durationMs: 5,
		});
		expect(line).toContain("LEAKED=");
	});
});

describe("the whole compaction as a continuation", () => {
	const estimateJsonTokens = (message: LlmsProviders.Message): number =>
		JSON.stringify(message).length / 4;

	function contextFor(list: MessageWithMetadata[]): CoreCompactionContext {
		const targetTokens = 100_000;
		return {
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 1,
			messages: list,
			model: {
				id: "m",
				provider: "opencoti",
				info: { id: "m", maxInputTokens: targetTokens },
			},
			mode: "auto",
			budget: {
				request: {
					inputTokens: targetTokens * 2,
					maxInputTokens: targetTokens,
					triggerTokens: targetTokens,
					targetTokens,
					overheadTokens: 0,
					thresholdRatio: 1,
					utilizationRatio: 2,
				},
				messages: {
					inputTokens: targetTokens * 2,
					triggerTokens: targetTokens,
					targetTokens,
				},
			},
		} as unknown as CoreCompactionContext;
	}

	it("runs critics before the release and the synthesizer after it, leaving nothing", async () => {
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 21_000 }],
			owner: "lead",
		});
		const timeline: string[] = [];
		const m = model({ onCall: (call) => timeline.push(call.purpose) });
		const tracked = server.fetch;
		const trackingFetch = (async (url: unknown, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith("/release") || path.startsWith("/slots/")) {
				timeline.push(`release ${path}`);
			}
			return tracked(url as never, init);
		}) as unknown as typeof fetch;
		const list = messages();
		const prepared = await prepareCompactionContinuation(
			input(server, {
				model: m.fn,
				apiMessages: list,
				providerConfig: { fetch: trackingFetch },
			}),
		);
		const c = prepared.continuation;
		expect(c?.path).toBe("pooled");
		const result = await runAgenticCompaction({
			context: contextFor(list),
			providerConfig: {
				providerId: "opencoti",
				modelId: "m",
				baseUrl: "http://engine/v1",
				fetch: trackingFetch,
				modelInfo: { id: "m", maxInputTokens: 100_000 },
			} as never,
			thinkingSummaryEnabled: false,
			bounds: resolveRecencyBounds({
				preserveRecentTokens: 200,
				preserveRecentMessagesRatio: Number.EPSILON,
				messageTargetTokens: Number.MAX_SAFE_INTEGER,
			}),
			estimateMessageTokens: estimateJsonTokens,
			...(c ? { continuation: c } : {}),
		});
		await c?.dispose();

		expect(result?.messages.length).toBeGreaterThan(0);
		// No transcript-as-text call went out.
		expect(createHandlerMock).not.toHaveBeenCalled();
		const synth = timeline.indexOf("synthesizer");
		const lastCritic = timeline.lastIndexOf("critic");
		const firstRelease = timeline.findIndex((x) => x.startsWith("release"));
		expect(timeline[0]).toBe("writer");
		expect(lastCritic).toBeGreaterThan(0);
		expect(firstRelease).toBeGreaterThan(lastCritic);
		expect(synth).toBeGreaterThan(firstRelease);
		// The writer's instruction says what the replay covers, not the
		// transcript again.
		const instruction = JSON.stringify(m.calls[0]?.messages.at(-1)?.content);
		expect(instruction).not.toContain("line line line");
		expect(instruction).not.toContain("Conversation:");
		expect(instruction).toContain("The conversation above will be discarded");
		expectNothingLeft(server);
		expect(server.closed).toEqual([
			"lead~cc1-critic-first",
			"lead~cc1-critic-second",
			"lead~cc1-synthesizer",
		]);
	});

	it("hands back nothing when the writer cannot answer, and the caller falls back", async () => {
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 21_000 }],
			owner: "lead",
		});
		const m = model({ fail: () => new Error("400 bad template") });
		const list = messages();
		const c = (
			await prepareCompactionContinuation(
				input(server, { model: m.fn, apiMessages: list }),
			)
		).continuation;
		const result = await runAgenticCompaction({
			context: contextFor(list),
			providerConfig: {
				providerId: "opencoti",
				modelId: "m",
				baseUrl: "http://engine/v1",
				fetch: server.fetch,
				modelInfo: { id: "m", maxInputTokens: 100_000 },
			} as never,
			thinkingSummaryEnabled: false,
			bounds: resolveRecencyBounds({
				preserveRecentTokens: 200,
				preserveRecentMessagesRatio: Number.EPSILON,
				messageTargetTokens: Number.MAX_SAFE_INTEGER,
			}),
			estimateMessageTokens: estimateJsonTokens,
			...(c ? { continuation: c } : {}),
		});
		await c?.dispose();
		expect(result).toBeUndefined();
		expectNothingLeft(server);
	});
});

describe("describeReplaySpan", () => {
	it("names the tail by its opening words", () => {
		const list = messages();
		const text = describeReplaySpan({
			messages: list,
			cutIndex: 5,
			keepRecentMessages: true,
		});
		expect(text).toContain("up to, and not including");
		expect(text).toContain("step 2.");
	});

	// A session without a pool over its head would pay for its prefix again.
	it("leaves the slot of a held session no pool covers", async () => {
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 21_000 }],
			owner: "lead",
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.dispose();
		expect(server.erased).toEqual([]);
		expect(server.closed).toEqual([]);
		expect(c?.meter.notes.join(" ")).toContain("left resident");
	});

	it("covers everything without a tail", () => {
		expect(
			describeReplaySpan({
				messages: messages(),
				cutIndex: 3,
				keepRecentMessages: false,
			}),
		).toContain("everything above this message.");
	});
});

describe("the line every compaction logs", () => {
	it("names the path, the reason, prefill, cache_n, peak booking and wall", () => {
		const meter = createCompactionMeter();
		meter.prefillTokens = 212;
		meter.calls = 4;
		meter.writerCacheN = 2_922;
		meter.writerExpectedCacheN = 2_950;
		meter.criticCacheN.push(3_010, 3_010);
		meter.criticExpectedCacheN = 3_409;
		meter.peakBookedCells = 6_144;
		const line = describeCompactionRun({
			path: "pooled",
			reason: "pooled on the session's own booking",
			meter,
			durationMs: 1_234,
			sessionWindow: 65_536,
		});
		expect(line).toBe(
			"[compaction] path=pooled (pooled on the session's own booking) prefill=212 over 4 calls cache_n writer=2922/2950 critics=3010,3010/3409 peak booked=6144 of window 65536 wall=1234ms",
		);
	});
});

// Registered critics are borrowed: never the session's to release by id.
describe("the registry", () => {
	it("leaves the session's own registration alone", async () => {
		setPolykvSession("lead", { poolId: "root", prefixTokens: 100 });
		const server = engine({
			allocations: [{ session_id: "lead", window: 65_536, used: 21_000 }],
			owner: "lead",
		});
		const c = (
			await prepareCompactionContinuation(input(server, { model: model().fn }))
		).continuation;
		await c?.write("w", 500);
		await c?.afterWriter(SUMMARY.length, 500);
		await c?.critic("first", "s", "r", 500);
		await c?.dispose();
		expect(getPolykvSession("lead")).toEqual({
			poolId: "root",
			prefixTokens: 100,
		});
		expect(server.calls).not.toContain("POST /polykv/pools/root/release");
	});
});
