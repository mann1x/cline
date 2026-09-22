import { describe, expect, it } from "vitest";
import { parseAgentNodeFlags } from "./agent-nodes-flag";

describe("--agent-node", () => {
	// The shape a user types. Everything but the model is optional, because a
	// node on the session's own provider and endpoint is the common case: what
	// makes it a node is that agents run there, with their own capacity.
	it("reads model, url, provider, priority and capacity", () => {
		const nodes = parseAgentNodeFlags([
			"model=small,url=http://a:8240/v1,provider=opencoti,priority=1,capacity=8",
		]);

		expect(nodes).toEqual([
			{
				id: "node1",
				priority: 1,
				capacity: 8,
				connection: {
					providerId: "opencoti",
					modelId: "small",
					baseUrl: "http://a:8240/v1",
				},
			},
		]);
	});

	it("numbers the nodes in the order they were given", () => {
		const nodes = parseAgentNodeFlags(["model=a", "model=b", "model=c"]);
		expect(nodes.map((node) => node.id)).toEqual(["node1", "node2", "node3"]);
	});

	// Same defaults the panel uses: tier 1, and a capacity of 1 -- the count
	// under which nothing queues unexpectedly on a server nobody described.
	it("defaults priority to 1 and capacity to 1", () => {
		expect(parseAgentNodeFlags(["model=a"])[0]).toMatchObject({
			priority: 1,
			capacity: 1,
		});
	});

	it("holds priority to 1-10 and capacity to at least 1", () => {
		const [low, high] = parseAgentNodeFlags([
			"model=a,priority=0,capacity=1",
			"model=b,priority=99,capacity=3.7",
		]);
		expect(low).toMatchObject({ priority: 1, capacity: 1 });
		expect(high).toMatchObject({ priority: 10, capacity: 3 });
	});

	// An elastic endpoint -- opencoti with PolyKV admission, an ollama with
	// OLLAMA_NUM_PARALLEL unset -- has a count we cannot read and must not
	// invent. Infinity says "we impose no ceiling"; the endpoint still
	// refuses what it cannot take. Written as a number rather than a flag
	// because the placement engine already compares occupancy against it.
	it("reads capacity=auto as no ceiling of ours", () => {
		expect(parseAgentNodeFlags(["model=a,capacity=auto"])[0].capacity).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	// 0 is the one value with two honest readings -- "off" in the tab, "no
	// limit" on most command lines -- and picking either silently would give
	// the user the other one. A node you do not want is a flag you do not
	// pass, so the flag says which word to write.
	it("refuses capacity=0 rather than guessing which one was meant", () => {
		expect(() => parseAgentNodeFlags(["model=a,capacity=0"])).toThrow(
			/capacity=auto/,
		);
	});

	// A node that names nothing is a typo, and running it on the session's own
	// model under a capacity the user meant for something else is worse than
	// saying so.
	it("refuses an entry with no model", () => {
		expect(() => parseAgentNodeFlags(["priority=2"])).toThrow(/model/i);
		expect(() => parseAgentNodeFlags(["nonsense"])).toThrow(/model/i);
	});

	it("is nothing at all when the flag was not passed", () => {
		expect(parseAgentNodeFlags(undefined)).toEqual([]);
	});
});
