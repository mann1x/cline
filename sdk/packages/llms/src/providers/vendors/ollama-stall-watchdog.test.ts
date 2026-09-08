import { describe, expect, it, vi } from "vitest";
import {
	createOllamaHealthProbe,
	watchForStall,
	withStallWatchdog,
} from "./ollama-stall-watchdog";

function stream(chunks: Uint8Array[], options?: { hold?: Promise<void> }) {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			if (options?.hold) {
				await options.hold;
			}
			controller.close();
		},
	});
}

async function drain(response: Response): Promise<string> {
	return await response.text();
}

describe("watchForStall", () => {
	// The point of the whole thing: silence is not the failure condition, and a
	// server that answers buys another interval from zero however many times it
	// keeps answering. A budget that merely got bigger would still be a guess
	// about hardware.
	it("keeps waiting for as long as the server keeps answering", async () => {
		const probe = vi.fn(async () => true);
		const onDead = vi.fn();

		const watcher = watchForStall({
			probe,
			intervalMs: 5,
			label: "response",
			onDead,
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		watcher.stop();

		expect(probe.mock.calls.length).toBeGreaterThan(2);
		expect(onDead).not.toHaveBeenCalled();
	});

	it("gives up once the server has missed enough probes in a row", async () => {
		const onDead = vi.fn();

		watchForStall({
			probe: async () => false,
			intervalMs: 5,
			failuresBeforeGivingUp: 2,
			label: "response",
			onDead,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it("does not count a single missed probe against a server that comes back", async () => {
		// One refused connection is not evidence: a server deep in a generation
		// can drop a probe, and failing a run that was about to produce its
		// first token is the worse mistake.
		let answered = 0;
		const onDead = vi.fn();

		const watcher = watchForStall({
			probe: async () => {
				answered += 1;
				return answered !== 1;
			},
			intervalMs: 5,
			failuresBeforeGivingUp: 2,
			label: "response",
			onDead,
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		watcher.stop();

		expect(onDead).not.toHaveBeenCalled();
	});

	it("treats arriving data as the clock reset it is", async () => {
		const probe = vi.fn(async () => true);

		const watcher = watchForStall({
			probe,
			intervalMs: 30,
			label: "response",
			onDead: () => {},
		});
		for (let i = 0; i < 5; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			watcher.noteActivity();
		}
		watcher.stop();

		expect(probe).not.toHaveBeenCalled();
	});
});

describe("withStallWatchdog", () => {
	it("passes a healthy stream through unchanged", async () => {
		const body = stream([new TextEncoder().encode("hello")]);
		const watched = withStallWatchdog(
			new Response(body, { status: 200, headers: { "x-test": "1" } }),
			{ probe: async () => true, intervalMs: 5, label: "response data" },
		);

		expect(await drain(watched)).toBe("hello");
		expect(watched.status).toBe(200);
		expect(watched.headers.get("x-test")).toBe("1");
	});

	it("fails the stream when the server stops answering mid-body", async () => {
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = stream([new TextEncoder().encode("partial")], { hold: held });
		const watched = withStallWatchdog(new Response(body), {
			probe: async () => false,
			intervalMs: 5,
			failuresBeforeGivingUp: 1,
			label: "response data",
		});

		await expect(drain(watched)).rejects.toThrow(/stopped responding/);
		release?.();
	});

	it("does not fail a slow stream while the server is up", async () => {
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const body = stream([new TextEncoder().encode("slow")], { hold: held });
		const watched = withStallWatchdog(new Response(body), {
			probe: async () => true,
			intervalMs: 5,
			label: "response data",
		});

		const drained = drain(watched);
		await new Promise((resolve) => setTimeout(resolve, 40));
		release?.();

		expect(await drained).toBe("slow");
	});
});

describe("createOllamaHealthProbe", () => {
	it("asks the server it is streaming from, not the path it is streaming", async () => {
		const seen: string[] = [];
		const probe = createOllamaHealthProbe({
			url: "http://localhost:11434/api/chat",
			fetch: (async (input: unknown) => {
				seen.push(String(input));
				return new Response(JSON.stringify({ models: [] }), { status: 200 });
			}) as unknown as typeof fetch,
		});

		expect(await probe()).toBe(true);
		expect(seen[0]).toBe("http://localhost:11434/api/ps");
	});

	it("reads a refused connection as no answer", async () => {
		const probe = createOllamaHealthProbe({
			url: "http://localhost:11434/api/chat",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});

		expect(await probe()).toBe(false);
	});

	it("never reports a server dead just because it could not be asked", async () => {
		// A probe that cannot run is not evidence about the server, and a
		// request must not die of it.
		const probe = createOllamaHealthProbe({
			url: "not a url",
			fetch: (async () =>
				new Response("", { status: 200 })) as unknown as typeof fetch,
		});

		expect(await probe()).toBe(true);
	});
});
