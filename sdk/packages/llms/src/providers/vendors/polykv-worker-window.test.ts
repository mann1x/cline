import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import { clearPolykvGrantedWindow, getPolykvWindowGrant } from "./polykv";
import {
	polykvWorkerChargedTo,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * A delegated agent's compaction sizes against the window it actually lives
 * in, and reads the pressure of the booking it is charged to.
 *
 * A worker deletes `num_ctx` -- it books nothing -- so the lead's grant path
 * never ran for it, and its compaction fell back to the node's static window
 * (256k) while the owner it shared held a fraction of that. And the trigger
 * read no `/kv` row for it at all: it did not know whose row to read.
 */

const LEAD = "lead/1";
const LEAD_ENGINE = "lead~1";

function engine(options: { contextWindow?: string } = {}) {
	let nextPool = 0;
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages
			.map(
				(message) =>
					`<|${message.role}|>${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}<|end|>`,
			)
			.join("");
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		const json = (value: unknown, status = 200, headers = {}) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});
		if (url.pathname === "/kv") {
			return json({
				allocations: [{ key: LEAD_ENGINE, cells: 131_072, used: 1_000 }],
			});
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
				),
			});
		}
		if (url.pathname === "/polykv/pools") {
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 100 });
		}
		if (/^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)) {
			return json({
				pool_id: nextPool++,
				parent: Number(url.pathname.split("/")[3]),
				prefix_len: 200,
			});
		}
		if (/^\/polykv\/pools\/\d+\/(pin|unpin|release)$/.test(url.pathname)) {
			return json({ ok: true });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
		}
		if (url.pathname === "/v1/chat/completions") {
			return json({ choices: [{ message: { content: "ok" } }] }, 200, {
				"x-context-window": options.contextWindow ?? "131072",
			});
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl };
}

function send(
	stub: ReturnType<typeof engine>,
	sessionId: string,
	messages: Array<{ role: string; content: string }>,
	owner: string | null = LEAD,
) {
	return createOpencotiFetch({
		fetch: stub.fetch,
		baseUrl: "http://engine/v1",
		request: {
			worker: {
				group: LEAD,
				sessionId,
				layers: 2,
				...(owner ? { owner } : {}),
			},
		},
	})("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({ model: "m", messages, num_ctx: 262_144 }),
	});
}

const pooledShape = [
	{ role: "system", content: "base prompt" },
	{ role: "user", content: "the shared file" },
	{ role: "user", content: "role" },
	{ role: "user", content: "task" },
];

afterEach(async () => {
	await releaseAllPolykvSwarms();
	clearPolykvGrantedWindow("agent-a");
	clearPolykvGrantedWindow("agent-b");
});

describe("the window and booking a worker lives in", () => {
	it("records the window a pooled worker's turn was served in", async () => {
		const response = await send(engine(), "agent-a", pooledShape);
		expect(response.status).toBe(200);
		expect(getPolykvWindowGrant("agent-a")?.granted).toBe(131_072);
	});

	it("names the owner a pooled worker's turn was charged to", async () => {
		await send(engine(), "agent-a", pooledShape);
		expect(polykvWorkerChargedTo("agent-a")).toBe(LEAD_ENGINE);
	});

	it("charges an unpooled worker to nobody, and still records its own window", async () => {
		// Not shaped [system, 2 shared turns, task]: it runs as a session of
		// its own, and its own session's window is the one it fills. (A swarm
		// worker: a priority-0 one is refused back to the queue instead.)
		const response = await send(
			engine({ contextWindow: "65536" }),
			"agent-b",
			[
				{ role: "system", content: "base prompt" },
				{ role: "user", content: "task" },
			],
			null,
		);
		expect(response.status).toBe(200);
		expect(polykvWorkerChargedTo("agent-b")).toBeUndefined();
		expect(getPolykvWindowGrant("agent-b")?.granted).toBe(65_536);
	});

	it("forgets the owner when the agent is released", async () => {
		await send(engine(), "agent-a", pooledShape);
		await releasePolykvAgent("agent-a");
		expect(polykvWorkerChargedTo("agent-a")).toBeUndefined();
	});
});
