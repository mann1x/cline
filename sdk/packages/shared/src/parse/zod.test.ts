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
