import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";
import { createReadReceipts } from "./read-receipts";

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
				// The message tells the model to work out how its text differs from
				// what is there, so it has to show what is there. It used to say
				// "differs from the text quoted back to you" and quote nothing;
				// measured live, the model went looking for the quote and fell back
				// to re-reading the file.
				await expect(failure).rejects.toThrow("2 | two");
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

		it("refuses a replacement that duplicates the range instead of replacing it", async () => {
			// Measured on a live session repairing a dense single-file game: the
			// model asked to replace a fifteen-line range with a block that opened
			// with those same fifteen lines and then restated the rest of the
			// class. Nothing was removed, ~140 lines were added, and the class
			// ended up in the file three times. The old result said
			// `success: true` and "15 of the 15 line(s) were already identical",
			// which reads as reassurance while the file is being corrupted.
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const failure = editor(
					{
						path: filePath,
						new_text: "b\nc\nEXTRA1\nEXTRA2\nEXTRA3",
						start_line: 2,
						end_line: 3,
					},
					dir,
					context,
				);

				await expect(failure).rejects.toThrow("Duplicated instead of replaced");
				await expect(failure).rejects.toThrow("appends a second copy");
				// The file must be left exactly as it was.
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nb\nc\nd");
			});
		});

		it("names the gutter when it numbers past end_line", async () => {
			// The two mistakes arrive together: a model in "gutter mode" pastes the
			// read output back, and the gutter it pastes runs further than the range
			// the call names. Stripped, that is a duplication — but the refusal used
			// to describe the symptom only, and the model has the answer in its own
			// hand: the last number it wrote is the `end_line` it meant.
			await withTempFile("a\nb\nc\nd\ne\nf\ng\nh", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const failure = editor(
					{
						path: filePath,
						start_line: 2,
						end_line: 3,
						new_text:
							"  2 | b\n  3 | c\n  4 | d\n  5 | e\n  6 | f\n  7 | g\n  8 | h",
					},
					dir,
					context,
				);

				await expect(failure).rejects.toThrow("Duplicated instead of replaced");
				await expect(failure).rejects.toThrow(
					"gutter on your `new_text` covers lines 2-8",
				);
				await expect(failure).rejects.toThrow("send `end_line: 8`");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nb\nc\nd\ne\nf\ng\nh",
				);
			});
		});

		it("does not blame the gutter when the range covers it", async () => {
			// A gutter that stops inside `end_line` is not what went wrong, and
			// pointing at it would send the model to change the one thing that was
			// already right.
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const message = await createEditorExecutor()(
					{
						path: filePath,
						new_text: "b\nc\nEXTRA1\nEXTRA2\nEXTRA3",
						start_line: 2,
						end_line: 3,
					},
					dir,
					context,
				).then(
					() => "resolved",
					(error: unknown) => (error as Error).message,
				);

				expect(message).toContain("Duplicated instead of replaced");
				expect(message).not.toContain("gutter on your");
			});
		});

		it("still allows growing a range when it actually replaces something", async () => {
			// The guard keys on removing nothing. Wrapping or expanding a range
			// that genuinely changes still has to work, or every refactor breaks.
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{
						path: filePath,
						new_text: "B1\nB2\nB3\nB4\nB5",
						start_line: 2,
						end_line: 3,
					},
					dir,
					context,
				);

				expect(result).toContain("Replaced lines 2-3");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"a\nB1\nB2\nB3\nB4\nB5\nd",
				);
			});
		});

		it("says how far the lines below an edit have moved", async () => {
			// Eight consecutive edits in the measured session addressed lines
			// 84-98 of a file that had meanwhile grown from ~120 lines to 440, so
			// the range named unrelated code by the end.
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "B1\nB2\nB3", start_line: 2 },
					dir,
					context,
				);

				expect(result).toContain("The file is now 6 lines (was 4)");
				expect(result).toContain("Every line after 2 has moved by +2");
			});
		});

		// Stating the fact was not enough. Measured: a model read this note,
		// composed a large replacement anyway, and had it refused for editing
		// from a retired read — minutes of generation thrown away because the
		// refusal comes only after the whole payload has been written.
		// Mined from real sessions: one model pasted the `read_files` gutter into
		// `old_text` ten times in a row against an error message that explains
		// the mistake precisely, burning a full generation each time. Naming it
		// was not enough, so the editor recovers.
		// Measured: start_line 30 / end_line 134 with 101 replacement lines in a
		// 138-line file left 278 problems behind, and every existing guard passed
		// it — read-before-edit was satisfied, and "adds more lines than the range
		// holds" passes because 101 < 105.
		it("refuses an unanchored replacement that is really a whole-file rewrite", async () => {
			const file = Array.from({ length: 138 }, (_, i) => `line ${i + 1}`).join("\n");
			await withTempFile(file, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{
							path: filePath,
							start_line: 30,
							end_line: 134,
							new_text: Array.from({ length: 101 }, (_, i) => `new ${i}`).join("\n"),
						},
						dir,
						context,
					),
				).rejects.toThrow("whole-file rewrite");
			});
		});

		// The refusal above names `start_line: 1, end_line: <count>` as the way to
		// rewrite a file on purpose, and the create form's refusal on an existing
		// file names the same call. Measured: both routes then hit this guard and
		// the size guard, so there was no reachable way to rewrite a file at all —
		// the model bounced between the three for five calls and ~52,000 characters
		// of generated text before giving up.
		it("allows a rewrite stated exactly as lines 1 through the line count", async () => {
			const file = Array.from({ length: 138 }, (_, i) => `line ${i + 1}`).join("\n");
			await withTempFile(file, async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{
						path: filePath,
						start_line: 1,
						end_line: 138,
						new_text: "rewritten",
					},
					dir,
					context,
				);
				expect(result).not.toContain("No replacement performed");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("rewritten");
			});
		});

		// end_line past EOF already means "to the end of the file", so this is the
		// same rewrite written by a model that does not know the line count.
		it("treats lines 1 to past-EOF as the same stated rewrite", async () => {
			const file = Array.from({ length: 138 }, (_, i) => `line ${i + 1}`).join("\n");
			await withTempFile(file, async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, start_line: 1, end_line: 9999, new_text: "rewritten" },
					dir,
					context,
				);
				expect(result).not.toContain("No replacement performed");
			});
		});

		// The exemption is for a rewrite that says so, not for one that starts at
		// line 1 and stops short — that is still a partial edit the model may have
		// mismeasured.
		it("still refuses a large unanchored range that starts at line 1 but stops short", async () => {
			const file = Array.from({ length: 138 }, (_, i) => `line ${i + 1}`).join("\n");
			await withTempFile(file, async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{ path: filePath, start_line: 1, end_line: 100, new_text: "rewritten" },
						dir,
						context,
					),
				).rejects.toThrow("whole-file rewrite");
			});
		});

		// Anchored edits are self-verifying, so size is not the objection.
		it("allows a large range when old_text anchors it", async () => {
			const file = Array.from({ length: 138 }, (_, i) => `line ${i + 1}`).join("\n");
			await withTempFile(file, async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, old_text: "line 30", new_text: "changed" },
					dir,
					context,
				);
				expect(result).not.toContain("No replacement performed");
			});
		});

		// Small files must stay editable: replacing most of something tiny is a
		// normal edit, not a rewrite in disguise.
		it("allows replacing most of a small file", async () => {
			await withTempFile("a\nb\nc\nd\ne", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, start_line: 1, end_line: 5, new_text: "x\ny" },
					dir,
					context,
				);
				expect(result).not.toContain("No replacement performed");
			});
		});

		it("recovers when old_text carries the read gutter", async () => {
			await withTempFile("alpha\nbeta\ngamma", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, old_text: "  2 | beta", new_text: "BETA" },
					dir,
					context,
				);

				expect(result).not.toContain("No replacement performed");
				const { readFile } = await import("node:fs/promises");
				expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma");
			});
		});

		// A model in "gutter mode" numbers both sides; writing the gutter into
		// the file is the worse of the two failures.
		it("strips the gutter from new_text too", async () => {
			await withTempFile("alpha\nbeta\ngamma", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{ path: filePath, old_text: "  2 | beta", new_text: "  2 | BETA" },
					dir,
					context,
				);

				const { readFile } = await import("node:fs/promises");
				expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma");
			});
		});

		// The file decides, not the shape of the input: text that genuinely
		// looks like a gutter and does not match must still fail.
		it("still refuses when stripping does not produce a match", async () => {
			await withTempFile("alpha\nbeta", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await expect(
					editor(
						{ path: filePath, old_text: "  9 | nowhere", new_text: "x" },
						dir,
						context,
					),
				).rejects.toThrow("No replacement performed");
			});
		});

		// A single line starting with a number and a pipe is ordinary source.
		it("leaves real content that looks like a gutter alone", async () => {
			await withTempFile("a\n12 | pipe row\nb", async (filePath, dir) => {
				const editor = createEditorExecutor();
				await editor(
					{ path: filePath, old_text: "12 | pipe row", new_text: "12 | changed" },
					dir,
					context,
				);

				const { readFile } = await import("node:fs/promises");
				expect(await readFile(filePath, "utf8")).toBe("a\n12 | changed\nb");
			});
		});

		it("tells the model to read again before its next edit, and why", async () => {
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "B1\nB2\nB3", start_line: 2 },
					dir,
					context,
				);

				expect(result).toContain("no longer counts as having read it");
				expect(result).toContain("read_files");
				// The cost of skipping it is the part that changes behaviour.
				expect(result).toContain("after you have written the replacement out in full");
			});
		});

		it("says nothing about line numbers when the count did not change", async () => {
			await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{ path: filePath, new_text: "B", start_line: 2 },
					dir,
					context,
				);

				expect(result).not.toContain("The file is now");
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
				// ...but named as the fallback, after the targeted edit. Live: a
				// model quoted this sentence back as its reason for rewriting a
				// 138-line file whole on every retry, and triplicated a class
				// doing it. The order of the two routes is the behaviour.
				await expect(
					editor({ path: filePath, new_text: "rewritten" }, dir, context),
				).rejects.toThrow(/Edit the lines you mean to change[\s\S]*Replacing the file in full/);
				await expect(
					editor({ path: filePath, new_text: "rewritten" }, dir, context),
				).rejects.toThrow(/only after a targeted edit has failed/);
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

		it("recovers from the line-number gutter rather than pointing at it", async () => {
			// Measured: the model pasted `fill();}});}\n93 | ` straight out of a
			// read_files result, and "text not found" told it nothing. Naming the
			// gutter came next — and mining the sessions showed a model repeating
			// the mistake ten times against that explanation, so the edit now
			// succeeds instead. The message still exists for the case where
			// stripping does not produce a match.
			await withTempFile("real content", async (filePath, dir) => {
				const editor = createEditorExecutor();

				const result = await editor(
					{ path: filePath, old_text: "  92 | real content", new_text: "x" },
					dir,
					context,
				);

				expect(result).not.toContain("No replacement performed");
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("x");
			});
		});
	});
});

