// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom cannot lay out a canvas; the graph it would draw is tested in board-viewer.test.ts.
vi.mock("../../components/board-viewer/Canvas.js", () => ({
	Canvas: ({
		graph,
		onSelect,
		edit,
	}: {
		graph: { nodes: { id: string }[] };
		onSelect: (id: string) => void;
		edit?: {
			kind?: string;
			onAdd?: (type: string) => void;
			onConnect: (
				source: string,
				port: string | undefined,
				target: string,
			) => void;
			onDeleteEdge: (id: string) => void;
		};
	}) => (
		<div data-testid="canvas">
			{graph.nodes.map((node) => (
				<button key={node.id} onClick={() => onSelect(node.id)} type="button">
					card {node.id}
				</button>
			))}
			{edit?.onAdd && (
				<button onClick={() => edit.onAdd?.("command")} type="button">
					palette command
				</button>
			)}
			{edit?.kind === "task" && (
				<>
					<button
						onClick={() =>
							edit.onConnect(
								graph.nodes[0]?.id ?? "",
								undefined,
								graph.nodes.at(-1)?.id ?? "",
							)
						}
						type="button"
					>
						connect first to last
					</button>
					<button onClick={() => edit.onDeleteEdge("t1->t2")} type="button">
						delete edge t1-&gt;t2
					</button>
				</>
			)}
		</div>
	),
}));

import { BoardViewer } from "../../components/board-viewer/BoardViewer.js";
import { windowMessageTransport } from "../../components/board-viewer/model.js";

// The host answers with window messages, as a VS Code webview's does.
const posted: unknown[] = [];
const transport = windowMessageTransport((message) => posted.push(message));
afterEach(cleanup);

const data = {
	workspace: "/home/me/game",
	boardText: JSON.stringify({
		layers: [["t1"]],
		tasks: [
			{
				id: "t1",
				title: "Run the release pipeline",
				status: "active",
				priority: "H",
				depends: [],
				openDepends: [],
				acceptance: [{ text: "tests pass", done: true }],
				later: false,
				files: [],
				notes: [],
				ready: false,
				blocked: false,
				claimedBy: "pipeline:release-1",
			},
		],
	}),
	pipelines: [
		{
			name: "release",
			slug: "release",
			path: "/home/me/game/.cerebriline/pipelines/release.pipeline.json",
			hash: "abc123",
			text: '{"name":"release"}',
			valid: true,
			errors: [],
			isApproved: true,
			definition: {
				name: "release",
				nodes: [
					{ id: "build", type: "command", command: "make" },
					{ id: "ship", type: "tool", tool: "publish", after: ["build"] },
				],
			},
		},
	],
	runs: [
		{
			id: "release-1",
			pipeline: "release",
			hash: "abc123",
			status: "failed",
			startedAt: 1_000,
			endedAt: 5_000,
			error: "ship failed",
			inputs: {},
			nodes: {
				build: {
					status: "done",
					attempts: 1,
					startedAt: 1_000,
					endedAt: 2_000,
					output: { items: [], port: "out" },
				},
				ship: {
					status: "failed",
					attempts: 2,
					startedAt: 2_000,
					endedAt: 5_000,
					error: "publish refused",
				},
			},
			events: [
				{
					t: "run",
					ts: 1_000,
					run: "release-1",
					pipeline: "release",
					hash: "abc123",
					inputs: {},
				},
				{ t: "fail", ts: 5_000, node: "ship", error: "publish refused" },
			],
			eventCount: 2,
		},
	],
};

const send = (payload: object) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "boardViewer/data", data: payload },
			}),
		);
	});

