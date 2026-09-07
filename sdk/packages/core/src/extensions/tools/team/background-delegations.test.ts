import { describe, expect, it } from "vitest";
import {
	type BackgroundDelegationControls,
	type BackgroundDelegationView,
	createBackgroundDelegationRegistry,
} from "./background-delegations";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const RESULT = {
	agentName: "reviewer",
	toolName: "subagent_reviewer",
	text: "looks fine",
	iterations: 2,
	durationMs: 5,
};

/** Lets a test drive the run the way the runtime would. */
function harness() {
	const registry = createBackgroundDelegationRegistry();
	const gate = deferred<typeof RESULT>();
	let controls!: BackgroundDelegationControls;
	const settled: BackgroundDelegationView[] = [];
	const view = registry.start({
		agentName: "reviewer",
		prompt: "review the diff",
		run: (given) => {
			controls = given;
			return gate.promise;
		},
		onSettled: (final) => {
			settled.push(final);
		},
	});
	return { registry, gate, view, settled, controls: () => controls };
}

describe("a delegation the user left running", () => {
	it("is running the moment it is started, without waiting for it", () => {
		const { registry, view } = harness();

		expect(view.status).toBe("running");
		expect(registry.list()).toHaveLength(1);
	});

	it("delivers its answer when it finishes", async () => {
		const { registry, gate, view, settled } = harness();

		gate.resolve(RESULT);
		await gate.promise;
		await Promise.resolve();

		expect(registry.get(view.id)?.status).toBe("completed");
		expect(settled).toHaveLength(1);
		expect(settled[0]?.result?.text).toBe("looks fine");
	});

	it("reports a run that threw as failed, with what it said", async () => {
		const { registry, gate, view, settled } = harness();

		gate.reject(new Error("the profile no longer exists"));
		await gate.promise.catch(() => undefined);
		await Promise.resolve();

		expect(registry.get(view.id)?.status).toBe("failed");
		expect(settled[0]?.error).toMatch(/no longer exists/);
	});
});

describe("pausing one", () => {
	// Between requests, never mid-stream: the hook the runtime awaits before it
	// asks the model is the only place a pause can be taken without discarding
	// work already paid for.
	it("holds the run at the next model request and lets it go on resume", async () => {
		const { registry, view, controls } = harness();
		registry.pause(view.id);

		let released = false;
		const barrier = Promise.resolve(
			controls().hooks.beforeModel?.({} as never),
		).then(() => {
			released = true;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(released).toBe(false);
		expect(registry.get(view.id)?.status).toBe("paused");

		registry.resume(view.id);
		await barrier;

		expect(released).toBe(true);
		expect(registry.get(view.id)?.status).toBe("running");
	});

	it("does not hold a run nobody paused", async () => {
		const { controls } = harness();

		await expect(
			Promise.resolve(controls().hooks.beforeModel?.({} as never)),
		).resolves.toBeUndefined();
	});

	it("refuses to pause what is not running and to resume what is not paused", () => {
		const { registry, view } = harness();

		expect(registry.resume(view.id)).toBe(false);
		expect(registry.pause(view.id)).toBe(true);
		expect(registry.pause(view.id)).toBe(false);
	});
});

describe("stopping one", () => {
	it("aborts the run and calls it stopped rather than failed", async () => {
		const { registry, gate, view, settled } = harness();

		expect(registry.stop(view.id)).toBe(true);
		// What an aborted agent does on the way out.
		gate.reject(new Error("Run aborted"));
		await gate.promise.catch(() => undefined);
		await Promise.resolve();

		expect(registry.get(view.id)?.status).toBe("stopped");
		expect(registry.get(view.id)?.error).toBeUndefined();
		expect(settled).toHaveLength(0);
	});

	it("releases a run that was paused when it was stopped", async () => {
		const { registry, view, controls } = harness();
		registry.pause(view.id);
		const barrier = Promise.resolve(
			controls().hooks.beforeModel?.({} as never),
		);

		registry.stop(view.id);

		await expect(barrier).resolves.toBeUndefined();
		expect(controls().signal.aborted).toBe(true);
	});

	it("stops everything when the session goes away", () => {
		const { registry, view } = harness();

		registry.stopAll();

		expect(registry.get(view.id)?.status).toBe("stopped");
	});
});

describe("what a panel sees", () => {
	it("hears about every change", () => {
		const registry = createBackgroundDelegationRegistry();
		const seen: number[] = [];
		registry.subscribe((runs) => seen.push(runs.length));

		const view = registry.start({
			agentName: "reviewer",
			prompt: "review",
			run: () => new Promise(() => undefined),
		});
		registry.pause(view.id);
		registry.resume(view.id);

		expect(seen).toEqual([1, 1, 1]);
	});

	it("carries what the run is doing, until it is over", () => {
		const { registry, view } = harness();
		registry.note(view.id, "reading manic_miner.html");

		expect(registry.get(view.id)?.activity).toBe("reading manic_miner.html");

		registry.stop(view.id);
		registry.note(view.id, "too late");

		expect(registry.get(view.id)?.activity).toBe("reading manic_miner.html");
	});

	it("hands out copies, so a panel cannot edit the run", () => {
		const { registry, view } = harness();
		const first = registry.get(view.id);
		if (first) {
			first.status = "completed";
		}

		expect(registry.get(view.id)?.status).toBe("running");
	});

	it("survives a listener that throws", () => {
		const registry = createBackgroundDelegationRegistry();
		registry.subscribe(() => {
			throw new Error("the panel is broken");
		});

		expect(() =>
			registry.start({
				agentName: "reviewer",
				prompt: "review",
				run: () => new Promise(() => undefined),
			}),
		).not.toThrow();
	});
});
