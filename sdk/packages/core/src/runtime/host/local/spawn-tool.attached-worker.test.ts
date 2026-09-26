import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPolykvSession } from "@cline/llms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repointPolykvAfterCompaction } from "../../../extensions/context/polykv-session";

// A swarm worker attached to the LEAD's snapshot runs on a pool it does not
// own. Registered with no layout, a compaction inside it re-rooted that pool:
// forked it at branch_pos 0, then unpinned and released `previous` -- the
// lead's snapshot, which every other worker of the round is attached to.

/** What each worker saw of its own registration, and what re-rooting sent. */
const seen: Array<{
	sessionId: string;
	layout: string | undefined;
	poolId: string | undefined;
	after: string | undefined;
	calls: string[];
}> = [];

vi.mock("../../../extensions/tools/team/delegated-agent", () => ({
	createDelegatedAgent: (options: { engineSessionId: string }) => {
		const run = async () => {
			const state = getPolykvSession(options.engineSessionId);
			const calls: string[] = [];
			const fetchImpl = (async (input: unknown, init?: RequestInit) => {
				const url = new URL(String(input));
				calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
				if (url.pathname.endsWith("/fork")) {
					return Response.json({ pool_id: "pool-fork", prefix_len: 10 });
				}
				return new Response(null, { status: 204 });
			}) as unknown as typeof fetch;
			// What a compaction inside this worker would do next.
			await repointPolykvAfterCompaction({
				sessionId: options.engineSessionId,
				providerConfig: {
					providerId: "opencoti",
					baseUrl: "http://engine/v1",
					fetch: fetchImpl,
				},
				compactedPrompt: "summary",
			});
			seen.push({
				sessionId: options.engineSessionId,
				layout: state?.layout,
				poolId: state?.poolId,
				after: getPolykvSession(options.engineSessionId)?.poolId,
				calls,
			});
			return {
				text: "done",
				finishReason: "completed",
				iterations: 1,
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		};
		return { run, runWithHead: run };
	},
}));

vi.mock(
	"../../../extensions/context/polykv-session",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../extensions/context/polykv-session")
		>()),
		// The lead's snapshot: borrowed, never the worker's.
		snapshotPolykvSession: async () => ({
			poolId: "lead-pool",
			borrowed: true,
		}),
		readPolykvCapacity: async () => undefined,
	}),
);

const { createSessionSwarmTool } = await import("./spawn-tool");

describe("a swarm worker attached to the lead's snapshot", () => {
	let ws: string;

	beforeEach(async () => {
		seen.length = 0;
		ws = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-attached-"));
	});

	afterEach(async () => {
		await fs.rm(ws, { recursive: true, force: true });
	});

	it("never re-roots or releases the lead's pool when it compacts", async () => {
		const tool = createSessionSwarmTool(
			{
				getSession: () => ({ runtime: {} }) as never,
				subAgentStarts: new Map(),
				onAgentEvent: () => {},
				invokeBackendOptional: async () => {},
			} as never,
			{
				providerId: "opencoti",
				modelId: "m",
				cwd: ws,
				baseUrl: "http://engine/v1",
				enableTools: false,
			} as never,
			"lead-session",
		) as unknown as {
			execute: (input: unknown, context: unknown) => Promise<unknown>;
		};

		await tool.execute(
			{
				wait: true,
				systemPrompt: "s",
				tasks: [{ name: "w1", task: "task for w1" }],
			},
			{ agentId: "lead", conversationId: "c", iteration: 1 },
		);

		const attached = seen.filter((entry) => entry.poolId === "lead-pool");
		expect(attached.length).toBeGreaterThan(0);
		for (const entry of attached) {
			expect(entry.layout).toBe("borrowed");
			// Neither a fork of it nor an unpin/release of it.
			expect(entry.calls).toEqual([]);
			expect(entry.after).toBe("lead-pool");
		}
	});
});
