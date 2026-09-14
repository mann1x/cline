import { describe, expect, it } from "vitest";
import { textOf } from "./a2a";
import { createExpertNotes, withExpertNotes } from "./expert-notes";

function notes(intervalMs = 30_000) {
	let clock = 0;
	const feed = createExpertNotes({
		intervalMs,
		now: () => clock,
	});
	return {
		feed,
		tick: (ms: number) => {
			clock += ms;
		},
		at: () => clock,
	};
}

describe("createExpertNotes", () => {
	it("holds tool notes until the interval has passed", () => {
		const { feed, tick } = notes();

		feed.noteTool({ tool: "read_files" });
		expect(feed.due()).toBe(false);
		expect(feed.take()).toBeUndefined();

		tick(29_000);
		expect(feed.due()).toBe(false);

		tick(1_000);
		expect(feed.due()).toBe(true);
		const batch = feed.take();
		expect(batch).toBeDefined();
		expect(textOf(batch?.parts ?? [])).toContain("read_files");
	});

	it("releases at once when the expert speaks, without waiting for the clock", () => {
		const { feed } = notes();

		feed.noteTool({ tool: "editor", files: [{ path: "a.html", revision: 2 }] });
		expect(feed.due()).toBe(false);

		feed.noteMessage("I fixed the bracket on line 90.");
		expect(feed.due()).toBe(true);
	});

	it("releases at once on a guard trip", () => {
		const { feed } = notes();
		feed.noteTool({ tool: "read_files" });
		feed.noteGuard(
			"The expert has read the same file six times without editing.",
		);
		expect(feed.due()).toBe(true);
	});

	it("carries everything that accumulated while the base was busy", () => {
		const { feed, tick } = notes();

		feed.noteTool({ tool: "read_files" });
		tick(30_000);
		feed.take();

		// The base is away reviewing. Three more things happen.
		feed.noteTool({ tool: "editor", files: [{ path: "a.html", revision: 3 }] });
		feed.noteTool({ tool: "editor", files: [{ path: "a.html", revision: 4 }] });
		feed.noteTool({ tool: "run_shell" });
		tick(30_000);

		const batch = feed.take();
		const text = textOf(batch?.parts ?? []);
		expect(text).toContain("editor");
		expect(text).toContain("run_shell");
		expect(batch?.notes).toHaveLength(3);
	});

	it("collapses a repeated tool into one line with a count", () => {
		const { feed, tick } = notes();
		for (let i = 0; i < 4; i += 1) {
			feed.noteTool({ tool: "read_files" });
		}
		tick(30_000);
		const text = textOf(feed.take()?.parts ?? []);
		expect(text).toMatch(/read_files.*4/);
	});

	it("names the revision a changed file can be read at", () => {
		const { feed, tick } = notes();
		feed.noteTool({
			tool: "editor",
			files: [{ path: "manic_miner.html", revision: 7 }],
		});
		tick(30_000);
		const batch = feed.take();
		expect(textOf(batch?.parts ?? [])).toContain("manic_miner.html");
		expect(textOf(batch?.parts ?? [])).toContain("#7");
		const data = batch?.parts.find((part) => part.kind === "data");
		expect(data).toBeDefined();
		expect(JSON.stringify(data)).toContain("manic_miner.html");
	});

	it("is due the moment the task reaches a terminal state, and says so", () => {
		const { feed } = notes();
		feed.noteTool({ tool: "editor", files: [{ path: "a.html", revision: 2 }] });
		feed.setState("completed");
		expect(feed.due()).toBe(true);
		const batch = feed.take();
		expect(batch?.state).toBe("completed");
		expect(batch?.final).toBe(true);
	});

	it("still reports a terminal state when nothing else is pending", () => {
		const { feed, tick } = notes();
		tick(30_000);
		expect(feed.take()).toBeUndefined();
		feed.setState("failed");
		expect(feed.take()?.final).toBe(true);
	});

	it("does not repeat a batch it has already handed over", () => {
		const { feed, tick } = notes();
		feed.noteTool({ tool: "read_files" });
		tick(30_000);
		expect(feed.take()).toBeDefined();
		expect(feed.take()).toBeUndefined();
		expect(feed.due()).toBe(false);
	});

	it("restarts the clock from the hand-over, not from the last note", () => {
		const { feed, tick } = notes();
		feed.noteTool({ tool: "read_files" });
		tick(30_000);
		feed.take();

		feed.noteTool({ tool: "read_files" });
		tick(20_000);
		expect(feed.due()).toBe(false);
		tick(10_000);
		expect(feed.due()).toBe(true);
	});
});

describe("taking notes from the expert's own tool calls", () => {
	const context = {} as never;

	function tool(name: string, run: () => unknown = () => "ok") {
		return {
			name,
			description: name,
			inputSchema: { type: "object", properties: {} },
			execute: async (_input: unknown, _context: unknown) => run(),
		};
	}

	function heads(entries: Record<string, number>) {
		return () => new Map(Object.entries(entries));
	}

	it("names the tool, and nothing else when it wrote nothing", async () => {
		const notes = createExpertNotes();
		const held: Record<string, number> = {};
		const [read] = withExpertNotes([tool("read_files")], {
			notes,
			heads: () => new Map(Object.entries(held)),
		});

		await read.execute?.({} as never, context);

		expect(notes.pending).toBe(1);
	});

	it("carries the revision a call wrote, so the note can be checked", async () => {
		const notes = createExpertNotes();
		const held: Record<string, number> = { "/ws/game.html": 1 };
		const [editor] = withExpertNotes(
			[
				tool("editor", () => {
					held["/ws/game.html"] = 2;
					return "edited";
				}),
			],
			{
				notes,
				heads: () => new Map(Object.entries(held)),
				relative: (path) => path.replace("/ws/", ""),
			},
		);
		notes.setState("completed");

		await editor.execute?.({} as never, context);
		const batch = notes.take();

		expect(batch?.notes[0]?.files).toEqual([
			{ path: "game.html", revision: 2 },
		]);
	});

	it("records a file the call created", async () => {
		const notes = createExpertNotes();
		const held: Record<string, number> = {};
		const [editor] = withExpertNotes(
			[
				tool("editor", () => {
					held["/ws/new.html"] = 2;
					return "created";
				}),
			],
			{ notes, heads: () => new Map(Object.entries(held)) },
		);
		notes.setState("completed");

		await editor.execute?.({} as never, context);

		expect(notes.take()?.notes[0]?.files).toEqual([
			{ path: "/ws/new.html", revision: 2 },
		]);
	});

	it("notes a thrown tool, and lets the throw through", async () => {
		const notes = createExpertNotes();
		const [broken] = withExpertNotes(
			[
				tool("run_commands", () => {
					throw new Error("no such file");
				}),
			],
			{ notes, heads: heads({}) },
		);
		notes.setState("completed");

		await expect(broken.execute?.({} as never, context)).rejects.toThrow(
			"no such file",
		);
		expect(notes.take()?.notes[0]?.error).toBe("no such file");
	});

	it("leaves a file nothing touched out of the note", async () => {
		const notes = createExpertNotes();
		const [read] = withExpertNotes([tool("read_files")], {
			notes,
			heads: heads({ "/ws/a.html": 3 }),
		});
		notes.setState("completed");

		await read.execute?.({} as never, context);

		expect(notes.take()?.notes[0]?.files).toEqual([]);
	});
});
