import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	TurnFault,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";

type Step = () => AgentModelEvent[] | Promise<never>;

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly steps: Step[]) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted model step available");
		}
		const events = await step();
		return (async function* () {
			for (const event of events) {
				yield event;
			}
		})();
	}
}

const finishOk = (text: string): AgentModelEvent[] => [
	{ type: "text-delta", text },
	{ type: "finish", reason: "stop" },
];

/**
 * 1tmrl, build .191: the server behind Node1 restarted twice, and every agent
 * with a stream open on it ended `server is shutting down` -- a turn it could
 * simply have sent again once the server was back.
 */
describe("a turn the server dropped", () => {
	it("is sent again once the recovery says so, and the run completes", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "reasoning-delta", text: "half a thought" },
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
			() => finishOk("done"),
		]);
		const faults: TurnFault[] = [];
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async (fault) => {
				faults.push(fault);
				return true;
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
		expect(faults).toHaveLength(1);
		expect(faults[0]).toMatchObject({
			kind: "transport",
			message: "server is shutting down",
			attempt: 1,
		});
	});

	it("never lets the aborted turn into the transcript", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "PARTIAL" },
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
			() => finishOk("done"),
		]);
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async () => true,
		});

		const result = await runtime.run("go");

		expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(
			"PARTIAL",
		);
		expect(JSON.stringify(result.messages)).not.toContain("PARTIAL");
	});

	it("retries a thrown connection error, without limit", async () => {
		const refused = () =>
			Promise.reject(
				Object.assign(new Error("fetch failed"), {
					cause: Object.assign(new Error("connect ECONNREFUSED"), {
						code: "ECONNREFUSED",
					}),
				}),
			);
		const model = new ScriptedModel([
			...Array.from({ length: 12 }, () => refused),
			() => finishOk("back"),
		]);
		const recover = vi.fn(async () => true);
		const runtime = new AgentRuntime({ model, recoverTurnFault: recover });

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(recover).toHaveBeenCalledTimes(12);
		expect(recover.mock.calls.at(-1)?.[0]).toMatchObject({
			kind: "transport",
			attempt: 12,
		});
	});

	it("retries a 503 from the gateway", async () => {
		const model = new ScriptedModel([
			() => [{ type: "finish", reason: "error", error: "Service Unavailable" }],
			() => finishOk("ok"),
		]);
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async () => true,
		});

		expect((await runtime.run("go")).status).toBe("completed");
	});

	it("retries a stream the SDK could not validate, as transport", async () => {
		// 4.100.195: the keepalive stream's `data: null` first frame, rejected
		// by the chunk schema, ended 48 of 75 agents as a task failure.
		const error =
			'Type validation failed: Value: null.\nError message: [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received null"}]';
		const model = new ScriptedModel([
			() => [{ type: "finish", reason: "error", error }],
			() => finishOk("Hi!"),
		]);
		const faults: TurnFault[] = [];
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async (fault) => {
				faults.push(fault);
				return true;
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("Hi!");
		expect(faults).toMatchObject([{ kind: "transport", attempt: 1 }]);
	});

	it("says so on the transcript's notice path while it waits", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
			() => finishOk("ok"),
		]);
		const notices: unknown[] = [];
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async () => true,
		});
		runtime.subscribe((event) => {
			if (event.type === "status-notice") {
				notices.push(event.metadata);
			}
		});

		await runtime.run("go");

		expect(notices).toContainEqual(
			expect.objectContaining({
				kind: "turn_fault_recovery",
				reason: "transport",
			}),
		);
	});

	it("fails as before when the recovery declines", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: async () => false,
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("server is shutting down");
	});

	it("fails as before with no recovery configured", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		expect((await runtime.run("go")).status).toBe("failed");
		expect(model.requests).toHaveLength(1);
	});

	it("never retries a failure that is the request's own", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "finish",
					reason: "error",
					error: "400 invalid_request_error: unknown field",
				},
			],
		]);
		const recover = vi.fn(async () => true);
		const runtime = new AgentRuntime({ model, recoverTurnFault: recover });

		expect((await runtime.run("go")).status).toBe("failed");
		expect(recover).not.toHaveBeenCalled();
	});

	it("ends at once on Stop, however long the wait", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "finish", reason: "error", error: "server is shutting down" },
			],
		]);
		let entered: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const runtime = new AgentRuntime({
			model,
			recoverTurnFault: (fault) =>
				new Promise<boolean>((resolve) => {
					entered();
					fault.signal?.addEventListener("abort", () => resolve(true), {
						once: true,
					});
				}),
		});

		const running = runtime.run("go");
		await waiting;
		runtime.abort("stopped by the user");
		const result = await running;

		expect(result.status).toBe("aborted");
		expect(model.requests).toHaveLength(1);
	});
});

