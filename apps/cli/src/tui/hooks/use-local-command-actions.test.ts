import { describe, expect, it, vi } from "vitest";
import { formatCompactionStatus } from "../utils/compaction-status";
import {
	type LocalSlashCommandActionInput,
	runLocalSlashCommandAction,
} from "./local-command-actions";

function makeActions(
	overrides: Partial<Omit<LocalSlashCommandActionInput, "name">> = {},
): Omit<LocalSlashCommandActionInput, "name"> {
	return {
		isRunning: false,
		openAccount: vi.fn(),
		openConfig: vi.fn(),
		openMcpManager: vi.fn(async () => false),
		openModelSelector: vi.fn(),
		openSkills: vi.fn(),
		openThemePicker: vi.fn(),
		runCompact: vi.fn(),
		queueCompact: vi.fn(),
		runDelegate: vi.fn(),
		runFork: vi.fn(),
		runUndo: vi.fn(async () => {}),
		clearConversation: vi.fn(async () => {}),
		openHelp: vi.fn(),
		openHistory: vi.fn(),
		exitCline: vi.fn(),
		...overrides,
	};
}

describe("runLocalSlashCommandAction", () => {
	it("opens the skills picker with skills", () => {
		const openSkills = vi.fn();
		const actions = makeActions({ openSkills });
		const invocation = {
			text: "please /skills",
			cursorOffset: "please /skills".length,
			replaceRange: { start: "please ".length, end: "please /skills".length },
		};

		const handled = runLocalSlashCommandAction({
			name: "skills",
			invocation,
			...actions,
		});

		expect(handled).toBe(true);
		expect(openSkills).toHaveBeenCalledWith(invocation);
	});

	it("opens settings to the plugins tab with plugins", () => {
		const openConfig = vi.fn();
		const actions = makeActions({ openConfig });

		const handled = runLocalSlashCommandAction({
			name: "plugins",
			...actions,
		});

		expect(handled).toBe(true);
		expect(openConfig).toHaveBeenCalledWith({ initialTab: "plugins" });
	});

	it("routes /delegate to the delegate action, running or not", () => {
		for (const isRunning of [false, true]) {
			const runDelegate = vi.fn();
			const actions = makeActions({ isRunning, runDelegate });
			const invocation = {
				text: "/delegate qa run the suite",
				cursorOffset: 0,
			};

			const handled = runLocalSlashCommandAction({
				name: "delegate",
				invocation,
				...actions,
			});

			expect(handled).toBe(true);
			// Unlike /compact, delegation does not touch the conversation until
			// the agent has finished, so a running turn is not a reason to defer.
			expect(runDelegate).toHaveBeenCalledWith(invocation);
		}
	});

	it("queues compaction instead of starting it mid-turn", () => {
		const runCompact = vi.fn();
		const queueCompact = vi.fn();
		const actions = makeActions({ isRunning: true, runCompact, queueCompact });

		const handled = runLocalSlashCommandAction({
			name: "compact",
			...actions,
		});

		expect(handled).toBe(true);
		// Compacting under the live agent loop races it, so the request waits --
		// but it is not dropped, which is what the user saw before.
		expect(runCompact).not.toHaveBeenCalled();
		expect(queueCompact).toHaveBeenCalledOnce();
	});

	it("starts compaction while the session is idle", () => {
		const runCompact = vi.fn();
		const actions = makeActions({ runCompact });

		const handled = runLocalSlashCommandAction({
			name: "compact",
			...actions,
		});

		expect(handled).toBe(true);
		expect(runCompact).toHaveBeenCalledOnce();
		expect(actions.queueCompact).not.toHaveBeenCalled();
	});

	it("waits for clear to reset the runtime session", async () => {
		let resolveClear: (() => void) | undefined;
		const clearConversation = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClear = resolve;
				}),
		);
		const actions = makeActions({ clearConversation });

		const handled = runLocalSlashCommandAction({
			name: "clear",
			...actions,
		});
		const handledPromise = Promise.resolve(handled);
		let settled = false;
		void handledPromise.then(() => {
			settled = true;
		});

		await Promise.resolve();

		expect(clearConversation).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		resolveClear?.();

		expect(await handledPromise).toBe(true);
		expect(settled).toBe(true);
	});

	it("waits for undo to finish restoring", async () => {
		let resolveUndo: (() => void) | undefined;
		const runUndo = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveUndo = resolve;
				}),
		);
		const actions = makeActions({ runUndo });

		const handled = runLocalSlashCommandAction({
			name: "undo",
			...actions,
		});
		const handledPromise = Promise.resolve(handled);
		let settled = false;
		void handledPromise.then(() => {
			settled = true;
		});

		await Promise.resolve();

		expect(runUndo).toHaveBeenCalledOnce();
		expect(settled).toBe(false);

		resolveUndo?.();

		expect(await handledPromise).toBe(true);
		expect(settled).toBe(true);
	});

	it("exits Cline with quit", () => {
		vi.useFakeTimers();
		const exitCline = vi.fn();
		const actions = makeActions({ exitCline });

		try {
			const handled = runLocalSlashCommandAction({
				name: "quit",
				...actions,
			});

			expect(handled).toBe(true);
			expect(exitCline).not.toHaveBeenCalled();

			vi.runAllTimers();

			expect(exitCline).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("formatCompactionStatus", () => {
	it("reports when core did not return a compaction result", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 300,
				messagesAfter: 300,
				compacted: false,
			}),
		).toBe("No compaction needed.");
	});

	it("reports same-count compaction without implying no-op", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 300,
				messagesAfter: 300,
				compacted: true,
			}),
		).toBe("Compacted context; message count stayed at 300 messages.");
	});

	it("reports empty sessions separately", () => {
		expect(
			formatCompactionStatus({
				messagesBefore: 0,
				messagesAfter: 0,
				compacted: false,
			}),
		).toBe("No messages to compact.");
	});
});
