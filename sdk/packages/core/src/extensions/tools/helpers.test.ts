import { describe, expect, it } from "vitest";
import { getEditorSizeError } from "./helpers";
import { EDITOR_ARG_CHAR_LIMIT, type EditFileInput } from "./schemas";

const OVERSIZED = "x".repeat(EDITOR_ARG_CHAR_LIMIT + 1);

function input(fields: Partial<EditFileInput>): EditFileInput {
	return { path: "/tmp/file.ts", new_text: "", ...fields } as EditFileInput;
}

/**
 * The size guard's job is to catch a runaway payload. Its other job — the one it
 * was failing at — is to leave the model somewhere it can go next.
 *
 * Measured on a live 1h48m session: the create form was refused on an existing
 * file with advice to use `start_line: 1, end_line: <count>`; that call was then
 * refused for size with advice to "replace the whole region in one call by line
 * number", which is exactly what it had just done; it sent the same call twice
 * more. Three refusals and roughly 52,000 characters of generated text produced
 * no edit. Every assertion here is about not doing that again.
 */
describe("getEditorSizeError", () => {
	it("passes an ordinary edit", () => {
		expect(getEditorSizeError(input({ old_text: "a", new_text: "b" }))).toBeNull();
	});

	it("refuses an oversized old_text and points at line numbers instead", () => {
		const error = getEditorSizeError(input({ old_text: OVERSIZED, new_text: "b" }));
		expect(error).toContain("old_text was");
		expect(error).toContain("start_line");
	});

	it("exempts creating a file, which cannot be split", () => {
		expect(getEditorSizeError(input({ new_text: OVERSIZED }))).toBeNull();
	});

	it("exempts a rewrite that starts at line 1, the shape the tool asks for", () => {
		// The executor's range guard decides this one; it can see the line count.
		expect(
			getEditorSizeError(input({ start_line: 1, end_line: 137, new_text: OVERSIZED })),
		).toBeNull();
	});

	it("refuses an oversized range that does not start at line 1", () => {
		const error = getEditorSizeError(
			input({ start_line: 40, end_line: 137, new_text: OVERSIZED }),
		);
		expect(error).toContain("new_text was");
	});

	// The old message told a range edit to do the thing it had just done.
	it("tells an oversized range how to split itself, not to use a range", () => {
		const error = getEditorSizeError(
			input({ start_line: 40, end_line: 137, new_text: OVERSIZED }),
		);
		expect(error).toContain("Lines 40-137");
		expect(error).toContain("consecutive pieces");
		// Advising `start_line`/`end_line` here is the circularity being fixed.
		expect(error).not.toContain("in one call by line number");
	});

	it("still advises line numbers when there is no range to split", () => {
		const error = getEditorSizeError(input({ old_text: "a", new_text: OVERSIZED }));
		expect(error).toContain("start_line");
	});

	it("states the configured limit so the message matches the tool description", () => {
		const error = getEditorSizeError(input({ old_text: "a", new_text: OVERSIZED }));
		expect(error).toContain(String(EDITOR_ARG_CHAR_LIMIT));
	});
});