/** The extension's answer to the last request of `type`. */
const answer = (
	type: string,
	payload: {
		ok: boolean;
		errors?: string[];
		lines?: string[];
		run?: string;
		pipeline?: string;
	},
) => {
	const request = [...posted]
		.reverse()
		.find((message) => (message as { type?: string }).type === type) as
		| { id: number }
		| undefined;
	if (!request) throw new Error(`nothing asked ${type}`);
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "boardViewer/reply", id: request.id, ...payload },
			}),
		);
	});
};
const sentOf = (type: string) =>
	posted.filter((message) => (message as { type?: string }).type === type);

describe("the board viewer", () => {
	beforeEach(() => {
		posted.length = 0;
	});

	it("asks for its data, then opens on the board with the task in the inspector", () => {
		render(<BoardViewer transport={transport} />);
		expect(posted).toEqual([{ type: "boardViewer/ready" }]);
		expect(screen.getByText("Reading the workspace…")).toBeTruthy();
		send(data);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Conversation board",
		);
		fireEvent.click(screen.getByText("card t1"));
		const inspector = screen.getByRole("complementary", { name: "Inspector" });
		expect(inspector.textContent).toContain("Run the release pipeline");
		expect(inspector.textContent).toContain("tests pass");
		// A run's task leads to the run.
		fireEvent.click(screen.getByText("pipeline run release-1"));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Run release-1",
		);
	});

	it("shows a run's monitor, activity and report, and saves the report through the extension", () => {
		render(<BoardViewer transport={transport} />);
		send({ ...data, focus: { run: "release-1" } });
		fireEvent.click(screen.getByRole("tab", { name: "Run monitor" }));
		expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
		expect(screen.getByText("×2")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
		expect(screen.getAllByText("publish refused").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("tab", { name: "Report" }));
		expect(screen.getByText(/# Run release-1: failed/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save…" }));
		expect(posted.at(-1)).toMatchObject({
			type: "boardViewer/saveReport",
			name: "release-1",
		});
	});

	it("keeps what the person picked across a refresh, and opens a pipeline's file", () => {
		render(<BoardViewer transport={transport} />);
		send(data);
		fireEvent.click(
			screen
				.getAllByRole("button", { name: /release/ })
				.find((button) => button.textContent?.includes("approved"))!,
		);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"release",
		);
		send(data);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"release",
		);
		fireEvent.click(screen.getByRole("tab", { name: "Definition" }));
		fireEvent.click(screen.getByRole("button", { name: "Open file" }));
		expect(posted.at(-1)).toEqual({
			type: "boardViewer/openFile",
			path: "/home/me/game/.cerebriline/pipelines/release.pipeline.json",
		});
	});

	it("edits a pipeline as a draft, checked by the extension, and saves it from the version it started at", async () => {
		render(<BoardViewer transport={transport} />);
		send({ ...data, focus: { pipeline: "release" } });
		expect(screen.getByText(/approved/, { selector: ".bv-chip" })).toBeTruthy();
		fireEvent.click(screen.getByText("palette command"));
		expect(screen.getByText("card command")).toBeTruthy();
		expect(screen.getByText("unsaved edit")).toBeTruthy();
		const save = () =>
			screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
		// Not before the extension has checked it.
		expect(save().disabled).toBe(true);
		await waitFor(() => expect(sentOf("boardViewer/validate")).toHaveLength(1));
		answer("boardViewer/validate", {
			ok: false,
			errors: ['node "command" runs after nothing it can reach'],
		});
		// The reply settles a promise: the bar shows it a tick later.
		expect(
			await screen.findByText('node "command" runs after nothing it can reach'),
		).toBeTruthy();
		expect(save().disabled).toBe(true);
		// The new node is picked: its JSON is in the inspector, and a change goes to the draft.
		// It opens as a form; the JSON is one tab away.
		fireEvent.click(await screen.findByRole("tab", { name: "JSON" }));
		await waitFor(() =>
			expect(
				screen.getByRole("textbox", { name: "command as JSON" }),
			).toBeTruthy(),
		);
		fireEvent.change(screen.getByRole("textbox", { name: "command as JSON" }), {
			target: {
				value: JSON.stringify({
					id: "notify",
					type: "command",
					command: "echo done",
					after: ["ship"],
				}),
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("card notify")).toBeTruthy();
		await waitFor(() => expect(sentOf("boardViewer/validate")).toHaveLength(2));
		answer("boardViewer/validate", { ok: true, errors: [] });
		await waitFor(() => expect(save().disabled).toBe(false));
		fireEvent.click(save());
		expect(sentOf("boardViewer/save").at(-1)).toMatchObject({
			slug: "release",
			base: "abc123",
			definition: {
				nodes: [
					{ id: "build" },
					{ id: "ship" },
					{ id: "notify", after: ["ship"] },
				],
			},
		});
		answer("boardViewer/save", { ok: true });
		await waitFor(() =>
			expect(screen.getByText("Saved and approved.")).toBeTruthy(),
		);
		expect(screen.queryByText("unsaved edit")).toBeNull();
	});

	it("shows a proposal against the approved version, and approves or rejects it for that version", async () => {
		const proposal = {
			...data.pipelines[0],
			hash: "def456",
			text: '{\n\t"name": "release",\n\t"step": "new"\n}\n',
			isApproved: false,
			approved: { hash: "abc123", by: "user", at: "2026-11-26T10:00:00.000Z" },
			author: "model",
			approvedText: '{\n\t"name": "release",\n\t"step": "old"\n}\n',
			versions: [
				{
					hash: "def456",
					by: "model",
					at: "2026-11-26T11:00:00.000Z",
					base: "abc123",
				},
				{ hash: "abc123", by: "person", at: "2026-11-26T10:00:00.000Z" },
			],
		};
		render(<BoardViewer transport={transport} />);
		send({ ...data, pipelines: [proposal], focus: { pipeline: "release" } });
		expect(
			screen.getByText(
				/Version def456 by the model, against the approved abc123/,
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Changes" }));
		expect(
			screen.getByText(/"step": "old"/, {
				selector: '.bv-diff-line[data-kind="del"]',
			}),
		).toBeTruthy();
		expect(
			screen.getByText(/"step": "new"/, {
				selector: '.bv-diff-line[data-kind="add"]',
			}),
		).toBeTruthy();
		expect(screen.getByText("the model", { selector: "td" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		expect(sentOf("boardViewer/approve").at(-1)).toMatchObject({
			slug: "release",
			hash: "def456",
		});
		answer("boardViewer/approve", {
			ok: false,
			errors: [
				"The file changed to version 0001 while you looked: read it again first.",
			],
		});
		await waitFor(() =>
			expect(screen.getByText(/read it again first/)).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(sentOf("boardViewer/reject").at(-1)).toMatchObject({
			slug: "release",
			hash: "def456",
		});
	});

	it("saves the board as a pipeline, and changes a task from the inspector", async () => {
		render(<BoardViewer transport={transport} />);
		send(data);
		fireEvent.click(screen.getByRole("button", { name: "Save as a pipeline" }));
		expect(sentOf("boardViewer/boardToPipeline").at(-1)).toMatchObject({
			tasks: [
				{
					id: "t1",
					title: "Run the release pipeline",
					acceptance: ["tests pass"],
					depends: [],
				},
			],
		});
		fireEvent.click(screen.getByText("card t1"));
		// A run holds this task: its status is the run's, not a button's.
		expect(
			screen.getByText(
				"A pipeline run holds this task: its status is the run's.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
		fireEvent.change(
			screen.getByRole("textbox", { name: "New acceptance item" }),
			{ target: { value: "docs updated" } },
		);
		fireEvent.click(
			screen.getAllByRole("button", { name: "Add" })[0] as HTMLElement,
		);
		expect(sentOf("boardViewer/editTask").at(-1)).toMatchObject({
			updates: [{ id: "t1", acceptance_add: ["docs updated"] }],
		});
		answer("boardViewer/editTask", {
			ok: true,
			lines: ["T1: acceptance item added."],
		});
		await waitFor(() =>
			expect(screen.getByText("T1: acceptance item added.")).toBeTruthy(),
		);
	});

	it("retries, skips or re-runs a run's node, and stops a run that is going", async () => {
		render(<BoardViewer transport={transport} />);
		send({ ...data, focus: { run: "release-1" } });
		fireEvent.click(screen.getByText("card ship"));
		const inspector = () =>
			screen.getByRole("complementary", { name: "Inspector" });
		expect(inspector().textContent).toContain("Retry runs ship again");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(sentOf("boardViewer/runAction").at(-1)).toMatchObject({
			op: "retry",
			run: "release-1",
			node: "ship",
		});
		answer("boardViewer/runAction", {
			ok: true,
			lines: ["Retrying ship: release-1 resumed."],
			run: "release-1",
		});
		expect(
			await screen.findByText("Retrying ship: release-1 resumed."),
		).toBeTruthy();

		// A node that finished is re-run from, not retried; the new run is shown once it is read.
		fireEvent.click(screen.getByText("card build"));
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Re-run from here" }));
		expect(sentOf("boardViewer/runAction").at(-1)).toMatchObject({
			op: "rerun",
			run: "release-1",
			node: "build",
		});
		answer("boardViewer/runAction", {
			ok: true,
			lines: ["Re-running release-1 from build as release-2."],
			run: "release-2",
		});
		await screen.findByText("Re-running release-1 from build as release-2.");
		const second = {
			...data.runs[0],
			id: "release-2",
			status: "running",
			from: "release-1",
		};
		send({ ...data, runs: [second, data.runs[0]] });
		await waitFor(() =>
			expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
				"Run release-2",
			),
		);

		// While it runs, the only action is Stop.
		fireEvent.click(screen.getByText("card build"));
		expect(
			screen.queryByRole("button", { name: "Re-run from here" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
		expect(sentOf("boardViewer/runAction").at(-1)).toEqual(
			expect.objectContaining({ op: "stop", run: "release-2" }),
		);
		expect(sentOf("boardViewer/runAction").at(-1)).not.toHaveProperty("node");
	});

	it("offers no Skip for a node that picks an output", () => {
		const branch = {
			...data.pipelines[0],
			definition: {
				name: "release",
				nodes: [{ id: "gate", type: "if", when: "{{ true }}" }],
			},
		};
		const run = {
			...data.runs[0],
			definition: branch.definition,
			nodes: {
				gate: { status: "failed", attempts: 1, error: "bad expression" },
			},
		};
		render(<BoardViewer transport={transport} />);
		send({
			...data,
			pipelines: [branch],
			runs: [run],
			focus: { run: "release-1" },
		});
		fireEvent.click(screen.getByText("card gate"));
		expect(
			(screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			screen.getByRole("complementary", { name: "Inspector" }).textContent,
		).toContain("so it is not skipped");
	});

	it("gives a task a pipeline it is done by, and shows it as used, not waited on", async () => {
		const board = JSON.parse(data.boardText) as {
			tasks: Record<string, unknown>[];
		};
		const task = {
			...board.tasks[0],
			claimedBy: undefined,
			gates: [{ spec: "use-pipeline:release", open: false }],
		};
		render(<BoardViewer transport={transport} />);
		send({ ...data, boardText: JSON.stringify({ ...board, tasks: [task] }) });
		fireEvent.click(screen.getByText("card t1"));
		const inspector = screen.getByRole("complementary", { name: "Inspector" });
		expect(inspector.textContent).toContain(
			"pipeline release, run when the task starts",
		);
		expect(screen.getByText("uses")).toBeTruthy();
		fireEvent.change(
			screen.getByRole("combobox", { name: "Pipeline the task is done by" }),
			{
				target: { value: "release" },
			},
		);
		fireEvent.click(screen.getByRole("button", { name: "Use pipeline" }));
		await waitFor(() =>
			expect(sentOf("boardViewer/editTask").at(-1)).toMatchObject({
				updates: [{ id: "t1", gate: ["use-pipeline:release"] }],
			}),
		);
	});

	it("builds a draft board with no conversation open, and hands it to the next one", async () => {
		const empty = {
			workspace: "/home/me/game",
			pipelines: [],
			runs: [],
			boardDraft: true,
		};
		render(<BoardViewer transport={transport} />);
		send(empty);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Draft board",
		);
		expect(screen.getByText("An empty draft board")).toBeTruthy();
		const start = () =>
			screen.getByRole("button", {
				name: "Start a conversation with this board",
			}) as HTMLButtonElement;
		expect(start().disabled).toBe(true);
		fireEvent.change(screen.getByRole("textbox", { name: "New task" }), {
			target: { value: "Write the README" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add task" }));
		expect(sentOf("boardViewer/addTask").at(-1)).toMatchObject({
			title: "Write the README",
		});
		answer("boardViewer/addTask", { ok: true, lines: ["Created 1: T1."] });
		await waitFor(() =>
			expect(
				(screen.getByRole("textbox", { name: "New task" }) as HTMLInputElement)
					.value,
			).toBe(""),
		);

		const draftBoard = JSON.parse(data.boardText) as {
			tasks: Record<string, unknown>[];
		};
		send({
			...empty,
			boardText: JSON.stringify({
				...draftBoard,
				tasks: [{ ...draftBoard.tasks[0], claimedBy: undefined }],
			}),
		});
		expect(
			screen.getByText("for your next conversation", { exact: false }),
		).toBeTruthy();
		expect(start().disabled).toBe(false);
		fireEvent.click(start());
		expect(sentOf("boardViewer/startFromDraft")).toHaveLength(1);
		answer("boardViewer/startFromDraft", {
			ok: true,
			lines: [
				"Send your first message in the chat: the new conversation starts from this board.",
			],
		});
		expect(
			await screen.findByText(/the new conversation starts from this board/),
		).toBeTruthy();
	});

	// The owner, 2026-11-27: a selection of the active board, the drafts, the
	// earlier conversations' and the ones in Memory; copy between them.
	it("lists the boards, shows the one picked, and edits, copies, saves or deletes the one shown", async () => {
		const row = (title: string) =>
			JSON.stringify({
				layers: [["T1"]],
				tasks: [
					{
						id: "T1",
						title,
						status: "pending",
						priority: "M",
						depends: [],
						openDepends: [],
						acceptance: [],
						later: false,
						files: [],
						notes: [],
						ready: true,
						blocked: false,
					},
				],
			});
		render(<BoardViewer transport={transport} />);
		send({
			...data,
			boards: [
				{
					key: "live",
					kind: "conversation",
					label: "This conversation",
					text: data.boardText,
					tasks: 1,
					open: 1,
					editable: true,
				},
				{
					key: "draft:1",
					kind: "draft",
					label: "Draft 1",
					tasks: 0,
					open: 0,
					editable: true,
				},
				{
					key: "draft:2",
					kind: "draft",
					label: "Draft 2",
					text: row("Draft work"),
					tasks: 1,
					open: 1,
					editable: true,
				},
				{
					key: "draft:3",
					kind: "draft",
					label: "Draft 3",
					tasks: 0,
					open: 0,
					editable: true,
				},
				{
					key: "recent:s-old",
					kind: "recent",
					label: "Fix the game",
					text: row("Earlier work"),
					tasks: 1,
					open: 0,
					editable: false,
					readOnly:
						"An earlier conversation's board: copy it here or to a draft to change it.",
				},
				{
					key: "saved:main/m1",
					kind: "saved",
					label: "Release",
					detail: 'm1 in "main", saved 2026-11-20',
					text: row("Saved work"),
					tasks: 1,
					open: 1,
					editable: false,
					readOnly: "Saved in Memory: copy it here or to a draft to change it.",
				},
			],
		});
		const rail = screen.getByRole("navigation", {
			name: "Boards, pipelines and runs",
		});
		for (const group of [
			"Conversation",
			"Drafts",
			"Recent conversations",
			"Saved in Memory",
		]) {
			expect(rail.textContent).toContain(group);
		}
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Conversation board",
		);

		// A draft: its board, and edits go to it.
		fireEvent.click(screen.getByRole("button", { name: /Draft 2/ }));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"Draft 2",
		);
		fireEvent.change(screen.getByRole("textbox", { name: "New task" }), {
			target: { value: "More" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add task" }));
		expect(sentOf("boardViewer/addTask").at(-1)).toMatchObject({
			title: "More",
			board: "draft:2",
		});
		answer("boardViewer/addTask", { ok: true, lines: [] });
		const save = () =>
			screen.getByRole("button", {
				name: "Save to Memory",
			}) as HTMLButtonElement;
		await waitFor(() => expect(save().disabled).toBe(false));
		fireEvent.click(save());
		expect(sentOf("boardViewer/saveBoardToMemory").at(-1)).toMatchObject({
			board: "draft:2",
		});
		answer("boardViewer/saveBoardToMemory", {
			ok: true,
			lines: ["Saved the board as m2."],
		});
		await waitFor(() => expect(save().disabled).toBe(false));

		// An earlier conversation's: viewed, not changed; copied to this conversation.
		fireEvent.click(screen.getByRole("button", { name: /Fix the game/ }));
		expect(screen.queryByRole("textbox", { name: "New task" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Load…" })).toBeNull();
		expect(
			screen.getByText(/copy it here or to a draft to change it/),
		).toBeTruthy();
		const copy = screen.getByRole("combobox", {
			name: "Copy to",
		}) as HTMLSelectElement;
		await waitFor(() => expect(copy.disabled).toBe(false));
		expect([...copy.options].map((option) => option.textContent)).toEqual([
			"Copy to…",
			"This conversation",
			"Draft 1",
			"Draft 2",
			"Draft 3",
		]);
		fireEvent.change(copy, { target: { value: "live" } });
		expect(sentOf("boardViewer/copyBoard").at(-1)).toMatchObject({
			from: "recent:s-old",
			to: "live",
		});
		answer("boardViewer/copyBoard", { ok: true, lines: ["Copied 1 task."] });
		// Copied: the board copied to is shown.
		await waitFor(() =>
			expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
				"Conversation board",
			),
		);
		// The reply closes with its ×: it took half the tab on a long copy.
		await waitFor(() =>
			expect(screen.getByText("Copied 1 task.")).toBeTruthy(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByText("Copied 1 task.")).toBeNull();

		// One saved in Memory: deleted, not saved again.
		fireEvent.click(screen.getByRole("button", { name: /Release/ }));
		expect(screen.queryByRole("button", { name: "Save to Memory" })).toBeNull();
		const remove = screen.getByRole("button", {
			name: "Delete",
		}) as HTMLButtonElement;
		await waitFor(() => expect(remove.disabled).toBe(false));
		fireEvent.click(remove);
		expect(sentOf("boardViewer/deleteSavedBoard").at(-1)).toMatchObject({
			board: "saved:main/m1",
		});
	});

	// The owner, 2026-11-27: "the model can do things that I can't on the board".
	it("does on a task what the model can: status, priority, order, steps, gates, delete; and loads and exports the board", async () => {
		const base = JSON.parse(data.boardText) as {
			tasks: Record<string, unknown>[];
		};
		const free = { ...base.tasks[0], claimedBy: undefined, status: "pending" };
		const after = {
			...free,
			id: "t2",
			title: "Ship it",
			priority: "M",
			depends: ["t1"],
			openDepends: ["t1"],
			gates: [{ spec: "human:Go ahead?", open: false }],
		};
		const third = {
			...free,
			id: "t3",
			title: "Tell people",
			depends: [],
			openDepends: [],
		};
		render(<BoardViewer transport={transport} />);
		send({
			...data,
			boardText: JSON.stringify({ ...base, tasks: [free, after, third] }),
		});
		fireEvent.click(screen.getByText("card t2"));
		const edits = () =>
			sentOf("boardViewer/editTask").map(
				(message) => (message as { updates: unknown[] }).updates[0],
			);

		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), {
			target: { value: "L" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "t2 no longer waits on t1" }),
		);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Task it waits for" }),
			{ target: { value: "t3 · Tell people" } },
		);
		fireEvent.click(
			screen.getAllByRole("button", { name: "Add" })[0] as HTMLElement,
		);
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(edits()).toEqual([
			{ id: "t2", status: "active" },
			{ id: "t2", priority: "L" },
			{ id: "t2", depends_remove: ["t1"] },
			{ id: "t2", depends: ["t3"] },
			{ id: "t2", gate_open: ["human:Go ahead?"] },
		]);
		// The gate field offers what a gate can wait on.
		const gate = screen.getByRole("combobox", {
			name: "New gate",
		}) as HTMLInputElement;
		const offered = [
			...(document
				.getElementById(gate.getAttribute("list") ?? "")
				?.querySelectorAll("option") ?? []),
		];
		expect(offered.map((option) => option.value)).toContain("human:");

		fireEvent.change(screen.getByRole("textbox", { name: "New step" }), {
			target: { value: "Write the notes" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add step" }));
		expect(sentOf("boardViewer/addTask").at(-1)).toMatchObject({
			title: "Write the notes",
			parent: "t2",
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(sentOf("boardViewer/deleteTask").at(-1)).toMatchObject({
			task: "t2",
		});

		// On the canvas: a drag makes a dependency, a deleted edge drops one.
		fireEvent.click(screen.getByText("connect first to last"));
		fireEvent.click(screen.getByText("delete edge t1->t2"));
		expect(edits().slice(-2)).toEqual([
			{ id: "t3", depends: ["t1"] },
			{ id: "t2", depends_remove: ["t1"] },
		]);

		// The requests above are answered: the bar is free again.
		for (const message of posted) {
			const id = (message as { id?: number }).id;
			if (id === undefined) continue;
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "boardViewer/reply", id, ok: true, lines: [] },
					}),
				);
			});
		}
		const load = () =>
			screen.getByRole("button", { name: "Load…" }) as HTMLButtonElement;
		await waitFor(() => expect(load().disabled).toBe(false));
		fireEvent.click(load());
		answer("boardViewer/loadBoard", { ok: false });
		await waitFor(() => expect(load().disabled).toBe(false));
		fireEvent.click(screen.getByRole("button", { name: "Export…" }));
		expect(sentOf("boardViewer/loadBoard")).toHaveLength(1);
		expect(sentOf("boardViewer/exportBoard")).toHaveLength(1);
	});

	it("makes a new pipeline and opens it", async () => {
		render(<BoardViewer transport={transport} />);
		send(data);
		fireEvent.click(screen.getByRole("button", { name: "+ New" }));
		expect(sentOf("boardViewer/newPipeline")).toHaveLength(1);
		answer("boardViewer/newPipeline", {
			ok: true,
			lines: ["Saved Deploy."],
			pipeline: "deploy",
		});
		await screen.findByText("Saved Deploy.");
		const deploy = {
			...data.pipelines[0],
			name: "Deploy",
			slug: "deploy",
			path: "/home/me/game/.cerebriline/pipelines/deploy.pipeline.json",
			definition: {
				name: "Deploy",
				nodes: [{ id: "start", type: "set", fields: {} }],
			},
		};
		send({ ...data, pipelines: [...data.pipelines, deploy] });
		await waitFor(() =>
			expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
				"Deploy",
			),
		);
	});
});
