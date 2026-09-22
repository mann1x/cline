import { describe, expect, it, vi } from "vitest";
import type { AgentNodeRuntimeConfig } from "./agent-node-placement";
import { createAgentNodePlacement } from "./agent-node-placement";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

function baseProvider(modelId: string) {
	return createDelegatedAgentConfigProvider({
		providerId: "opencoti",
		modelId,
		cwd: "/w",
		apiKey: "",
	} as never);
}

function node(
	id: string,
	priority: number,
	capacity: number,
	modelId = id,
): AgentNodeRuntimeConfig {
	return {
		id,
		priority,
		capacity,
		connection: { providerId: "opencoti", modelId },
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every case but the empty one configures a node, so one is returned. */
function required<T>(value: T | undefined): T {
	if (!value) {
		throw new Error("expected a placement");
	}
	return value;
}

describe("placing an agent on a node", () => {
	it("hands out the node's own connection, not the session's", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 2, "small")],
				base: baseProvider("lead-model"),
			}),
		);

		const placed = await placement.place();

		expect(placed.nodeId).toBe("n1");
		expect(placed.configProvider.getRuntimeConfig().modelId).toBe("small");
		// The session's own provider is untouched: a second agent elsewhere must
		// not find the lead's connection rewritten under it.
		expect(placement.base.getRuntimeConfig().modelId).toBe("lead-model");
	});

	// The tier rules are agent-placement.ts's and are tested there; this is the
	// wiring around them, which is what decides whether a lower tier is ever
	// reached at all.
	it("fills tier 1 before tier 2 and comes back up when a slot frees", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 1), node("n2", 2, 1)],
				base: baseProvider("lead"),
			}),
		);

		const first = await placement.place();
		const second = await placement.place();
		expect([first.nodeId, second.nodeId]).toEqual(["n1", "n2"]);

		first.release();
		expect((await placement.place()).nodeId).toBe("n1");
	});

	it("waits when every node is full, and starts on the first release", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 1)],
				base: baseProvider("lead"),
			}),
		);
		const held = await placement.place();

		let waited: string | undefined;
		void placement.place().then((placed) => {
			waited = placed.nodeId;
		});
		await settle();
		expect(waited).toBeUndefined();

		held.release();
		await settle();
		expect(waited).toBe("n1");
	});

	// Two nodes on one server are two of its slots, not one queue.
	//
	// A placed agent used to run inside the shared per-endpoint gate as well
	// as its node's lease, and that gate is one object per provider+baseUrl --
	// so two nodes on one opencoti, or two ollama nodes carrying two different
	// cloud models, ran strictly one agent at a time however they were
	// configured. Measured on pandorum 2026-09-22: three nodes, three agents,
	// each starting only as the one before it finished.
	//
	// How many requests a server takes at once is its own answer (`--parallel`,
	// `OLLAMA_NUM_PARALLEL`, more under PolyKV admission with elastic slots).
	// The nodes are the user saying how much of it to use, and the server
	// refusing is the backstop.
	it("runs agents on two nodes of one endpoint at the same time", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 1), node("n2", 1, 1)],
				base: baseProvider("lead"),
			}),
		);

		const first = await placement.place();
		const second = await placement.place();
		expect([first.nodeId, second.nodeId]).toEqual(["n1", "n2"]);

		let firstRunning = false;
		let bothRanTogether = false;
		const firstRun = first.run(async () => {
			firstRunning = true;
			await settle();
		});
		const secondRun = second.run(async () => {
			bothRanTogether = firstRunning;
		});

		await Promise.all([firstRun, secondRun]);
		expect(bothRanTogether).toBe(true);
	});

	it("releases the node once, however the run ended", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 1)],
				base: baseProvider("lead"),
			}),
		);
		const placed = await placement.place();
		placed.release();
		placed.release();

		// Free again for exactly one more agent, not two.
		const next = await placement.place();
		expect(next.nodeId).toBe("n1");
		let third: string | undefined;
		void placement.place().then((p) => {
			third = p.nodeId;
		});
		await settle();
		expect(third).toBeUndefined();
	});

	// Nothing configured is the shape every session had before nodes existed.
	it("is not built at all when no node is configured", () => {
		expect(
			createAgentNodePlacement({ nodes: [], base: baseProvider("lead") }),
		).toBeUndefined();
	});

	// A node's connection is pinned exactly as the single Agents tab's is: a
	// host pushing the session's refreshed model must not move agents back.
	it("pins the fields the node names", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 1, "small")],
				base: baseProvider("lead"),
			}),
		);
		const placed = await placement.place();

		placed.configProvider.updateConnectionDefaults({
			modelId: "lead-v2",
			apiKey: "rotated",
		} as never);

		const config = placed.configProvider.getRuntimeConfig();
		expect(config.modelId).toBe("small");
		expect(config.apiKey).toBe("rotated");
	});

	it("reports what it is holding, for a status line", async () => {
		const placement = required(
			createAgentNodePlacement({
				nodes: [node("n1", 1, 2), node("n2", 2, 1)],
				base: baseProvider("lead"),
			}),
		);
		await placement.place();
		const placed = await placement.place();
		await placement.place();
		// Three slots, three agents: the fourth is the one that waits.
		void placement.place();
		await settle();

		expect(placement.occupancy()).toEqual(
			new Map([
				["n1", 2],
				["n2", 1],
			]),
		);
		expect(placement.waiting).toBe(1);
		placed.release();
	});
});
