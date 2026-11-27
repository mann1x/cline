import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AttachedTaskBoard, attachTaskBoard } from "../attach";
import type { TaskGraphSeed } from "../task-graph";
import { SESSION_BOARD_LOG_SUFFIX, sessionBoardSlots } from "./session-slots";

let root: string;
let logs: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "session-slots-"));
	logs = join(root, "logs");
	mkdirSync(logs);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const ctx = { agentId: "lead", iteration: 1 } as never;

async function plan(board: AttachedTaskBoard, titles: string[]) {
	const tool = board.tools().find((entry) => entry.name === "task_plan");
	await tool?.execute({ tasks: titles.map((title) => ({ title })) }, ctx);
}

function setup(open?: { board: AttachedTaskBoard; running?: boolean }) {
	const started: TaskGraphSeed[] = [];
	let current = open;
	const slots = sessionBoardSlots({
		workspaceRoot: () => root,
		conversation: () => current,
		logDir: () => logs,
		startConversation: (seed, onTaken) => {
			started.push(seed);
			onTaken();
		},
	});
	return {
		slots,
		started,
		close: () => {
			current = undefined;
		},
	};
}

describe("sessionBoardSlots", () => {
	it("shows the open conversation's board and passes the person's edits to it", async () => {
		const board = attachTaskBoard({ sessionId: "c1" });
		await plan(board, ["Write the parser"]);
		const { slots } = setup({ board });
		const entries = await slots.list();
		expect(entries[0]).toMatchObject({ key: "live", tasks: 1, editable: true });
		const outcome = slots.edit("live", {
			op: "plan",
			tasks: [{ title: "Added by the person" }],
		});
		expect(outcome.ok).toBe(true);
		expect(board.control.snapshot().tasks.map((task) => task.title)).toContain(
			"Added by the person",
		);
		// The model hears of it at its next run.
		expect(board.runStartNote()).toContain("Added by the person");
	});

	it("keeps drafts in the workspace, and hands one to the next conversation", async () => {
		const first = setup();
		expect(
			first.slots.edit("draft:1", {
				op: "plan",
				tasks: [{ title: "Draft step" }],
			}).ok,
		).toBe(true);
		expect(
			existsSync(join(root, ".cerebriline", "boards", "drafts", "1.json")),
		).toBe(true);
		// A new process reads the same draft back.
		const again = setup();
		expect(
			(await again.slots.list()).find((entry) => entry.key === "draft:1")
				?.tasks,
		).toBe(1);
		const outcome = again.slots.start("draft:1");
		expect(outcome.ok).toBe(true);
		expect(again.started[0]?.events.length).toBeGreaterThan(0);
		expect(again.started[0]?.by).toBe("person");
		// Taken: the draft is cleared.
		expect(
			existsSync(join(root, ".cerebriline", "boards", "drafts", "1.json")),
		).toBe(false);
	});

	it("lists recent conversations from their logs and saves, lists and deletes boards", async () => {
		const past = attachTaskBoard({
			sessionId: "old-1",
			logPath: join(logs, `old-1${SESSION_BOARD_LOG_SUFFIX}`),
		});
		await plan(past, ["From before", "And after"]);
		const { slots } = setup();
		const recent = (await slots.list()).find(
			(entry) => entry.key === "recent:old-1",
		);
		expect(recent?.tasks).toBe(2);

		const saved = await slots.save("recent:old-1");
		expect(saved.ok).toBe(true);
		const listed = (await slots.list()).filter(
			(entry) => entry.kind === "saved",
		);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.tasks).toBe(2);
		expect((await slots.deleteSaved(listed[0]?.key ?? "")).ok).toBe(true);
		expect(
			(await slots.list()).filter((entry) => entry.kind === "saved"),
		).toHaveLength(0);
	});

	it("refuses ids that would name a file outside its folders", async () => {
		const { slots } = setup();
		expect((await slots.save("recent:../../etc/passwd")).ok).toBe(false);
		expect((await slots.deleteSaved("saved:boards/..%2F..%2Fpackage")).ok).toBe(
			false,
		);
	});
});
