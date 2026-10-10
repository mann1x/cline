import { afterEach, describe, expect, it } from "vitest";
import { recordPolykvGrantedWindow, resetPolykvSessions } from "./polykv";
import {
	largestAdmissible,
	onXollamaSideCall,
	resetXollamaConversationRequests,
	resetXollamaProbes,
	sideCallBlockedByOwnConversation,
	withXollamaRequestFields,
	XOLLAMA_SESSION_HEADER,
} from "./xollama";

afterEach(() => {
	resetXollamaProbes();
	resetXollamaConversationRequests();
	resetPolykvSessions();
});

const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

/** The 429 a negotiating request gets: the engine's number is a header. */
const refused = (largest: number | null = 10_614) =>
	json(
		{ error: REFUSAL },
		429,
		largest === null ? {} : { "x-context-largest-admissible": String(largest) },
	);

const PROMPT_TOKENS = 10_842;
const OUTPUT = 4_000;
const NEED = PROMPT_TOKENS + OUTPUT + 256;
// Run peh2v: the conversation held 85,386 of 96,000 and 10,614 were free.
const REFUSAL =
	"admission rejected: context allocation exhausted (largest admissible 10614 < num_ctx_min 15098)";

/**
 * A stub xOllama that negotiates windows. `chat` answers each `/api/chat`
 * in turn; engine calls are recorded by endpoint.
 */
function server(chat: Array<() => Response>) {
	const chats: Array<Record<string, unknown>> = [];
	const engine: string[] = [];
	let turn = 0;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/xollama") {
			return json({ xollama: true, features: ["context_window_v1"] });
		}
		if (url.pathname === "/api/show") {
			return json({ xollama: {} });
		}
		if (url.pathname === "/api/engine") {
			const endpoint = url.searchParams.get("endpoint") ?? "";
			engine.push(endpoint);
			if (endpoint === "tokenize") {
				return json({
					status: 200,
					body: { tokens: new Array(PROMPT_TOKENS).fill(1) },
				});
			}
			if (/^sessions\/[^/]+\/close$/.test(endpoint)) {
				return json({ status: 200, body: { found: true, kv_dropped: true } });
			}
			return json({ status: 404, body: {} });
		}
		if (url.pathname === "/api/chat") {
			chats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const answer = chat[Math.min(turn, chat.length - 1)];
			turn += 1;
			return (answer as () => Response)();
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { chats, engine, fetch: fetchImpl };
}

const sideBody = () =>
	JSON.stringify({
		model: "m",
		messages: [
			{ role: "system", content: "Write the note." },
			{ role: "user", content: "the abandoned reasoning" },
		],
		options: { num_predict: OUTPUT },
	});

const closes = (engine: string[]) =>
	engine.filter((endpoint) => endpoint.endsWith("/close"));

