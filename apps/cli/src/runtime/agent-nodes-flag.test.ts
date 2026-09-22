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
			"model=a,priority=0,capacity=0",
			"model=b,priority=99,capacity=3.7",
		]);
		expect(low).toMatchObject({ priority: 1, capacity: 1 });
		expect(high).toMatchObject({ priority: 10, capacity: 3 });
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
