import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPipeline, savePipeline } from "../pipelines";
import { BOARD_VIEWER_REPLY } from "../protocol";
import { type BoardHostUi, createBoardBackend } from "./backend";
import { BoardSlots } from "./slots";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-backend-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A host with no editor: answers are scripted, notices recorded. */
function fakeUi(answers: { confirm?: string; ask?: string } = {}) {
	const asked: string[] = [];
	const notices: string[] = [];
	const ui: BoardHostUi = {
		pick: async (items) => items[0],
		input: async () => undefined,
		ask: async (options) => {
			asked.push(options.prompt);
			return answers.ask;
		},
		confirm: async (question) => {
			asked.push(question);
			return answers.confirm;
		},
		info: (message) => notices.push(message),
		error: (message) => notices.push(message),
		openFile: async () => undefined,
		saveFile: async () => undefined,
		readFile: async () => "",
		writeFile: async () => {},
	};
	return { ui, asked, notices };
}

const say = {
	name: "Say",
	nodes: [{ id: "say", type: "set", fields: { x: 1 } }],
};

describe("the Board tab's backend", () => {
	it("draws the workspace's pipelines and says when the tab is ready", async () => {
		savePipeline(root, say);
		const backend = createBoardBackend({
			workspaceRoot: () => root,
			ui: fakeUi().ui,
		});
		expect(await backend.handle({ type: "boardViewer/ready" })).toEqual({
			refresh: true,
			ready: true,
		});
		const data = await backend.data();
		expect(data.workspace).toBe(root);
		expect(data.pipelines.map((pipeline) => pipeline.slug)).toEqual(["say"]);
		expect(data.runs).toEqual([]);
	});

	it("answers a request that carries an id, and ignores one that does not", async () => {
		const backend = createBoardBackend({
			workspaceRoot: () => root,
			ui: fakeUi().ui,
		});
		const answer = await backend.handle({
			type: "boardViewer/validate",
			id: 7,
			definition: { name: "Broken", nodes: [] },
		});
		expect(answer.reply?.type).toBe(BOARD_VIEWER_REPLY);
		expect(answer.reply?.id).toBe(7);
		expect(answer.reply?.ok).toBe(false);
		expect(answer.refresh).toBe(false);
		expect(
			(await backend.handle({ type: "boardViewer/validate" })).reply,
		).toBeUndefined();
	});

	it("approves only what the person confirms, through the host's ui", async () => {
		savePipeline(root, say);
		const hash = findPipeline(root, "say")?.hash as string;
		const declined = fakeUi();
		const backend = createBoardBackend({
			workspaceRoot: () => root,
			ui: declined.ui,
		});
		const no = await backend.handle({
			type: "boardViewer/approve",
			id: 1,
			slug: "say",
			hash,
		});
		expect(no.reply?.ok).toBe(false);
		expect(declined.asked[0]).toContain("Approve Say");
		expect(findPipeline(root, "say")?.isApproved).toBe(false);

		const yes = createBoardBackend({
			workspaceRoot: () => root,
			ui: fakeUi({ confirm: "Approve" }).ui,
		});
		const approved = await yes.handle({
			type: "boardViewer/approve",
			id: 2,
			slug: "say",
			hash,
		});
		expect(approved.reply?.ok).toBe(true);
		expect(approved.refresh).toBe(true);
		expect(findPipeline(root, "say")?.isApproved).toBe(true);
	});

	it("saves a board as a pipeline and shows it next", async () => {
		const host = fakeUi({ ask: "From the board" });
		const backend = createBoardBackend({
			workspaceRoot: () => root,
			ui: host.ui,
		});
		const answer = await backend.handle({
			type: "boardViewer/boardToPipeline",
			id: 3,
			tasks: [{ id: "T1", title: "Write it" }],
		});
		expect(answer.reply?.ok).toBe(true);
		expect(host.notices[0]).toContain("Read it and approve it before it runs");
		expect((await backend.data()).focus).toEqual({
			pipeline: "from-the-board",
		});
		// The focus is for the next draw only.
		expect((await backend.data()).focus).toBeUndefined();
	});

	it("changes a draft board without any conversation behind it", async () => {
		let stored: unknown[] | undefined;
		const boards = new BoardSlots({
			workspaceRoot: () => root,
			conversation: () => undefined,
			liveText: () => undefined,
			liveEvents: () => undefined,
			liveEdit: () => ({ ok: false, lines: [] }),
			turnRunning: () => false,
			draftStorage: () => ({
				get: () => stored,
				set: (events) => (stored = events),
			}),
			recent: async () => [],
			saved: () => [],
			savedEvents: () => undefined,
			saveConversation: async () => ({ ok: false, lines: [] }),
			saveEvents: async () => ({ ok: false, lines: [] }),
			deleteSaved: async () => false,
			startConversation: () => {},
		});
		const backend = createBoardBackend({
			workspaceRoot: () => root,
			boards,
			ui: fakeUi().ui,
		});
		const added = await backend.handle({
			type: "boardViewer/addTask",
			id: 4,
			title: "First step",
		});
		expect(added.reply?.ok).toBe(true);
		const data = await backend.data();
		expect(data.boardDraft).toBe(true);
		expect(data.boardText).toContain("First step");
		expect(data.boards?.map((entry) => entry.key)).toEqual([
			"draft:1",
			"draft:2",
			"draft:3",
		]);
	});
});
