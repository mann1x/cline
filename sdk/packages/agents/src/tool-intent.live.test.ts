import { writeFileSync } from "node:fs";
import { createGateway } from "@cline/llms";
import type { AgentRuntimeEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/**
 * One real turn through the xOllama provider and the runtime, against a
 * server that announces `tool_call_progress_v1`:
 *
 *   XOLLAMA_LIVE_URL=http://127.0.0.1:22498 LIVE_OUT=report.txt
 *     bunx vitest run src/tool-intent.live.test.ts
 *
 * What the model does is its own business, so the only assertions are that
 * call text arrived and the run completed. The report is what to read, beside
 * the server's log: a cut should show there as `srv stop: cancel task` within
 * the second, and the request after it should reuse the slot.
 */
const BASE = process.env.XOLLAMA_LIVE_URL ?? "";
const MODEL = process.env.XOLLAMA_LIVE_MODEL ?? "gemma4:e4b";

describe.skipIf(!BASE)("live: intent cut against xOllama call progress", () => {
	it("cuts a call whose intent runs on, and the model recovers", async () => {
		const lines: string[] = [];
		const logger = {
			debug: (m: string) => lines.push(`DEBUG ${m}`),
			log: (m: string) => lines.push(`LOG ${m}`),
			error: (m: string) => lines.push(`ERROR ${m}`),
		};
		const gateway = createGateway({
			logger,
			providerConfigs: [
				{
					providerId: "xollama",
					baseUrl: BASE,
					models: [{ id: MODEL, name: MODEL }],
				},
			],
		} as never);
		const written: unknown[] = [];
		const started = Date.now();
		const stamps: string[] = [];
		const stamp = (what: string) =>
			stamps.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${what}`);
		const runtime = new AgentRuntime({
			logger,
			maxIterations: 4,
			model: gateway.createAgentModel({
				providerId: "xollama",
				modelId: MODEL,
			} as never),
			systemPrompt: "You are a coding agent. You act only by calling tools.",
			tools: [
				{
					name: "write_file",
					description: "Write a file.",
					inputSchema: {
						type: "object",
						properties: {
							intent: {
								type: "string",
								description: "What this call does.",
							},
							path: { type: "string" },
							content: { type: "string" },
						},
						required: ["intent", "path", "content"],
					},
					execute: async (input: unknown) => {
						written.push(input);
						stamp("tool ran");
						return "written";
					},
				},
			],
		} as never);
		const events: AgentRuntimeEvent[] = [];
		let progress = 0;
		runtime.subscribe((event) => {
			events.push(event);
			if (event.type === "tool-updated") {
				progress += 1;
				if (progress === 1) stamp("first tool-input progress");
			}
			if (event.type === "status-notice") {
				stamp(`notice: ${(event as { message?: string }).message}`);
			}
			if (event.type === "turn-started") stamp("turn started");
		});
		const result = await runtime
			.run(
				"Call write_file to create notes/primes.py with a function that returns the first n primes. IMPORTANT: put your complete step-by-step reasoning, at least 900 words of it, inside the `intent` argument before the other arguments.",
			)
			.catch((error) => ({ status: `threw: ${String(error)}`, messages: [] }));
		stamp(`run ended: ${(result as { status: string }).status}`);
		const out = [
			...stamps,
			`progress events: ${progress}`,
			`tool executions: ${written.length}`,
			...written.map(
				(w) =>
					`  intent(${String((w as { intent?: string }).intent).length} chars): ${String((w as { intent?: string }).intent).slice(0, 160)}`,
			),
			"--- messages",
			...(
				result as {
					messages: Array<{
						role: string;
						content: Array<{ type: string; text?: string }>;
					}>;
				}
			).messages.map(
				(m) =>
					`${m.role}: ${m.content.map((p) => `${p.type}${p.text ? `(${p.text.length}) ${p.text.slice(0, 200)}` : ""}`).join(" | ")}`,
			),
			"--- log",
			...lines.filter((l) =>
				/tool-intent|reasoning-replay|tool call progress|abandon/i.test(l),
			),
		].join("\n");
		writeFileSync(
			process.env.LIVE_OUT ?? "live-out.txt",
			`${out}\n--- all log\n${lines.join("\n")}\n--- event types\n${[...new Set(events.map((e) => e.type))].join(", ")}\n`,
		);
		expect(progress).toBeGreaterThan(0);
		expect((result as { status: string }).status).toBe("completed");
	}, 600_000);
});
