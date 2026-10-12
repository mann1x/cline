import { afterEach, describe, expect, it } from "vitest";
import { resetPolykvSessions } from "./polykv";
import {
	resetXollamaConversationRequests,
	resetXollamaProbes,
	withXollamaRequestFields,
	XOLLAMA_SESSION_HEADER,
	xollamaConversationOf,
} from "./xollama";

afterEach(() => {
	resetXollamaProbes();
	resetXollamaConversationRequests();
	resetPolykvSessions();
});

const WINDOW = 96_000;
const LEAD = "1791804621451_wsdjr";
const AGENT = `${LEAD}~agent-mabc123`;
// Run wsdjr: the whole window held, so the engine names no figure above zero.
const REFUSAL =
	"admission rejected: context allocation exhausted (largest admissible 0 < num_ctx_min 96000)";

const json = (
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const granted = () =>
	json({ message: { content: "ok" } }, 200, {
		"x-context-window": String(WINDOW),
	});
const refused = () => json({ error: REFUSAL }, 429);

/** A stub xOllama with room for one window; `chat` answers by session. */
function server(chat: (session: string, nth: number) => Response) {
	const chats: string[] = [];
	const engine: string[] = [];
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
			if (/^sessions\/[^/]+\/close$/.test(endpoint)) {
				return json({ status: 200, body: { found: true, kv_dropped: true } });
			}
			return json({ status: 404, body: {} });
		}
		if (url.pathname === "/api/chat") {
			const body = JSON.parse(String(init?.body)) as { session_id: string };
			chats.push(body.session_id);
			return chat(
				body.session_id,
				chats.filter((session) => session === body.session_id).length,
			);
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { chats, engine, fetch: fetchImpl };
}

const wired = (stub: { fetch: typeof fetch }) =>
	withXollamaRequestFields(stub.fetch, {
		window: { dynamicContextSize: true, contextWindow: WINDOW },
	});

const turn = (wire: typeof fetch, session: string) =>
	wire("http://x/api/chat", {
		method: "POST",
		headers: { [XOLLAMA_SESSION_HEADER]: session },
		body: JSON.stringify({
			model: "m",
			messages: [{ role: "user", content: "go" }],
		}),
	});

const closes = (engine: string[]) =>
	engine.filter((endpoint) => endpoint.endsWith("/close"));

describe("a turn refused behind an idle session of its own conversation", () => {
	it("names the lead as the conversation of its agents", () => {
		expect(xollamaConversationOf(AGENT)).toBe(LEAD);
		expect(xollamaConversationOf(`${LEAD}~teammate-x`)).toBe(LEAD);
		expect(xollamaConversationOf(LEAD)).toBe(LEAD);
	});

	it("gives the waiting lead's window to its agent and sends the turn again", async () => {
		const stub = server((session, nth) =>
			session === AGENT && nth === 1 ? refused() : granted(),
		);
		const wire = wired(stub);
		await (await turn(wire, LEAD)).text();
		const response = await turn(wire, AGENT);
		expect(response.status).toBe(200);
		expect(closes(stub.engine)).toEqual([`sessions/${LEAD}/close`]);
		expect(stub.chats).toEqual([LEAD, AGENT, AGENT]);
	});

	it("gives a kept agent's window back to the lead", async () => {
		let leadTurns = 0;
		const stub = server((session) => {
			if (session === LEAD) {
				leadTurns += 1;
				// First turn in, then refused once behind the agent.
				return leadTurns === 2 ? refused() : granted();
			}
			return granted();
		});
		const wire = wired(stub);
		await (await turn(wire, LEAD)).text();
		// The agent got in after the lead's window had gone.
		await (await turn(wire, AGENT)).text();
		const response = await turn(wire, LEAD);
		expect(response.status).toBe(200);
		expect(closes(stub.engine)).toEqual([`sessions/${AGENT}/close`]);
	});

	it("leaves a session alone while its request is running", async () => {
		const stub = server((session) =>
			session === AGENT ? refused() : granted(),
		);
		const wire = wired(stub);
		// The lead's answer is not read: its request is still running.
		const running = await turn(wire, LEAD);
		const response = await turn(wire, AGENT);
		expect(response.status).toBe(429);
		expect(closes(stub.engine)).toEqual([]);
		// The refusal is handed on whole, for the caller to wait on.
		expect(await response.text()).toContain("admission rejected");
		await running.text();
	});

	it("never closes a session of another conversation", async () => {
		const other = "1791797150365_lz9gx";
		const stub = server((session) =>
			session === AGENT ? refused() : granted(),
		);
		const wire = wired(stub);
		await (await turn(wire, other)).text();
		const response = await turn(wire, AGENT);
		expect(response.status).toBe(429);
		expect(closes(stub.engine)).toEqual([]);
	});

	it("does not close a session twice", async () => {
		const stub = server((session) =>
			session === AGENT ? refused() : granted(),
		);
		const wire = wired(stub);
		await (await turn(wire, LEAD)).text();
		// Closed, sent again, refused again: the caller waits from here.
		expect((await turn(wire, AGENT)).status).toBe(429);
		expect((await turn(wire, AGENT)).status).toBe(429);
		expect(closes(stub.engine)).toEqual([`sessions/${LEAD}/close`]);
	});
});
