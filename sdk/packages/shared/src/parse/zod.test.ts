import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateWithZod } from "./zod";

const EditorLike = z.object({
	path: z.string(),
	new_text: z.string(),
	start_line: z.coerce.number().int().nullable().optional(),
});

describe("validateWithZod", () => {
	it("says which required argument is missing, in words", () => {
		// Measured: a model sent `editor` without `path` and got
		// `✖ Invalid input: expected string, received undefined → at path`,
		// which names the field only as the tail of a type complaint and never
		// says it was required.
		expect(() =>
			validateWithZod(EditorLike, { start_line: 87, new_text: "x" }),
		).toThrow("Missing required argument `path`. Send it and call again.");
	});

	it("lists several missing arguments together", () => {
		expect(() => validateWithZod(EditorLike, {})).toThrow(
			"Missing required arguments: `path`, `new_text`. Send them and call again.",
		);
	});

	// A transcript holds dozens of edits to one file, and "send `path` and call
	// again" identifies none of them. The names it did send do.
	it("lists the arguments the call did carry", () => {
		expect(() =>
			validateWithZod(EditorLike, { start_line: 87, new_text: "x" }),
		).toThrow("The call carried: `start_line`, `new_text`.");
	});

	it("says nothing about what was carried when nothing was", () => {
		expect(() => validateWithZod(EditorLike, {})).toThrow(
			/Send them and call again\.$/,
		);
	});

	// Names only: a rejected call's values are the model's own text, often the
	// whole file, and echoing them back buys nothing.
	it("never echoes the values back", () => {
		let message = "";
		try {
			validateWithZod(EditorLike, { new_text: "the whole file" });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("The call carried: `new_text`.");
		expect(message).not.toContain("the whole file");
	});

	// pandorum 2026-09-18, session elcud. The call arrived with these keys:
	//   `end_line`, `new_text`,
	//   `|function setupLevel|function initClouds|class Level<|"|>],task_progress`
	// A JSON object key cannot contain a raw quote, so that key was not written
	// by the model -- it is the tail of a string the lenient repair path read
	// past the end of, turned into a key. `path` did not go missing; it was
	// swallowed. Telling the model it forgot an argument sends it to re-send the
	// same payload, which is what it did.
	it("says the arguments were misread when a key could not have been written", () => {
		let message = "";
		try {
			validateWithZod(EditorLike, {
				end_line: 133,
				new_text: "<script>…</script>",
				'|function setupLevel|class Level<|"|>],task_progress': ["- [x] run"],
			});
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("could not be read");
		// And it must not pretend the model simply forgot one.
		expect(message).not.toContain("Missing required argument `path`");
		// Never the garbage itself: it is the model's own text, and quoting it
		// back is what put it in front of the user in the first place.
		expect(message).not.toContain("setupLevel");
	});

	// The ordinary missing argument still reads as one: this must not fire on
	// every refusal, or the message that tells a model what to fix is gone.
	it("still names a plainly missing argument", () => {
		expect(() =>
			validateWithZod(EditorLike, { end_line: 133, new_text: "x" }),
		).toThrow("Missing required argument `path`.");
	});

	it("names a nested path", () => {
		const schema = z.object({ files: z.object({ path: z.string() }) });
		expect(() => validateWithZod(schema, { files: {} })).toThrow(
			"Missing required argument `files.path`.",
		);
	});

	it("keeps Zod's message when a field is present but the wrong type", () => {
		// That message is already about the type, which is the actual problem.
		expect(() =>
			validateWithZod(EditorLike, { path: 42, new_text: "x" }),
		).toThrow(/expected string/);
	});

	it("keeps Zod's message when only some issues are missing fields", () => {
		expect(() => validateWithZod(EditorLike, { path: 42 })).toThrow(
			/expected string/,
		);
	});

	it("returns the parsed value when the input is valid", () => {
		expect(
			validateWithZod(EditorLike, {
				path: "/tmp/a.ts",
				new_text: "x",
				start_line: "3",
			}),
		).toEqual({ path: "/tmp/a.ts", new_text: "x", start_line: 3 });
	});
});

describe("validateWithZod: arguments swallowed into a string", () => {
	const Editor = z.object({
		path: z.string().optional(),
		file_path: z.string().optional(),
		new_text: z.string(),
		old_text: z.string().optional(),
		start_line: z.number().optional(),
		end_line: z.number().optional(),
		intent: z.string().optional(),
	});

	it("refuses the pandorum call and names the argument the model wrote", () => {
		// t9vz7, call 82: `new_text` closed with a backtick, `start_line` after it.
		const input = {
			end_line: 344,
			file_path: "manic_miner.html",
			intent: "Fix friction",
			new_text:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the model's own code, quoted
				"o2El.innerText=`${Math.max(0,~~(player.o2))}%`;\nclouds.forEach(c=>c.update());\n}\n`,start_line:337",
		};
		expect(() => validateWithZod(Editor, input)).toThrow(
			/Its `new_text` ends with .*closed with a backtick \(`\).*`start_line: 337`, which you did write/,
		);
	});

	it("names every argument a tail swallowed, and a tag as the closer", () => {
		expect(() =>
			validateWithZod(Editor, {
				end_line: 9,
				new_text: "</html>` ,path: `manic_miner.html`, start_line: 105}",
			}),
		).toThrow(/`path: `manic_miner.html``, `start_line: 105`/);
		expect(() =>
			validateWithZod(Editor, {
				end_line: 133,
				file_path: "m.html",
				new_text: "</script></code>,start_line:29",
			}),
		).toThrow(/closed with `<\/code>`/);
	});

	it("passes text that only looks like it", () => {
		// A template literal at the end of the text, nothing after it.
		expect(
			validateWithZod(Editor, { new_text: "const s = `a`;" }).new_text,
		).toBe("const s = `a`;");
		// The name is not one of this tool's arguments.
		expect(
			validateWithZod(Editor, { new_text: "f(`a`, width: 3" }).new_text,
		).toBe("f(`a`, width: 3");
		// The argument is in the call already, so nothing was lost.
		expect(
			validateWithZod(Editor, {
				new_text: "x`,start_line:3",
				start_line: 3,
			}).start_line,
		).toBe(3);
		// A newline after it, which the refusal tells a model to add.
		expect(
			validateWithZod(Editor, { new_text: "x`,start_line:3\n" }).new_text,
		).toBe("x`,start_line:3\n");
	});
});

describe("validateWithZod: an unknown closer is not named", () => {
	it("does not blame the quote that ends a swallowed value", () => {
		// agent uqj5pq: `old_text` ran on through `path: '...'`, which is no
		// argument of this schema, and on into `start_line` and `end_line`.
		const Editor = z.object({
			new_text: z.string(),
			old_text: z.string().optional(),
			start_line: z.number().optional(),
			end_line: z.number().optional(),
		});
		let message = "";
		try {
			validateWithZod(Editor, {
				new_text: "x",
				old_text:
					"safe)} ,path: 'c:\\\\m.html', start_line: 96, end_line: 132}",
			});
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("was not closed by the delimiter that opened it");
		expect(message).not.toContain("closed with a quote");
		expect(message).toContain("`start_line: 96`, `end_line: 132`");
	});
});