describe("requiring a read before an edit", () => {
	// Measured on a live session repairing a dense single-file game: eight
	// consecutive `editor` calls and not one `read_files` call. The model was
	// working from line numbers in a context summary written several turns
	// earlier; its own edits then grew the file from ~120 lines to 440, so the
	// range it kept naming stopped pointing at the code it meant. Diagnostics
	// went 2 → 20. Every one of those edits was refusable at the first.
	it("refuses a line-addressed edit when the file was never read", async () => {
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });

			const failure = editor(
				{ path: filePath, new_text: "B", start_line: 2 },
				dir,
				context,
			);

			await expect(failure).rejects.toThrow("Read before editing");
			await expect(failure).rejects.toThrow("has not been read in this session");
			await expect(failure).rejects.toThrow("read_files");
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nb\nc\nd");
		});
	});

	it("allows the edit once the range has been read", async () => {
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			receipts.noteRead(filePath, 1, 4);

			const result = await editor(
				{ path: filePath, new_text: "B", start_line: 2 },
				dir,
				context,
			);

			expect(result).toContain("Replaced line 2");
		});
	});

	it("accepts an edit whose range runs past the end of the file", async () => {
		// Measured live, three identical cycles before the run was stopped: the
		// file was 198 lines, the model aimed at lines 101-200, `read_files`
		// 101-200 returned what existed and recorded a receipt for 101-198, and
		// the guard demanded coverage of 101-200 — then told the model to go and
		// read 101-200, which it did, correctly, every time. Two lines that do
		// not exist cannot be read, so requiring them is a demand with no
		// satisfying answer, and the instruction to satisfy it is the loop.
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			// What `read_files` records for a request that overshoots: the file.
			receipts.noteRead(filePath, 3, 4);

			const result = await editor(
				{ path: filePath, new_text: "C\nD", start_line: 3, end_line: 99 },
				dir,
				context,
			);

			expect(result).toContain("Replaced lines 3-4");
		});
	});

	it("still refuses when the read stops short inside the file", async () => {
		// The clamp is to the end of the file, not to whatever was read. A range
		// that ends inside the file and was only partly read is the case the
		// guard exists for, and it has to keep failing.
		await withTempFile("a\nb\nc\nd\ne\nf", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			receipts.noteRead(filePath, 1, 3);

			const failure = editor(
				{ path: filePath, new_text: "X", start_line: 2, end_line: 5 },
				dir,
				context,
			);

			await expect(failure).rejects.toThrow("Read before editing");
		});
	});

	it("refuses an edit outside the range that was read", async () => {
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			receipts.noteRead(filePath, 1, 2);

			const failure = editor(
				{ path: filePath, new_text: "D", start_line: 4 },
				dir,
				context,
			);

			await expect(failure).rejects.toThrow("Read before editing");
		});
	});

	it("requires a fresh read after an edit that changed the file's length", async () => {
		// The second edit is aimed at a line number from before the first one
		// moved it. This is the exact shape of the measured failure.
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			receipts.noteRead(filePath, 1, 4);

			await editor(
				{ path: filePath, new_text: "B1\nB2\nB3", start_line: 2 },
				dir,
				context,
			);

			const failure = editor(
				{ path: filePath, new_text: "X", start_line: 3 },
				dir,
				context,
			);

			await expect(failure).rejects.toThrow("Read before editing");
			await expect(failure).rejects.toThrow(
				"an earlier edit changed the file's length",
			);
		});
	});

	it("keeps the receipt when an edit left the line count alone", async () => {
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			receipts.noteRead(filePath, 1, 4);

			await editor({ path: filePath, new_text: "B", start_line: 2 }, dir, context);
			const result = await editor(
				{ path: filePath, new_text: "C", start_line: 3 },
				dir,
				context,
			);

			expect(result).toContain("Replaced line 3");
		});
	});

	it("refuses a text-matched edit on a file that was never read", async () => {
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });

			const failure = editor(
				{ path: filePath, old_text: "b", new_text: "B" },
				dir,
				context,
			);

			await expect(failure).rejects.toThrow("Read before editing");
		});
	});

	it("still creates a new file without a read", async () => {
		// There is nothing to have read, and refusing here would make the guard
		// break file creation.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-editor-"));
		try {
			const receipts = createReadReceipts();
			const editor = createEditorExecutor({ receipts });
			const filePath = path.join(dir, "fresh.txt");

			await editor({ path: filePath, new_text: "hello" }, dir, context);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("hello");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("is off when no registry is supplied", async () => {
		// A standalone executor has no reader to pair with; failing every edit
		// would be the wrong default for an embedder wiring tools up piecemeal.
		await withTempFile("a\nb\nc\nd", async (filePath, dir) => {
			const editor = createEditorExecutor();

			const result = await editor(
				{ path: filePath, new_text: "B", start_line: 2 },
				dir,
				context,
			);

			expect(result).toContain("Replaced line 2");
		});
	});
});

describe("a range edit carrying the read gutter", () => {
	it("does not write the gutter into the file", async () => {
		// Measured live: this exact call was accepted verbatim and the file's
		// last two lines became the read output that described them.
		//
		// Stripped, the edit asks for what the file already holds, so it is
		// refused as a no-op — which is the honest answer, and the one the model
		// can act on. Silently writing the gutter was neither.
		await withTempFile("<body>\n  <p>hi</p>\n</body>\n</html>", async (filePath, dir) => {
			const editor = createEditorExecutor();

			await expect(
				editor(
					{
						path: filePath,
						start_line: 3,
						end_line: 4,
						new_text: "  3 | </body>\n  4 | </html>",
					},
					dir,
					context,
				),
			).rejects.toThrow("No change");

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"<body>\n  <p>hi</p>\n</body>\n</html>",
			);
		});
	});

	it("keeps the source's own indentation", async () => {
		await withTempFile("a\nb", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					start_line: 1,
					end_line: 2,
					new_text: "  1 |     indented\n  2 | plain",
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"    indented\nplain",
			);
		});
	});

	it("leaves content alone when the numbers do not match the range", async () => {
		// Real text that merely looks like a gutter. The numbers are the
		// evidence: these do not count up from start_line, so nothing is
		// stripped.
		await withTempFile("x\ny", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					start_line: 1,
					end_line: 2,
					new_text: "  42 | first\n  99 | second",
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"  42 | first\n  99 | second",
			);
		});
	});

	it("strips only when every line is numbered in sequence", async () => {
		await withTempFile("x\ny", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await editor(
				{
					path: filePath,
					start_line: 1,
					end_line: 2,
					new_text: "  1 | first\nplain second",
				},
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"  1 | first\nplain second",
			);
		});
	});
});

