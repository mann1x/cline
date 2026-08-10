import { describe, expect, it } from "vitest";
import { createAgentSlotGate } from "./agent-slot-gate";

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
