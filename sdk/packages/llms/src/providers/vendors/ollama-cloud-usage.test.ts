import { beforeEach, describe, expect, it } from "vitest";
import {
	includedAllowanceExhausted,
	OLLAMA_USAGE_LONG_RANGE_POLL_MS,
	OLLAMA_USAGE_POLL_MS,
	parseOllamaBalance,
	parseOllamaUsageTotals,
	readOllamaCloudUsage,
	resetOllamaCloudUsage,
} from "./ollama-cloud-usage";

/** The reporter's own answer, pandorum 2026-10-23, on a legacy plan. */
const LEGACY_BALANCE = {
	included: {
		session: { remaining_percent: 99.97, resets_at: "2026-10-24T00:00:00Z" },
		weekly: { remaining_percent: 68.35, resets_at: "2026-10-26T00:00:00Z" },
	},
	purchased: { balance_usd: 31.88733 },
};

/** The documented shape for a current plan. */
const CURRENT_BALANCE = {
	included: {
		balance_usd: 72.5,
		allowance_usd: 100,
		period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
	},
	purchased: { balance_usd: 25 },
};

const usageBody = (requests: number, extra: Record<string, number> = {}) => ({
	range: "24h",
	totals: { request_count: requests, ...extra },
	buckets: [],
});

interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** A fetch that answers by path and records what it was asked. */
function server(route: (path: string) => Reply) {
	const asked: string[] = [];
	const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
		const url = new URL(String(input));
		const path = `${url.pathname}${url.search}`;
		asked.push(path);
		const reply = route(path);
		return new Response(
			reply.body === undefined ? "" : JSON.stringify(reply.body),
			{ status: reply.status, headers: reply.headers },
		);
	}) as typeof fetch;
	return { asked, fetchImpl };
}

const healthy = (path: string): Reply =>
	path.startsWith("/api/balance")
		? { status: 200, body: LEGACY_BALANCE }
		: { status: 200, body: usageBody(244) };

beforeEach(() => {
	resetOllamaCloudUsage();
});

describe("parseOllamaBalance", () => {
	it("reads a legacy plan's session and weekly limits", () => {
		expect(parseOllamaBalance(LEGACY_BALANCE)).toEqual({
			session: { remainingPercent: 99.97, resetsAt: "2026-10-24T00:00:00Z" },
			weekly: { remainingPercent: 68.35, resetsAt: "2026-10-26T00:00:00Z" },
			purchasedBalanceUsd: 31.88733,
		});
	});

	it("reads a current plan's included balance and period", () => {
		expect(parseOllamaBalance(CURRENT_BALANCE)).toEqual({
			includedBalanceUsd: 72.5,
			includedAllowanceUsd: 100,
			periodUntil: "2026-10-15T09:30:00Z",
			purchasedBalanceUsd: 25,
		});
	});

	it("keeps a percentage inside 0..100", () => {
		const parsed = parseOllamaBalance({
			included: { session: { remaining_percent: -3 } },
		});
		expect(parsed.session?.remainingPercent).toBe(0);
	});
});

describe("parseOllamaUsageTotals", () => {
	it("keeps a legacy plan's count alone rather than inventing zero cost", () => {
		// A legacy plan reports requests and nothing else. A $0.00 shown for it
		// would be a figure the server never sent.
		expect(parseOllamaUsageTotals("24h", usageBody(244))).toEqual({
			range: "24h",
			requestCount: 244,
		});
	});

	it("keeps cost and tokens when the plan reports them", () => {
		expect(
			parseOllamaUsageTotals(
				"7d",
				usageBody(16, {
					usage_usd: 0.0268,
					input_tokens: 116000,
					cached_input_tokens: 60000,
					output_tokens: 15000,
				}),
			),
		).toEqual({
			range: "7d",
			requestCount: 16,
			usageUsd: 0.0268,
			inputTokens: 116000,
			cachedInputTokens: 60000,
			outputTokens: 15000,
		});
	});

	it("reads nothing from a body without a request count", () => {
		expect(parseOllamaUsageTotals("30d", { totals: {} })).toBeUndefined();
	});
});

describe("includedAllowanceExhausted", () => {
	it("is set by either legacy limit at zero", () => {
		expect(
			includedAllowanceExhausted({ session: { remainingPercent: 0 } }),
		).toBe(true);
		expect(
			includedAllowanceExhausted({
				session: { remainingPercent: 40 },
				weekly: { remainingPercent: 0 },
			}),
		).toBe(true);
	});

	it("is set by a current plan's included balance at zero", () => {
		expect(
			includedAllowanceExhausted({
				includedBalanceUsd: 0,
				purchasedBalanceUsd: 25,
			}),
		).toBe(true);
	});

	it("is not set while anything is left", () => {
		expect(includedAllowanceExhausted(parseOllamaBalance(LEGACY_BALANCE))).toBe(
			false,
		);
	});
});

