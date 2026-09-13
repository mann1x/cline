import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeParallelSessions,
	resolveAgentSlotLimit,
} from "./agent-slots";
import { resetPolykvAvailability } from "./vendors/polykv";

describe("normalizeParallelSessions", () => {
	it("reads what a settings field hands it", () => {
		expect(normalizeParallelSessions(4)).toBe(4);
		expect(normalizeParallelSessions("4")).toBe(4);
		expect(normalizeParallelSessions(4.7)).toBe(4);
	});

	// Ten is where the number stops describing a server. Clamping rather than
	// rejecting, because a stored 500 is a typo and not a request to serialize.
	it("clamps to what a server could honour", () => {
		expect(normalizeParallelSessions(500)).toBe(10);
		expect(normalizeParallelSessions(1)).toBe(1);
	});

	// `undefined` rather than the default, so a caller can tell "never
	// configured" from "configured as 1" -- the settings field shows an empty
	// box for the first and a 1 for the second.
	it.each([
		[undefined],
		[null],
		[0],
		[-3],
		["" as unknown],
		["abc" as unknown],
	])("reports nothing for %s", (value) => {
		expect(normalizeParallelSessions(value)).toBeUndefined();
	});
});

describe("resolveAgentSlotLimit", () => {
	beforeEach(() => {
		resetPolykvAvailability();
	});

	it("uses the count the profile carries", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "ollama",
			baseUrl: "http://localhost:11434",
			parallelSessions: 4,
		});
		expect(resolved.limit).toBe(4);
	});

	// One is what `--parallel` and a basic plan give you, and it is the value
	// under which nothing queues unexpectedly.
	it("assumes one when nothing is configured", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "ollama",
			baseUrl: "http://localhost:11434",
		});
		expect(resolved.limit).toBe(1);
	});

	// PolyKV changes what a slot is: agents attach to a pool and share one, and
	// the engine admits or refuses against measured KV headroom. Counting slots
	// there would refuse work the server would have taken.
	it("stands down when opencoti has PolyKV on", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			parallelSessions: 2,
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(resolved.limit).toBe(0);
		// The control plane sits beside `/v1`, not under it.
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			"http://localhost:8080/polykv/pools",
		);
	});

	// The routes exist only when the server was launched with
	// `--polykv-max-pools`, so a 404 is the flag being absent rather than an
	// error worth reporting.
	it("keeps the slot count when opencoti has PolyKV off", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			parallelSessions: 2,
			fetch: (async () =>
				new Response("not found", { status: 404 })) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(2);
	});

	// A server that cannot be reached is not a server that has PolyKV. The fixed
	// slot count is the safe reading when the question cannot be asked.
	it("keeps the slot count when the server cannot be reached", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			parallelSessions: 3,
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(3);
	});

	it("does not probe a provider that has no PolyKV", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
		await resolveAgentSlotLimit({
			providerId: "ollama",
			baseUrl: "http://localhost:11434",
			parallelSessions: 2,
			fetch: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
