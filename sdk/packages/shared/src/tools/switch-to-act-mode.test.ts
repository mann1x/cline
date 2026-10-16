import { describe, expect, it, vi } from "vitest";
import {
	ACT_MODE_CONTINUATION_PROMPT,
	ALREADY_IN_ACT_MODE_MESSAGE,
	createSwitchToActModeTool,
	SWITCH_TO_ACT_MODE_TOOL_NAME,
	SWITCHED_TO_ACT_MODE_RESULT,
	sendTurnWithActModeContinuation,
	withSwitchToActModeTool,
} from "./switch-to-act-mode";

const run = (tool: ReturnType<typeof createSwitchToActModeTool>) =>
	tool.execute({}, {
		agentId: "a",
		conversationId: "c",
		iteration: 1,
	} as never);

describe("createSwitchToActModeTool", () => {
	it("queues the switch and ends the run on its result", async () => {
		const onSwitch = vi.fn();
		const tool = createSwitchToActModeTool({
			isActMode: () => false,
			onSwitch,
		});
		expect(tool.name).toBe(SWITCH_TO_ACT_MODE_TOOL_NAME);
		expect(tool.lifecycle?.completesRun).toBe(true);
		expect(tool.retryable).toBe(false);
		expect(tool.timeoutMs).toBe(5000);
		expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
		await expect(run(tool)).resolves.toBe(SWITCHED_TO_ACT_MODE_RESULT);
		expect(onSwitch).toHaveBeenCalledOnce();
	});

	it("fails rather than answers when already in act mode, so the run is not ended for nothing", async () => {
		const onSwitch = vi.fn();
		const tool = createSwitchToActModeTool({ isActMode: () => true, onSwitch });
		await expect(run(tool)).rejects.toThrow(ALREADY_IN_ACT_MODE_MESSAGE);
		expect(onSwitch).not.toHaveBeenCalled();
	});
});

describe("withSwitchToActModeTool", () => {
	const switchTool = { name: SWITCH_TO_ACT_MODE_TOOL_NAME };
	const host = [{ name: "browser" }, { name: "ask_lsp" }];

	it("adds it once in plan mode and keeps the host's tools", () => {
		const plan = withSwitchToActModeTool(host, "plan", switchTool);
		expect(plan.map((tool) => tool.name)).toEqual([
			"browser",
			"ask_lsp",
			SWITCH_TO_ACT_MODE_TOOL_NAME,
		]);
		expect(withSwitchToActModeTool(plan, "plan", switchTool)).toHaveLength(3);
	});

	it("drops it in act mode and keeps the host's tools", () => {
		const plan = withSwitchToActModeTool(host, "plan", switchTool);
		expect(withSwitchToActModeTool(plan, "act", switchTool)).toEqual(host);
		expect(withSwitchToActModeTool(undefined, "act", switchTool)).toEqual([]);
	});
});

describe("sendTurnWithActModeContinuation", () => {
	const turn = (finishReason: string, iterations: number) => ({
		finishReason,
		iterations,
	});

	it("continues on the act-mode session after a tool-initiated switch", async () => {
		const sendContinuationTurn = vi.fn(async () => turn("completed", 3));
		const result = await sendTurnWithActModeContinuation({
			sendInitialTurn: async () => turn("completed", 2),
			sendContinuationTurn,
			applyPendingModeChange: vi
				.fn()
				.mockResolvedValueOnce({ mode: "act", source: "tool" })
				.mockResolvedValueOnce(undefined),
		});
		expect(sendContinuationTurn).toHaveBeenCalledWith(
			ACT_MODE_CONTINUATION_PROMPT,
		);
		expect(result).toEqual(turn("completed", 5));
	});

	it("does not start the plan on a UI toggle", async () => {
		const sendContinuationTurn = vi.fn();
		await sendTurnWithActModeContinuation({
			sendInitialTurn: async () => turn("completed", 1),
			sendContinuationTurn,
			applyPendingModeChange: async () => ({ mode: "act", source: "ui" }),
		});
		expect(sendContinuationTurn).not.toHaveBeenCalled();
	});

	it("does not continue a turn that did not complete", async () => {
		const sendContinuationTurn = vi.fn();
		await sendTurnWithActModeContinuation({
			sendInitialTurn: async () => turn("aborted", 1),
			sendContinuationTurn,
			applyPendingModeChange: async () => ({ mode: "act", source: "tool" }),
		});
		expect(sendContinuationTurn).not.toHaveBeenCalled();
	});
});
