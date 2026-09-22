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

	// The bound catches a slipped digit and nothing else. It was 10, which was
	// a claim about local llama.cpp servers and wrong for a hosted plan and for
	// an elastic opencoti alike -- and binding in practice, on a profile that
	// sat at exactly 10. The endpoint does the real refusing.
	it("clamps a typo without capping a plausible number", () => {
		expect(normalizeParallelSessions(5000)).toBe(64);
		expect(normalizeParallelSessions(1)).toBe(1);
		// Above the old cap and entirely ordinary for a hosted provider.
		expect(normalizeParallelSessions(16)).toBe(16);
		expect(normalizeParallelSessions(32)).toBe(32);
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

	// A server that answers `/props` with whatever `opencoti` block the case
	// needs. `/props` is the one probe that works on every configuration: the
	// pool routes error on a server booted without `--polykv-max-pools`, so
	// asking there cannot tell "pools off" from "no server".
	const propsServer = (opencoti: Record<string, unknown>) =>
		vi.fn(
			async (_input: Parameters<typeof fetch>[0]) =>
				new Response(
					JSON.stringify({
						build_info: "opencoti-0.10.5-c7-2609031229001",
						opencoti,
					}),
					{ status: 200 },
				),
		);

	const POOLS_ON = { polykv: { pools_enabled: true } };
	const POOLS_OFF = { polykv: { pools_enabled: false, max_pools: 0 } };
	const ELASTIC_ON = {
		polykv: { pools_enabled: false, max_pools: 0 },
		elastic_slots: { enabled: true, slots_live: 2, slots_max: 8 },
	};

	// PolyKV changes what a slot is: agents attach to a pool and share one, and
	// the engine admits or refuses against measured KV headroom. Counting slots
	// there would refuse work the server would have taken.
	it("stands down when opencoti has PolyKV on and nothing is configured", async () => {
		const fetchImpl = propsServer(POOLS_ON);
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl as unknown as typeof fetch,
		});

		expect(resolved.limit).toBe(0);
		// `/props` sits beside `/v1`, not under it.
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:8080/props");
	});

	// The elastic slot controller decides the same question by a different
	// route -- it grows `slots_live` under load rather than admitting against a
	// pool -- so an elastic server is equally not something to count slots on.
	it("stands down when opencoti has elastic slots on", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			fetch: propsServer(ELASTIC_ON) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(0);
	});

	// A number in the field is a number the user meant. On an elastic server it
	// stops being a description of the server and becomes a ceiling of theirs --
	// the engine may be willing to take more, and this says don't. Discarding it
	// because the engine has an opinion would make the field unusable exactly
	// where someone would reach for it.
	it.each([
		["PolyKV", POOLS_ON],
		["elastic slots", ELASTIC_ON],
	])("keeps a configured count as a ceiling under %s", async (_name, props) => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			parallelSessions: 2,
			fetch: propsServer(props) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(2);
	});

	// A server booted without `--polykv-max-pools` -- the default -- still
	// answers `/props`, and says so there. This is the case the old probe could
	// not see: it asked a route that errors, and read the error as "no server".
	it("keeps the slot count when opencoti has PolyKV off", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			parallelSessions: 2,
			fetch: propsServer(POOLS_OFF) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(2);
	});

	// Neither controller is armed, so the server really does have a fixed count
	// of slots and a request that finds none free queues silently. One.
	it("assumes one on a plain opencoti with nothing configured", async () => {
		const resolved = await resolveAgentSlotLimit({
			providerId: "opencoti",
			baseUrl: "http://localhost:8080/v1",
			fetch: propsServer(POOLS_OFF) as unknown as typeof fetch,
		});
		expect(resolved.limit).toBe(1);
	});

	// A server that cannot be reached is not a server that has PolyKV. The fixed
	// slot count is the safe reading when the question cannot be asked -- and
	// with nothing configured that is one, never the elastic zero.
	it("keeps the slot count when the server cannot be reached", async () => {
		const unreachable = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;

		expect(
			(
				await resolveAgentSlotLimit({
					providerId: "opencoti",
					baseUrl: "http://localhost:8080/v1",
					parallelSessions: 3,
					fetch: unreachable,
				})
			).limit,
		).toBe(3);

		expect(
			(
				await resolveAgentSlotLimit({
					providerId: "opencoti",
					baseUrl: "http://localhost:8080/v1",
					fetch: unreachable,
				})
			).limit,
		).toBe(1);
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
