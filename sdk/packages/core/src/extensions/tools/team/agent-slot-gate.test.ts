import { describe, expect, it } from "vitest";
import {
	agentEndpointKey,
	createAgentSlotGate,
	createAgentSlotGateRegistry,
} from "./agent-slot-gate";

/** A task that finishes only when told to, so overlap is observable. */
function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("createAgentSlotGate", () => {
	it("runs one at a time when the server has one slot", async () => {
		const gate = createAgentSlotGate(1);
		const first = deferred();
		const second = deferred();
		const started: string[] = [];

		const a = gate.run(async () => {
			started.push("a");
			await first.promise;
		});
		const b = gate.run(async () => {
			started.push("b");
			await second.promise;
		});

		await Promise.resolve();
		expect(started).toEqual(["a"]);

		first.resolve();
		await a;
		await Promise.resolve();
		expect(started).toEqual(["a", "b"]);

		second.resolve();
		await b;
		expect(gate.active()).toBe(0);
	});

	it("lets a four-slot server take four", async () => {
		const gate = createAgentSlotGate(4);
		const blocks = [deferred(), deferred(), deferred(), deferred(), deferred()];
		const started: number[] = [];
		const runs = blocks.map((block, index) =>
			gate.run(async () => {
				started.push(index);
				await block.promise;
			}),
		);

		await Promise.resolve();
		expect(started).toEqual([0, 1, 2, 3]);
		expect(gate.active()).toBe(4);

		for (const block of blocks) {
			block.resolve();
		}
		await Promise.all(runs);
		expect(gate.active()).toBe(0);
	});

	// The slot is handed to the waiter rather than freed and re-taken. Freeing it
	// first leaves a window between the release and the waiter's continuation in
	// which a fresh caller takes the slot and the woken waiter takes it as well.
	it("does not let a late arrival overtake a woken waiter", async () => {
		const gate = createAgentSlotGate(1);
		const first = deferred();
		const queued = deferred();
		const late = deferred();
		let peak = 0;
		const track = async (block: Promise<void>) => {
			peak = Math.max(peak, gate.active());
			await block;
		};

		const a = gate.run(() => track(first.promise));
		const b = gate.run(() => track(queued.promise));
		first.resolve();
		await a;
		const c = gate.run(() => track(late.promise));

		queued.resolve();
		late.resolve();
		await Promise.all([b, c]);
		expect(peak).toBe(1);
	});

	// A task that throws still owned a slot; not releasing it would wedge every
	// agent behind one failed run.
	it("frees the slot when a run throws", async () => {
		const gate = createAgentSlotGate(1);
		await expect(
			gate.run(async () => {
				throw new Error("provider said no");
			}),
		).rejects.toThrow("provider said no");
		expect(gate.active()).toBe(0);
		await expect(gate.run(async () => "next")).resolves.toBe("next");
	});

	// `0` is the host saying admission control decides -- opencoti with PolyKV
	// on. Counting here would refuse work the server would have taken.
	it.each([[0], [undefined]])("does not gate at %s", async (limit) => {
		const gate = createAgentSlotGate(limit);
		const blocks = [deferred(), deferred(), deferred()];
		const runs = blocks.map((block) => gate.run(() => block.promise));

		await Promise.resolve();
		expect(gate.active()).toBe(3);
		for (const block of blocks) {
			block.resolve();
		}
		await Promise.all(runs);
	});
});

describe("agentEndpointKey", () => {
	it("separates two servers behind one provider id", () => {
		expect(
			agentEndpointKey({ providerId: "ollama", baseUrl: "http://a:11434" }),
		).not.toBe(
			agentEndpointKey({ providerId: "ollama", baseUrl: "http://b:11434" }),
		);
	});

	// Case and a trailing slash are how the same server gets written twice, and
	// two gates for one endpoint would let it be over-subscribed.
	it("treats one server written two ways as one endpoint", () => {
		expect(
			agentEndpointKey({ providerId: "Ollama", baseUrl: "http://A:11434/" }),
		).toBe(
			agentEndpointKey({ providerId: "ollama", baseUrl: "http://a:11434" }),
		);
	});

	it("keeps two providers apart when neither names a base URL", () => {
		expect(agentEndpointKey({ providerId: "anthropic" })).not.toBe(
			agentEndpointKey({ providerId: "openai" }),
		);
	});
});

describe("createAgentSlotGateRegistry", () => {
	it("hands back the same gate for one endpoint", () => {
		const registry = createAgentSlotGateRegistry(1);
		expect(registry.for("ollama http://a")).toBe(
			registry.for("ollama http://a"),
		);
	});

	// The defect this exists for: a one-slot local server must not serialise an
	// agent that was never going near it.
	it("does not queue one endpoint's agents behind another's", async () => {
		const registry = createAgentSlotGateRegistry(1);
		const local = deferred();
		const cloud = deferred();
		let cloudStarted = false;

		const localRun = registry.for("ollama http://a").run(() => local.promise);
		const cloudRun = registry.for("anthropic ").run(() => {
			cloudStarted = true;
			return cloud.promise;
		});

		await Promise.resolve();
		expect(cloudStarted).toBe(true);
		expect(registry.active()).toBe(2);

		local.resolve();
		cloud.resolve();
		await Promise.all([localRun, cloudRun]);
		expect(registry.active()).toBe(0);
	});

	it("lets a sub-agent spawn its own without waiting for itself", async () => {
		// The live failure, and the reason the gate is re-entrant. A
		// transaction spawned an agent, that agent spawned another, and the run
		// went silent for one hour and fifty minutes until the harness killed
		// it: 41,453 tokens in 7,202 seconds, no error, nothing in the log
		// after `task.subagent_started`. The inner spawn was queued behind an
		// ancestor that could not release until the inner spawn returned.
		const registry = createAgentSlotGateRegistry(1);
		const gate = registry.for("ollama http://a");

		const result = await gate.run(async () => {
			const inner = await gate.run(async () => "inner");
			return `outer:${inner}`;
		});

		expect(result).toBe("outer:inner");
		expect(gate.active()).toBe(0);
	});

	it("keeps a second endpoint's bound out of it", async () => {
		// Re-entering is only sound for the gate the caller already holds. A
		// sub-agent that spawns onto a different endpoint is a second request
		// to a second server, and queues there like any other.
		const registry = createAgentSlotGateRegistry(1);
		const held = deferred();
		let innerStarted = false;

		const blocker = registry.for("ollama http://b").run(() => held.promise);
		const nested = registry.for("ollama http://a").run(async () =>
			registry.for("ollama http://b").run(async () => {
				innerStarted = true;
				return "inner";
			}),
		);

		await Promise.resolve();
		expect(innerStarted).toBe(false);

		held.resolve();
		await blocker;
		await expect(nested).resolves.toBe("inner");
	});

	it("still holds one endpoint to its own bound", async () => {
		const registry = createAgentSlotGateRegistry(1);
		const first = deferred();
		const second = deferred();
		let secondStarted = false;

		const firstRun = registry.for("ollama http://a").run(() => first.promise);
		const secondRun = registry.for("ollama http://a").run(() => {
			secondStarted = true;
			return second.promise;
		});

		await Promise.resolve();
		expect(secondStarted).toBe(false);
		expect(registry.active()).toBe(1);

		first.resolve();
		await firstRun;
		await Promise.resolve();
		expect(secondStarted).toBe(true);

		second.resolve();
		await secondRun;
	});
});
