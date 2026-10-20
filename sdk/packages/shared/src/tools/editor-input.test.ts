import { describe, expect, it } from "vitest";
import { editorFilePath } from "./editor-input";

describe("editorFilePath", () => {
	it("reads the name the schema asks for", () => {
		expect(editorFilePath({ file_path: "/w/a.ts", new_text: "x" })).toBe(
			"/w/a.ts",
		);
	});

	it("reads a call written with the old name", () => {
		expect(editorFilePath({ path: "/w/a.ts", new_text: "x" })).toBe("/w/a.ts");
	});

	it("prefers file_path when a call carries both", () => {
		expect(editorFilePath({ path: "/w/old.ts", file_path: "/w/a.ts" })).toBe(
			"/w/a.ts",
		);
	});

	it("has nothing to say about a call that names no file", () => {
		expect(editorFilePath({ new_text: "x" })).toBeUndefined();
		expect(editorFilePath({ file_path: "" })).toBeUndefined();
		expect(editorFilePath(undefined)).toBeUndefined();
		expect(editorFilePath("a string")).toBeUndefined();
	});
});
