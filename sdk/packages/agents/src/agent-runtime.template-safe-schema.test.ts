import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentTool,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

class OneTurnModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];
	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		return (async function* () {
			yield {
				type: "text-delta",
				text: "The task is complete.",
			} as AgentModelEvent;
			yield { type: "finish", reason: "stop" } as AgentModelEvent;
		})();
	}
}

const tool = (
	name: string,
	inputSchema: AgentTool["inputSchema"],
): AgentTool => ({
	name,
	description: name,
	inputSchema,
	execute: async () => "ok",
});

/**
 * mail #2357: an `items` list type fails Gemma 4's canonical template under
 * llama.cpp's jinja (HTTP 500). An MCP server's schema is not ours to edit,
 * so the request carries every tool's schema in the form that renders.
 */
describe("tool schemas on their way into a request", () => {
	it("an MCP tool's items list type goes out as anyOf, logged once; clean schemas pass as they are", async () => {
		const mcpSchema = {
			type: "object",
			properties: {
				ids: { type: "array", items: { type: ["integer", "string"] } },
			},
		} as AgentTool["inputSchema"];
		const cleanSchema = {
			type: "object",
			properties: { path: { type: ["string", "null"] } },
		} as AgentTool["inputSchema"];
		const log = vi.fn();
		const model = new OneTurnModel();
		const runtime = new AgentRuntime({
			model,
			tools: [
				tool("server__lookup", mcpSchema),
				tool("read_files", cleanSchema),
			],
			logger: {
				log,
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			} as never,
		});
		await runtime.run("go");
		await runtime.run("again");
		const sent = model.requests[0]?.tools ?? [];
		const lookup = sent.find((entry) => entry.name === "server__lookup");
		expect(lookup?.inputSchema).toEqual({
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { anyOf: [{ type: "integer" }, { type: "string" }] },
				},
			},
		});
		expect(sent.find((entry) => entry.name === "read_files")?.inputSchema).toBe(
			cleanSchema,
		);
		// The server's own schema object is left as it was.
		expect(JSON.stringify(mcpSchema)).toContain('["integer","string"]');
		const logged = log.mock.calls.filter((call) =>
			String(call[0]).includes("server__lookup"),
		);
		expect(logged).toHaveLength(1);
		expect(
			log.mock.calls.some((call) => String(call[0]).includes("read_files")),
		).toBe(false);
	});
});
