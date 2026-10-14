import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildNoticesField,
	hideNoticeLines,
	normalizeNoticeSteps,
	readGenerationNoticeCapability,
	readGenerationNoticeSettings,
	resetNoticeRequests,
	signalNoticeMessageWaiting,
	withGenerationNotices,
} from "./generation-notices";

const CHAT = "http://gpu:8080/v1/chat/completions";
const SIGNAL = "http://gpu:8080/v1/notice";

function recorder() {
	const calls: { url: string; body?: unknown }[] = [];
	const fetchImpl = vi.fn(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : String(input);
			calls.push({
				url,
				...(typeof init?.body === "string"
					? { body: JSON.parse(init.body) }
					: {}),
			});
			return new Response("data: [DONE]\n\n", { status: 200 });
		},
	) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function wrap(
	fetchImpl: typeof fetch,
	overrides: Partial<Parameters<typeof withGenerationNotices>[1]> = {},
) {
	return withGenerationNotices(fetchImpl, {
		settings: { enabled: true },
		sessionId: "s1",
		isChat: (url) => url.endsWith("/chat/completions"),
		capability: async () => ({ supported: true, marker: "[notice]" }),
		signalUrl: SIGNAL,
		...overrides,
	});
}

afterEach(() => resetNoticeRequests());

describe("generation notices", () => {
	it("reads support from either feature name, and the marker from the block", () => {
		expect(
			readGenerationNoticeCapability({ features: ["generation_notice_v1"] }),
		).toEqual({ supported: true });
		expect(
			readGenerationNoticeCapability({
				features: ["generation_notices_v1"],
				generation_notice: { version: 1, marker: "[notice]" },
			}),
		).toEqual({ supported: true, marker: "[notice]" });
		expect(readGenerationNoticeCapability({ features: ["council"] })).toEqual({
			supported: false,
		});
	});

	it("sends whole percents, sorted, at most four per phase", () => {
		expect(normalizeNoticeSteps([95.4, 10, 10, 0, 100, 50, 70, 80])).toEqual([
			10, 50, 70, 80,
		]);
		expect(normalizeNoticeSteps(undefined)).toEqual([60, 70, 80, 90]);
		expect(buildNoticesField({ enabled: true, answerSteps: [] }, "k")).toEqual({
			key: "k",
			think: [60, 70, 80, 90].map((at) => ({ at_percent: at })),
		});
		expect(buildNoticesField({ enabled: false }, "k")).toBeUndefined();
		expect(buildNoticesField(undefined, "k")).toBeUndefined();
	});

	it("reads the settings off the options bag", () => {
		expect(
			readGenerationNoticeSettings({
				notices: { enabled: true, thinkSteps: [80, "x", 90] },
			}),
		).toEqual({ enabled: true, thinkSteps: [80, 90] });
		expect(readGenerationNoticeSettings({})).toBeUndefined();
	});

	it("adds the field with a fresh key on each chat request", async () => {
		const { calls, fetchImpl } = recorder();
		const wrapped = wrap(fetchImpl);
		for (let i = 0; i < 2; i++) {
			const response = await wrapped(CHAT, {
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [] }),
			});
			await response.text();
		}
		const keys = calls.map(
			(call) => (call.body as { notices: { key: string } }).notices.key,
		);
		expect(keys[0]).toMatch(/^s1:/);
		expect(keys[0]).not.toBe(keys[1]);
		expect((calls[0]?.body as { model: string }).model).toBe("m");
	});

	it("asks for nothing when off, on a side call, off the chat route, or unsupported", async () => {
		const cases: Partial<Parameters<typeof withGenerationNotices>[1]>[] = [
			{ settings: { enabled: false } },
			{ settings: undefined },
			{ sideCall: true },
			{ capability: async () => ({ supported: false }) },
			{ capability: async () => undefined },
		];
		for (const overrides of cases) {
			const { calls, fetchImpl } = recorder();
			await wrap(fetchImpl, overrides)(CHAT, {
				method: "POST",
				body: JSON.stringify({ messages: [] }),
			});
			expect(calls[0]?.body).toEqual({ messages: [] });
		}
		const { calls, fetchImpl } = recorder();
		await wrap(fetchImpl)("http://gpu:8080/v1/embeddings", {
			method: "POST",
			body: JSON.stringify({ input: "x" }),
		});
		expect(calls[0]?.body).toEqual({ input: "x" });
	});

	it("signals a waiting message to the request in flight, and only while it is", async () => {
		const { calls, fetchImpl } = recorder();
		const response = await wrap(fetchImpl)(CHAT, {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
		});
		const key = (calls[0]?.body as { notices: { key: string } }).notices.key;
		expect(await signalNoticeMessageWaiting("s1")).toBe(true);
		expect(calls[1]).toEqual({
			url: SIGNAL,
			body: { key, kind: "message_waiting" },
		});
		expect(await signalNoticeMessageWaiting("other")).toBe(false);
		await response.text();
		expect(await signalNoticeMessageWaiting("s1")).toBe(false);
		expect(calls).toHaveLength(2);
	});

	it("hides planted lines from the display, and holds back one still arriving", () => {
		const text = "first\n[notice] 80% of thinking used\nsecond";
		expect(hideNoticeLines(text, "[notice]")).toBe("first\nsecond");
		expect(hideNoticeLines(text, undefined)).toBe(text);
		expect(
			hideNoticeLines("first\n[not", "[notice]", { streaming: true }),
		).toBe("first");
		expect(
			hideNoticeLines("first\n[notice] 80%", "[notice]", { streaming: true }),
		).toBe("first");
		expect(hideNoticeLines("first\n[not", "[notice]")).toBe("first\n[not");
		expect(hideNoticeLines("a [notice] inline", "[notice]")).toBe(
			"a [notice] inline",
		);
	});
});