/**
 * 1tmrl: 18 agents were refused on a LATER turn -- "projected mean tps below
 * floor" -- and ended on it. A refusal is the engine saying "not now".
 */
describe("a turn the engine refused after the agent had started", () => {
	it("is waited out and sent again, as many times as it takes", async () => {
		const refused = (): AgentModelEvent[] => [
			{
				type: "finish",
				reason: "error",
				error: "pool 5 admission rejected: projected mean tps below floor",
			},
		];
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "c1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			...Array.from({ length: 7 }, () => refused),
			() => finishOk("done"),
		]);
		const kinds: string[] = [];
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo",
					description: "echo",
					inputSchema: { type: "object" },
					execute: async (input: unknown) => input,
				},
			],
			recoverTurnFault: async (fault) => {
				kinds.push(`${fault.kind}#${fault.attempt}@${fault.iteration}`);
				return true;
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
		expect(kinds).toHaveLength(7);
		expect(kinds[0]).toBe("refusal#1@2");
		expect(kinds.at(-1)).toBe("refusal#7@2");
	});
});

/**
 * opencoti's partial eviction (b108 swarm 0926: 11 agents holding 20-31k of
 * 64k). Ruled: no session is ever evicted -- an eviction is the engine's bug.
 * The turn is waited out like a refusal, and reported, at WARN, as a bug.
 */
describe("a turn the engine evicted", () => {
	const lines = () => {
		const logged: Array<{ message: string; severity?: unknown }> = [];
		return {
			logged,
			logger: {
				debug: () => {},
				log: (message: string, metadata?: Record<string, unknown>) => {
					logged.push({ message, severity: metadata?.severity });
				},
			},
		};
	};

	it("is retried as a refusal and reported as an engine bug, with the session and what it held", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "c1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "usage", usage: { inputTokens: 20_000, outputTokens: 500 } },
				{ type: "finish", reason: "tool-calls" },
			],
			// kv_observable_v1: the class comes from `error_kind`; the text
			// need not say anything.
			() => [
				{
					type: "finish",
					reason: "error",
					error: "Internal Server Error",
					errorClass: "kv_evicted",
				},
			],
			() => finishOk("done"),
		]);
		const faults: TurnFault[] = [];
		const { logged, logger } = lines();
		const runtime = new AgentRuntime({
			model,
			sessionId: "sess-evicted",
			logger,
			tools: [
				{
					name: "echo",
					description: "echo",
					inputSchema: { type: "object" },
					execute: async (input: unknown) => input,
				},
			],
			recoverTurnFault: async (fault) => {
				faults.push(fault);
				return true;
			},
		} as never);

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(faults).toMatchObject([
			{
				kind: "refusal",
				evicted: true,
				tokensHeld: 20_500,
				sessionId: "sess-evicted",
			},
		]);
		const warnings = logged.filter((line) => line.severity === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toMatch(/^Engine bug: .*evicted/);
		expect(warnings[0]?.message).toContain("sess-evicted");
		expect(warnings[0]?.message).toContain("20,500 tokens");
		expect(warnings[0]?.message).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
	});

	it("leaves a refusal at info: pacing, not a fault", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "finish",
					reason: "error",
					error: "pool 5 admission rejected: projected mean tps below floor",
				},
			],
			() => finishOk("done"),
		]);
		const faults: TurnFault[] = [];
		const { logged, logger } = lines();
		const runtime = new AgentRuntime({
			model,
			logger,
			recoverTurnFault: async (fault) => {
				faults.push(fault);
				return true;
			},
		} as never);

		await runtime.run("go");

		expect(faults[0]?.evicted).toBeUndefined();
		expect(logged.filter((line) => line.severity === "warn")).toEqual([]);
		expect(
			logged.some(
				(line) =>
					/refusal fault/.test(line.message) && line.severity === "info",
			),
		).toBe(true);
	});
});