describe("how long the file is", () => {
	it("agrees with what the read output showed", async () => {
		// Measured live: `read_files` said "[270 lines, shown in full.]" while
		// the editor said "the file's 271 lines", and the model spent its turns
		// alternating between the two looking for the one that meant "all of it".
		// The extra one is the empty string after the final newline.
		await withTempFile("a\nb\nc\n", async (filePath, dir) => {
			const editor = createEditorExecutor();

			await expect(
				editor(
					{ path: filePath, start_line: 4, end_line: 4, new_text: "d" },
					dir,
					context,
				),
			).rejects.toThrow("The file has 3 line(s)");
		});
	});

	it("takes the whole file at its last real line", async () => {
		await withTempFile("a\nb\nc\n", async (filePath, dir) => {
			const editor = createEditorExecutor();

			await editor(
				{ path: filePath, start_line: 1, end_line: 3, new_text: "only" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("only\n");
		});
	});

	it("keeps the trailing newline it did not count", async () => {
		await withTempFile("a\nb\n", async (filePath, dir) => {
			const editor = createEditorExecutor();

			await editor(
				{ path: filePath, start_line: 2, end_line: 2, new_text: "B" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB\n");
		});
	});

	it("leaves a file with no trailing newline without one", async () => {
		await withTempFile("a\nb", async (filePath, dir) => {
			const editor = createEditorExecutor();

			await editor(
				{ path: filePath, start_line: 2, end_line: 2, new_text: "B" },
				dir,
				context,
			);

			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("a\nB");
		});
	});
});