describe("readOllamaCloudUsage", () => {
	it("reads the balance and every range through the server", async () => {
		const { asked, fetchImpl } = server(healthy);
		const usage = await readOllamaCloudUsage("http://pandorum:11434/v1", {
			fetchImpl,
			nowMs: 0,
		});
		expect(usage.state).toBe("ok");
		expect(usage.balance?.weekly?.remainingPercent).toBe(68.35);
		expect(usage.usage.map((totals) => totals.range)).toEqual([
			"24h",
			"7d",
			"30d",
		]);
		expect(usage.includedExhausted).toBe(false);
		expect([...asked].sort()).toEqual([
			"/api/balance",
			"/api/usage?range=24h",
			"/api/usage?range=30d",
			"/api/usage?range=7d",
		]);
	});

	it("answers from the last read inside a minute", async () => {
		const { asked, fetchImpl } = server(healthy);
		await readOllamaCloudUsage("http://h:11434", { fetchImpl, nowMs: 0 });
		await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_POLL_MS - 1,
		});
		expect(asked).toHaveLength(4);
	});

	it("reads the balance and 24h each minute, 7d and 30d every five", async () => {
		const { asked, fetchImpl } = server(healthy);
		await readOllamaCloudUsage("http://h:11434", { fetchImpl, nowMs: 0 });
		asked.length = 0;
		await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_POLL_MS,
		});
		expect([...asked].sort()).toEqual(["/api/balance", "/api/usage?range=24h"]);
		asked.length = 0;
		await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_LONG_RANGE_POLL_MS,
		});
		expect(asked).toHaveLength(4);
	});

	it("shares one read between callers asking at once", async () => {
		const { asked, fetchImpl } = server(healthy);
		const [first, second] = await Promise.all([
			readOllamaCloudUsage("http://h:11434", { fetchImpl, nowMs: 0 }),
			readOllamaCloudUsage("http://h:11434/api", { fetchImpl, nowMs: 0 }),
		]);
		expect(first).toBe(second);
		expect(asked).toHaveLength(4);
	});

	it("keeps the last answer through a 429 and waits out Retry-After", async () => {
		let limited = false;
		const { asked, fetchImpl } = server((path) =>
			limited
				? { status: 429, headers: { "retry-after": "120" } }
				: healthy(path),
		);
		const before = await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: 0,
		});
		limited = true;
		const during = await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_POLL_MS,
		});
		expect(during.state).toBe("ok");
		expect(during.balance).toEqual(before.balance);
		asked.length = 0;
		// Past the poll interval but inside the 120 s it was told to wait.
		await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_POLL_MS * 2,
		});
		expect(asked).toHaveLength(0);
		await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: OLLAMA_USAGE_POLL_MS + 120_000,
		});
		expect(asked.length).toBeGreaterThan(0);
	});

	it("says rate-limited when a 429 comes before anything was read", async () => {
		const { fetchImpl } = server(() => ({ status: 429 }));
		const usage = await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: 0,
		});
		expect(usage.state).toBe("rate-limited");
	});

	it("names a server that is not signed in, with its sign-in link", async () => {
		const { fetchImpl } = server(() => ({
			status: 401,
			body: {
				error: "unauthorized",
				signin_url: "https://ollama.com/connect?x",
			},
		}));
		const usage = await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: 0,
		});
		expect(usage).toMatchObject({
			state: "signed-out",
			signinUrl: "https://ollama.com/connect?x",
			usage: [],
		});
	});

	it("tells cloud-disabled from a server too old to proxy", async () => {
		const disabled = server(() => ({ status: 403, body: { error: "off" } }));
		expect(
			(
				await readOllamaCloudUsage("http://a:11434", {
					fetchImpl: disabled.fetchImpl,
					nowMs: 0,
				})
			).state,
		).toBe("cloud-disabled");
		const old = server(() => ({ status: 404, body: "404 page not found" }));
		expect(
			(
				await readOllamaCloudUsage("http://b:11434", {
					fetchImpl: old.fetchImpl,
					nowMs: 0,
				})
			).state,
		).toBe("unsupported");
	});

	it("says unreachable when nothing answers, and does not throw", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const usage = await readOllamaCloudUsage("http://h:11434", {
			fetchImpl,
			nowMs: 0,
		});
		expect(usage.state).toBe("unreachable");
		expect(
			(await readOllamaCloudUsage(undefined, { fetchImpl, nowMs: 0 })).state,
		).toBe("unreachable");
	});
});
