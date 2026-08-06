import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

async function withTempFile(
	content: string,
	run: (filePath: string, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
	const filePath = path.join(dir, "example.txt");
	await fs.writeFile(filePath, content, "utf-8");
	try {
		await run(filePath, dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("createEditorExecutor", () => {
	it("creates a missing file when edit is used", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");

		try {
			const editor = createEditorExecutor();
			const result = await editor(
				{
					path: filePath,
					new_text: "created with edit",
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			expect(result).toBe(`File created successfully at: ${filePath}`);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"created with edit",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("inserts before a one-based line and appends at the EOF boundary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");
		await fs.writeFile(filePath, "one\ntwo", "utf-8");

		try {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					new_text: "inserted",
					insert_line: 2,
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\ninserted\ntwo",
			);

			await editor(
				{
					path: filePath,
					new_text: "tail",
					insert_line: 4,
				},
				dir,
				{
					agentId: "agent-1",
					conversationId: "conv-1",
					iteration: 1,
				},
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\ninserted\ntwo\ntail",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("emits a minimal diff for an in-place single-line edit", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "b", new_text: "B" },
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n+2: B\n\`\`\``,
			);
		});
	});

	it("only emits the changed region when the edit changes the line count", async () => {
		await withTempFile("a\nb\nc\nd\ne\nf", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "b\nc\nd", new_text: "B" },
				dir,
				context,
			);

			// The trailing unchanged lines (e, f) must not be mispaired into
			// the diff even though their positions shifted.
			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n-3: c\n-4: d\n+2: B\n\`\`\``,
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB\ne\nf");
		});
	});

	it("emits only additions for a pure insertion via str_replace", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, old_text: "a\nb", new_text: "a\nnew\nb" },
				dir,
				context,
			);

			expect(result).toBe(`Edited ${filePath}\n\`\`\`diff\n+2: new\n\`\`\``);
		});
	});

	it("truncates long diffs at maxDiffLines while keeping both sides visible", async () => {
		const oldLines = Array.from({ length: 10 }, (_, i) => `old-${i}`);
		await withTempFile(oldLines.join("\n"), async (filePath, dir) => {
			const editor = createEditorExecutor({ maxDiffLines: 3 });
			const result = await editor(
				{
					path: filePath,
					old_text: oldLines.join("\n"),
					new_text: "replaced",
				},
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-1: old-0\n-2: old-1\n+1: replaced\n... diff truncated (8 more removed, 0 more added lines) ...\n\`\`\``,
			);
		});
	});

	it("does not drop additions when removals alone exhaust maxDiffLines", async () => {
		const oldLines = Array.from({ length: 6 }, (_, i) => `old-${i}`);
		const newLines = Array.from({ length: 4 }, (_, i) => `new-${i}`);
		await withTempFile(oldLines.join("\n"), async (filePath, dir) => {
			const editor = createEditorExecutor({ maxDiffLines: 6 });
			const result = await editor(
				{
					path: filePath,
					old_text: oldLines.join("\n"),
					new_text: newLines.join("\n"),
				},
				dir,
				context,
			);

			// Budget splits 3/3 instead of removals consuming all 6 lines and
			// reporting +0 additions.
			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-1: old-0\n-2: old-1\n-3: old-2\n+1: new-0\n+2: new-1\n+3: new-2\n... diff truncated (3 more removed, 1 more added lines) ...\n\`\`\``,
			);
		});
	});

	it("preserves CRLF line endings when inserting LF-only text into a CRLF file", async () => {
		await withTempFile("one\r\ntwo\r\nthree", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					new_text: "first\nsecond",
					insert_line: 2,
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"one\r\nfirst\r\nsecond\r\ntwo\r\nthree",
			);
		});
	});

	it("replaces multi-line LF old_text in a CRLF file and keeps CRLF endings", async () => {
		await withTempFile("a\r\nb\r\nc\r\nd", async (filePath, dir) => {
			const editor = createEditorExecutor();
			// Reads strip "\r", so the model round-trips LF-only text even
			// though the file on disk is CRLF.
			const result = await editor(
				{ path: filePath, old_text: "b\nc", new_text: "B\nC\nX" },
				dir,
				context,
			);

			expect(result).toBe(
				`Edited ${filePath}\n\`\`\`diff\n-2: b\n-3: c\n+2: B\n+3: C\n+4: X\n\`\`\``,
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"a\r\nB\r\nC\r\nX\r\nd",
			);
		});
	});

	it("replaces text in a pure-LF file without introducing CRLF", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{ path: filePath, old_text: "b\nc", new_text: "B\r\nC" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB\nC");
		});
	});

	it("inserts $-sequences in new_text literally", async () => {
		await withTempFile("a\nb\nc", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					old_text: "b",
					new_text: "cost=$100 pid=$$ match=$& rest=$'",
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"a\ncost=$100 pid=$$ match=$& rest=$'\nc",
			);
		});
	});

	it("rejects insert_line 0 with the valid one-based boundary range", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		const filePath = path.join(dir, "example.txt");
		await fs.writeFile(filePath, "one\ntwo", "utf-8");

		try {
			const editor = createEditorExecutor();

			await expect(
				editor(
					{
						path: filePath,
						new_text: "invalid",
						insert_line: 0,
					},
					dir,
					{
						agentId: "agent-1",
						conversationId: "conv-1",
						iteration: 1,
					},
				),
			).rejects.toThrow(
				"Invalid insert_line: 0. insert_line must be a positive one-based boundary line in the range 1-3. Use 3 to append at EOF.",
			);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\ntwo");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	describe("editing by column", () => {
		// Measured: 73 of 95 shell commands in one session were
		// `IndexOf`/`Substring` surgery, hand-rolled because the tool could
		// address a line but never a position inside one.
		const MINIFIED = "a\nd(){x();y();}}\nb";

		it("inserts a single character without touching the rest of the line", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{
						path: filePath,
						insert_line: 2,
						insert_column: 5,
						new_text: "}",
					},
					dir,
					context,
				);

				expect(result).toContain("Inserted 1 character(s) at line 2 column 5");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nd(){}x();y();}}\nb",
				);
			});
		});

		it("appends at the end of a line with line_length + 1", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{
						path: filePath,
						insert_line: 2,
						insert_column: 15,
						new_text: "}",
					},
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nd(){x();y();}}}\nb",
				);
			});
		});

		it("replaces exactly one character when only start_column is given", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, start_line: 2, start_column: 14, new_text: ")" },
					dir,
					context,
				);

				expect(result).toContain("line 2, columns 14-14");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nd(){x();y();})\nb",
				);
			});
		});

		it("replaces an inclusive column range", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{
						path: filePath,
						start_line: 2,
						start_column: 5,
						end_column: 13,
						new_text: "Z",
					},
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nd(){Z}\nb",
				);
			});
		});

		it("spans lines when end_line is past start_line", async () => {
			await withTempFile("keep1 CUT\nCUT keep2", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{
						path: filePath,
						start_line: 1,
						start_column: 7,
						end_line: 2,
						end_column: 3,
						new_text: "-",
					},
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"keep1 - keep2",
				);
			});
		});

		it("says how long the line is when the column is past its end", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{ path: filePath, start_line: 2, start_column: 99, new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow(
					"Line 2 has 14 character(s), so start_column must be between 1 and 14",
				);
			});
		});

		it("points at insert_column when asked to replace an empty range", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{
							path: filePath,
							start_line: 2,
							start_column: 8,
							end_column: 3,
							new_text: "x",
						},
						dir,
						context,
					),
				).rejects.toThrow("use insert_line with insert_column");
			});
		});

		it("rejects a column with no line to be a column of", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{ path: filePath, start_column: 3, new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow("need `start_line`");
			});
		});

		it("fails a column edit that changed nothing", async () => {
			await withTempFile(MINIFIED, async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, start_line: 2, start_column: 14, new_text: "}" },
						dir,
						context,
					),
				).rejects.toThrow("No change");
			});
		});
	});

	describe("replacing a line range", () => {
		// Twelve shell commands in one measured session existed only to do
		// `$lines[91] = "..."`, because there was no tool for it.
		it("replaces one line addressed by number", async () => {
			await withTempFile("one\ntwo\nthree", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "TWO", start_line: 2 },
					dir,
					context,
				);

				expect(result).toContain("Replaced line 2");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"one\nTWO\nthree",
				);
			});
		});

		it("replaces an inclusive range, and with fewer lines than it removed", async () => {
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "X", start_line: 2, end_line: 3 },
					dir,
					context,
				);

				expect(result).toContain("Replaced lines 2-3");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nX\nd");
			});
		});

		it("fails instead of reporting an empty diff", async () => {
			// Measured: 24 of 45 successful editor results carried an empty diff
			// fence. The model read the absence as "already correct", re-sent the
			// edit, then sent six identical inserts at the same line.
			//
			// Saying so in the result text was not enough on its own — a later
			// session sent one identical call twelve times, because the envelope
			// around that text still reported success. It has to fail.
			await withTempFile("one\ntwo\nthree", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const failure = editor(
					{ path: filePath, new_text: "two", start_line: 2 },
					dir,
					context,
				);

				await expect(failure).rejects.toThrow("No change");
				await expect(failure).rejects.toThrow(
					"line 2 already reads exactly this way",
				);
				await expect(failure).rejects.toThrow("character-for-character");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"one\ntwo\nthree",
				);
			});
		});

		it("accounts for lines inside the range that were already identical", async () => {
			// Replacing 2-3 where line 3 was already right shows one line in the
			// diff, which reads like a half-applied edit unless it is said.
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "B\nc", start_line: 2, end_line: 3 },
					dir,
					context,
				);

				expect(result).toContain("Replaced lines 2-3");
				expect(result).toContain("1 of the 2 line(s) in the range");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nB\nc\nd",
				);
			});
		});

		it("fails when old_text and new_text are the same", async () => {
			await withTempFile("alpha beta", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, old_text: "beta", new_text: "beta" },
						dir,
						context,
					),
				).rejects.toThrow("No change");
			});
		});

		it("deletes the range when new_text is empty", async () => {
			await withTempFile("keep\ndrop\nkeep", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{ path: filePath, new_text: "", start_line: 2 },
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"keep\nkeep",
				);
			});
		});

		it("keeps the file's own line endings", async () => {
			await withTempFile("one\r\ntwo\r\nthree", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{ path: filePath, new_text: "TWO\nEXTRA", start_line: 2 },
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"one\r\nTWO\r\nEXTRA\r\nthree",
				);
			});
		});

		it("refuses a range outside the file rather than guessing", async () => {
			await withTempFile("one\ntwo", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, new_text: "x", start_line: 9 },
						dir,
						context,
					),
				).rejects.toThrow("Invalid start_line: 9. The file has 2 line(s)");
				await expect(
					editor(
						{ path: filePath, new_text: "x", start_line: 2, end_line: 1 },
						dir,
						context,
					),
				).rejects.toThrow("Invalid end_line: 1");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\ntwo");
			});
		});

		it("refuses to both insert and replace in one call", async () => {
			await withTempFile("one\ntwo", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, new_text: "x", insert_line: 1, start_line: 1 },
						dir,
						context,
					),
				).rejects.toThrow("Send one or the other");
			});
		});
	});

	describe("choosing among repeated matches", () => {
		it("replaces the occurrence asked for and leaves the others", async () => {
			await withTempFile("x\nsame\ny\nsame\nz\nsame", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{
						path: filePath,
						old_text: "same",
						new_text: "SECOND",
						occurrence: 2,
					},
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"x\nsame\ny\nSECOND\nz\nsame",
				);
			});
		});

		it("replaces every occurrence when asked", async () => {
			await withTempFile("a b a b a", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, old_text: "a", new_text: "Z", replace_all: true },
					dir,
					context,
				);

				expect(result).toContain("3 occurrence(s)");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("Z b Z b Z");
			});
		});

		it("names the lines and the ways out when the match is ambiguous", async () => {
			// The old message said only "multiple occurrences", which left the
			// shell as the only exit.
			await withTempFile("dup\nother\ndup", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, old_text: "dup", new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow(
					/appears 2 times .*on lines 1, 3.*occurrence.*replace_all.*start_line/s,
				);
			});
		});

		it("refuses an occurrence past the end, and refuses both selectors", async () => {
			await withTempFile("dup\ndup", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, old_text: "dup", new_text: "x", occurrence: 5 },
						dir,
						context,
					),
				).rejects.toThrow("occurrence 5 is out of range");
				await expect(
					editor(
						{
							path: filePath,
							old_text: "dup",
							new_text: "x",
							occurrence: 1,
							replace_all: true,
						},
						dir,
						context,
					),
				).rejects.toThrow("Send one or the other");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("dup\ndup");
			});
		});

		it("treats an end_line past the last line as the end of the file", async () => {
			// Measured: a model sent `end_line: 9999` twice as a stand-in for
			// EOF, having no way to learn the line count, and both were
			// rejected. The number can only mean one thing.
			await withTempFile("one\ntwo\nthree", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, start_line: 2, end_line: 9999, new_text: "TWO" },
					dir,
					context,
				);

				expect(result).toContain("Replaced lines 2-3");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("one\nTWO");
			});
		});

		it("replaces a whole file when the range starts at one and runs past the end", async () => {
			await withTempFile("a\nb\nc", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{ path: filePath, start_line: 1, end_line: 9999, new_text: "only" },
					dir,
					context,
				);

				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("only");
			});
		});

		it("still rejects an end_line before start_line", async () => {
			await withTempFile("a\nb\nc", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, start_line: 3, end_line: 1, new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow(/at least start_line/);
			});
		});

		it("names the whole-file replace route when new_text arrives without old_text", async () => {
			// A model that has failed to patch a file incrementally sends the
			// whole file back with no `old_text`. Saying only that `old_text` is
			// missing leaves it with no way to do what it asked for.
			await withTempFile("one\ntwo\nthree", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor({ path: filePath, new_text: "rewritten" }, dir, context),
				).rejects.toThrow(/`start_line: 1` and `end_line: 3`/);
				// The message must name `path` too. Measured: a model rebuilt
				// the call from an earlier version of this sentence, which
				// named only the line numbers, and dropped `path` three times.
				await expect(
					editor({ path: filePath, new_text: "rewritten" }, dir, context),
				).rejects.toThrow(new RegExp(`path: "${filePath.replace(/\\/g, "\\\\")}"`));
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"one\ntwo\nthree",
				);
			});
		});

		it("points at the line-number gutter when that is why nothing matched", async () => {
			// Measured: the model pasted `fill();}});}\n93 | ` straight out of a
			// read_files result, and "text not found" told it nothing.
			await withTempFile("real content", async (filePath, dir) => {
				const editor = createEditorExecutor();

				await expect(
					editor(
						{ path: filePath, old_text: "  92 | real content", new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow("line-number gutter");
			});
		});
	});
});
