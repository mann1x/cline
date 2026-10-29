// An abort must end an Ollama request that the server has accepted and never
// answered: no headers, no body. A stub that holds `/api/chat` open is the
// shape of a busy or wedged server, and the run's stop is the only way out.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandlerAsync } from "../../providers";
import {
	cachedReinjection,
	primeOllamaReinjection,
	resetReasoningReinjection,
} from "../reasoning-history";
import { resetDeclaredNumCtx } from "./ollama";

interface SilentServer {
	baseUrl: string;
	/** Resolves when the held request has arrived. */
	chatHeld: Promise<void>;
	/** Resolves when the client closed the held request's socket. */
	chatClosed: Promise<void>;
	close(): Promise<void>;
}

/** A server that answers nothing at all to requests under `held`. */
async function silentServer(path: string): Promise<SilentServer> {
	let held: () => void = () => {};
	let closed: () => void = () => {};
	const chatHeld = new Promise<void>((resolve) => {
		held = resolve;
	});
	const chatClosed = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const server: Server = createServer((req: IncomingMessage, res) => {
		if (req.url?.startsWith(path)) {
			req.socket.once("close", () => closed());
			held();
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		chatHeld,
		chatClosed,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms),
		),
	]);
}

describe("an abort ends an Ollama request the server never answers", () => {
	let server: SilentServer | undefined;
	beforeEach(() => {
		resetReasoningReinjection();
		resetDeclaredNumCtx();
	});
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it.each([
		["/api/chat", "the reasoning probe"],
		["/api/show", "the model's /api/show"],
	])("ends the stream and closes the socket when %s is held (%s)", async (held) => {
		server = await silentServer(held);
		const controller = new AbortController();
		const handler = await createHandlerAsync({
			providerId: "ollama",
			modelId: "stub-model",
			baseUrl: server.baseUrl,
		});
		handler.setAbortSignal?.(controller.signal);
		const drained = (async () => {
			const chunks: unknown[] = [];
			for await (const chunk of handler.createMessage("system", [
				{ role: "user", content: "hello" },
			])) {
				chunks.push(chunk);
			}
			return chunks;
		})();
		const settled = drained.then(
			() => "ended",
			() => "rejected",
		);
		await within(server.chatHeld, 5_000, "the chat request reaching the stub");
		controller.abort(new Error("wall limit"));
		expect(await within(settled, 3_000, "the stream ending")).toMatch(
			/ended|rejected/,
		);
		await within(server.chatClosed, 3_000, "the held socket closing");
	});
});

describe("the reasoning probe is shared by the requests waiting on it", () => {
	beforeEach(() => resetReasoningReinjection());

	/** A `/api/chat` that answers only when released, and honours its signal. */
	function heldChat() {
		const signals: AbortSignal[] = [];
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let call = 0;
		const fetchImpl = (async (
			_input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			const signal = init?.signal ?? undefined;
			if (signal) signals.push(signal);
			call += 1;
			const count = call % 2 === 1 ? 40 : 90;
			await new Promise<void>((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
				void released.then(resolve);
			});
			return new Response(JSON.stringify({ prompt_eval_count: count }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		return { fetchImpl, signals, release, calls: () => call };
	}

	it("keeps probing for the request that still waits, and caches its answer", async () => {
		const chat = heldChat();
		const leaving = new AbortController();
		const first = primeOllamaReinjection(
			"http://stub:11434",
			"m",
			chat.fetchImpl,
			undefined,
			leaving.signal,
		);
		const second = primeOllamaReinjection(
			"http://stub:11434",
			"m",
			chat.fetchImpl,
		);
		leaving.abort(new Error("wall limit"));
		await expect(first).rejects.toThrow("wall limit");
		expect(chat.signals.every((signal) => !signal.aborted)).toBe(true);
		chat.release();
		await within(second, 2_000, "the remaining wait");
		expect(chat.calls()).toBe(2);
		expect(cachedReinjection("http://stub:11434", "m")?.reinjects).toBe(true);
	});

	it("stops the probe when its only request aborts, and records nothing", async () => {
		const chat = heldChat();
		const leaving = new AbortController();
		const first = primeOllamaReinjection(
			"http://stub:11434",
			"m",
			chat.fetchImpl,
			undefined,
			leaving.signal,
		);
		leaving.abort(new Error("wall limit"));
		await expect(first).rejects.toThrow("wall limit");
		expect(chat.signals[0]?.aborted).toBe(true);
		// Let the stopped probe finish its catch before reading the cache.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cachedReinjection("http://stub:11434", "m")).toBeUndefined();

		chat.release();
		await within(
			primeOllamaReinjection("http://stub:11434", "m", chat.fetchImpl),
			2_000,
			"a fresh probe",
		);
		expect(chat.calls()).toBe(3);
		expect(cachedReinjection("http://stub:11434", "m")).toBeDefined();
	});
});
