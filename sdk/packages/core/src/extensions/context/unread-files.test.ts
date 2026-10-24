import { describe, expect, it } from "vitest";
import {
	carrySeenFiles,
	dropUnreadLines,
	filesIn,
	seenFiles,
	unreadNote,
} from "./unread-files";

// Fixtures from claude-hooks tests/test_compaction_flows.py (209185b), in
// this repository's message shapes.

const listing = (directory: string, names: string[], id = "ls") => [
	{
		role: "assistant",
		content: [
			{ type: "tool_use", id, name: "list_files", input: { path: directory } },
		],
	},
	{
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: id,
				content: names.map((name) => `${directory}/${name}`).join("\n"),
			},
		],
	},
];

const read = (paths: string[]) =>
	paths.flatMap((path, at) => [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: `k${at}`,
					name: "read_files",
					input: { files: [{ path }] },
				},
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: `k${at}`, content: "line 1" },
			],
		},
	]);

/** The shape of compaction-v7-cite's first fold. */
const TABLE = [
	"Let me read the admin modules. [#1]",
	"",
	"Module table so far:",
	"*   `src/admin/keeper.py`: `weight`, `spill_target`",
	"*   `src/admin/registry.py`: `hold_epoch`, `retention_class`",
	"*   `src/admin/slot.py`: `lineage`, `fence_token`",
	"| `admin/slot.py` | `codec` | `owner_shard` |",
	"The fix is in `src/admin/keeper.py`, unlike `src/admin/slot.py`.",
	"```",
	"src/admin/slot.py: kept, it is code",
	"```",
	"The task excludes `config/limits.py`.",
].join("\n");

describe("unread files", () => {
	it("counts what a call showed as seen, never what a listing named", () => {
		const messages = [
			...listing("src/admin", ["keeper.py", "registry.py", "slot.py"]),
			...read(["src/admin/keeper.py"]),
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "g",
						name: "search_codebase",
						input: { query: "out\\[" },
					},
					{
						type: "tool_use",
						id: "r",
						name: "run_commands",
						input: { commands: ["cat src/x/y.py"] },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "g",
						content: [
							{
								type: "text",
								text: 'src/admin/registry.py:12:    out["lineage"] = v',
							},
						],
					},
					{ type: "tool_result", tool_use_id: "r", content: "def f(): ..." },
				],
			},
		];
		expect([...seenFiles(messages)].sort()).toEqual([
			"src/admin/keeper.py",
			"src/admin/registry.py",
			"src/x/y.py",
		]);
	});

	it("reads paths, not dotted names", () => {
		expect(
			filesIn("*   `src/admin/bucket_keeper.py`: `weight`, `spill_target`"),
		).toEqual(["src/admin/bucket_keeper.py"]);
		expect(
			filesIn(
				"os.path.join, self.store.ack, limits.RETRY_WINDOW * 100, e.g. 1.5 s, https://x.org/a.py",
			),
		).toEqual([]);
		expect(filesIn("net/backoff.py:148 and http.py")).toEqual([
			"net/backoff.py",
			"http.py",
		]);
	});

	it("cuts the lines about only unread files and keeps their names", () => {
		const seen = new Set(["src/admin/keeper.py"]);
		const result = dropUnreadLines(
			TABLE,
			seen,
			"every module except `config/limits.py`",
		);
		expect(result.cut).toBe(3);
		expect(result.names).toEqual([
			"src/admin/registry.py",
			"src/admin/slot.py",
			"admin/slot.py",
		]);
		expect(result.text).toContain("`src/admin/keeper.py`: `weight`");
		expect(result.text).not.toContain("hold_epoch");
		expect(result.text).not.toContain("fence_token");
		expect(result.text).not.toContain("`codec`");
		// A line about a read file that names an unread one stays.
		expect(result.text).toContain("The fix is in `src/admin/keeper.py`");
		// Fenced code is left alone.
		expect(result.text).toContain("src/admin/slot.py: kept, it is code");
		// A file the user's requests name is never cut.
		expect(result.text).toContain("The task excludes `config/limits.py`.");
		// A suffix of a seen path is the seen file.
		expect(dropUnreadLines("`admin/keeper.py`: x", seen).cut).toBe(0);
	});

	it("leaves the names, never the claims, and carries the newest seen files", () => {
		expect(unreadNote(["a.py", "b/c.ts"], 2)).toBe(
			"Not yet read (2 lines about these files were removed from this summary: no call in the record opened them, so what the lines said about them was not read from the files): `a.py`, `b/c.ts`.",
		);
		expect(carrySeenFiles(["x.py"], new Set(["b.py", "a.py", "x.py"]))).toEqual(
			["x.py", "a.py", "b.py"],
		);
	});
});