describe("a call outside its conversation on xOllama", () => {
	it("books its own exact window and gives it back when it ends", async () => {
		const stub = server([() => json({ message: { content: "note" } })]);
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		recordPolykvGrantedWindow("conv", 85_386);
		const response = await wire("http://x/api/chat", {
			method: "POST",
			body: sideBody(),
		});
		expect(stub.chats[0]?.placement).toEqual({
			num_ctx: NEED,
			num_ctx_min: NEED,
		});
		const session = String(stub.chats[0]?.session_id);
		expect(session).toMatch(/^cerebriline-side-/);
		// Still held while the answer streams.
		expect(closes(stub.engine)).toEqual([]);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Its own booking, never the conversation's.
		expect(closes(stub.engine)).toEqual([`sessions/${session}/close`]);
	});

	it("closes the idle conversation when its booking is what blocks the call", async () => {
		const stub = server([
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		recordPolykvGrantedWindow("conv", 85_386);
		const response = await wire("http://x/api/chat", {
			method: "POST",
			body: sideBody(),
		});
		expect(response.status).toBe(200);
		expect(closes(stub.engine)[0]).toBe("sessions/conv/close");
		// Sent again as it was refused: booked, under the same side session.
		expect(stub.chats).toHaveLength(2);
		expect(stub.chats[1]).toEqual(stub.chats[0]);
	});

	it("leaves the conversation alone when someone else holds the room", async () => {
		const stub = server([
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		// 10,614 free + 2,000 of ours is still short of the call.
		recordPolykvGrantedWindow("conv", 2_000);
		const response = await wire("http://x/api/chat", {
			method: "POST",
			body: sideBody(),
		});
		expect(response.status).toBe(200);
		expect(closes(stub.engine)).toEqual([]);
		// The plain request, which xOllama waits out as before.
		expect(stub.chats[1]?.placement).toBeUndefined();
		expect(stub.chats[1]?.session_id).toBeUndefined();
		expect(JSON.stringify(stub.chats[1])).toBe(sideBody());
	});

	it("leaves the conversation alone while one of its requests is running", async () => {
		const stub = server([
			// The conversation's turn: answered, its body not yet read.
			() => json({ message: { content: "turn" } }),
			() => refused(),
			() => json({ message: { content: "note" } }),
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		recordPolykvGrantedWindow("conv", 85_386);
		const lead = withXollamaRequestFields(stub.fetch);
		const running = await lead("http://x/api/chat", {
			method: "POST",
			headers: { [XOLLAMA_SESSION_HEADER]: "conv" },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		await wire("http://x/api/chat", { method: "POST", body: sideBody() });
		expect(closes(stub.engine)).toEqual([]);
		expect(stub.chats[2]?.placement).toBeUndefined();
		// Once the turn has ended, the same refusal is the conversation's own.
		await running.text();
		await wire("http://x/api/chat", { method: "POST", body: sideBody() });
		expect(closes(stub.engine)).toContain("sessions/conv/close");
	});

	it("books a call that names no conversation, and closes nothing for it", async () => {
		const stub = server([
			() => refused(),
			() => json({ message: { content: "title" } }),
		]);
		recordPolykvGrantedWindow("conv", 85_386);
		const wire = withXollamaRequestFields(stub.fetch);
		const response = await wire("http://x/api/chat", {
			method: "POST",
			body: sideBody(),
		});
		expect(response.status).toBe(200);
		expect(stub.chats[0]?.placement).toEqual({
			num_ctx: NEED,
			num_ctx_min: NEED,
		});
		expect(closes(stub.engine)).toEqual([]);
		expect(JSON.stringify(stub.chats[1])).toBe(sideBody());
	});

	it("leaves the conversation alone when the engine names no figure", async () => {
		const stub = server([
			() => refused(null),
			() => json({ message: { content: "note" } }),
		]);
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		recordPolykvGrantedWindow("conv", 85_386);
		await wire("http://x/api/chat", { method: "POST", body: sideBody() });
		// The prose says 10,614; only the header is read.
		expect(closes(stub.engine)).toEqual([]);
		expect(stub.chats[1]?.placement).toBeUndefined();
	});

	it("sends a booked call again without its booking when it fails otherwise", async () => {
		const stub = server([
			() => json({ error: "the request exceeds the context" }, 400),
			() => json({ message: { content: "note" } }),
		]);
		const wire = withXollamaRequestFields(stub.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		});
		recordPolykvGrantedWindow("conv", 85_386);
		const response = await wire("http://x/api/chat", {
			method: "POST",
			body: sideBody(),
		});
		expect(response.status).toBe(200);
		expect(JSON.stringify(stub.chats[1])).toBe(sideBody());
		// Its own booking went back; the conversation's did not.
		expect(closes(stub.engine)).toEqual([
			`sessions/${String(stub.chats[0]?.session_id)}/close`,
		]);
	});

	it("leaves a call with an image as it was", async () => {
		const stub = server([() => json({ message: { content: "seen" } })]);
		const wire = withXollamaRequestFields(stub.fetch);
		const body = JSON.stringify({
			model: "m",
			messages: [{ role: "user", content: "what is this", images: ["aGk="] }],
			options: { num_predict: OUTPUT },
		});
		await wire("http://x/api/chat", { method: "POST", body });
		expect(JSON.stringify(stub.chats[0])).toBe(body);
	});

	it("tells the conversation's chat about a close and about a wait", async () => {
		const events: string[] = [];
		const stop = onXollamaSideCall("conv", (event) => {
			events.push(event.kind);
		});
		recordPolykvGrantedWindow("conv", 85_386);
		const closing = server([
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		await withXollamaRequestFields(closing.fetch, {
			engine: () => ({ sideCallOf: "conv" }),
		})("http://x/api/chat", { method: "POST", body: sideBody() });
		expect(events).toEqual(["closed"]);
		// 100 free and 85,386 of ours: closing would do it, so it is the
		// conversation's case again -- unless the room is someone else's.
		recordPolykvGrantedWindow("other", 2_000);
		const waiting = server([
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		await withXollamaRequestFields(waiting.fetch, {
			engine: () => ({ sideCallOf: "other" }),
		})("http://x/api/chat", { method: "POST", body: sideBody() });
		expect(events).toEqual(["closed"]);
		const seen: string[] = [];
		const stopOther = onXollamaSideCall("other", (event) => {
			seen.push(event.kind);
		});
		const again = server([
			() => refused(),
			() => json({ message: { content: "note" } }),
		]);
		await withXollamaRequestFields(again.fetch, {
			engine: () => ({ sideCallOf: "other" }),
		})("http://x/api/chat", { method: "POST", body: sideBody() });
		expect(seen).toEqual(["waiting", "sent"]);
		stop();
		stopOther();
	});

	it("reads the engine's largest admissible window from the header only", () => {
		expect(largestAdmissible(refused(1_192))).toBe(1_192);
		expect(largestAdmissible(refused(0))).toBe(0);
		expect(largestAdmissible(refused(null))).toBeUndefined();
	});

	it("names the conversation's own idle booking, and nothing else", () => {
		const base = {
			need: 14_843,
			largest: 10_614,
			conversationWindow: 85_386,
			conversationBusy: false,
			delegated: false,
		};
		expect(sideCallBlockedByOwnConversation(base)).toBe(true);
		// It fits already: nothing to make room for.
		expect(sideCallBlockedByOwnConversation({ ...base, largest: 20_000 })).toBe(
			false,
		);
		// The engine did not say how much is free.
		expect(
			sideCallBlockedByOwnConversation({ ...base, largest: undefined }),
		).toBe(false);
		// The conversation holds nothing we know of.
		expect(
			sideCallBlockedByOwnConversation({
				...base,
				conversationWindow: undefined,
			}),
		).toBe(false);
		// Closing it would not be enough.
		expect(
			sideCallBlockedByOwnConversation({ ...base, conversationWindow: 1_000 }),
		).toBe(false);
		expect(
			sideCallBlockedByOwnConversation({ ...base, conversationBusy: true }),
		).toBe(false);
		expect(sideCallBlockedByOwnConversation({ ...base, delegated: true })).toBe(
			false,
		);
	});
});
