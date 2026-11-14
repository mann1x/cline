import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./executors/editor";
import { describeRedefinition } from "./redefinition-note";

/** `lines` joined, and the edit that replaces `range` with `written`. */
function edit(
	lines: string[],
	first: number,
	last: number,
	written: string[],
): { before: string; after: string; input: unknown } {
	const after = [
		...lines.slice(0, first - 1),
		...written,
		...lines.slice(last),
	];
	return {
		before: lines.join("\n"),
		after: after.join("\n"),
		input: {
			file_path: "x",
			start_line: first,
			end_line: last,
			new_text: written.join("\n"),
		},
	};
}

// The shape of the pandorum run: minified methods one per line, and the
// rewrite of `dIt` (line 5) sent to line 4, which holds `dDec`.
const LEVEL = [
	"<!DOCTYPE html>",
	"<html><body><script>",
	"class Level {",
	"    dDec(c,x){this.dc.forEach(d=>{c.fill();});}",
	"    dIt(c,x){this.it.forEach(it=>{c.restore();})}",
	"    dPl(c,x){c.save();}",
	"}",
	"function loop(){currentLevelObj.dDec(ctx,0);currentLevelObj.dIt(ctx,0);}",
	"</script></body></html>",
];
const REWRITE = [
	"    dIt(c, x) {",
	"        this.it.forEach(it => {",
	"            c.restore();",
	"        });",
	"    }",
];

describe("describeRedefinition", () => {
	it("names the duplicate a wrong-line edit leaves, and which one runs", () => {
		const { before, after, input } = edit(LEVEL, 4, 4, REWRITE);
		const note = describeRedefinition("m.html", before, after, input);
		expect(note).toContain("`dIt` defined twice as a method of the same class");
		expect(note).toContain("at line 4, which this call wrote, and at line 9");
		expect(note).toContain(
			"the one at line 9 is the one that runs, and the one this call wrote never does",
		);
		expect(note).toContain(
			"The lines this call replaced did not mention `dIt`.",
		);
	});

	it("says the written one runs when it comes last", () => {
		const { before, after, input } = edit(LEVEL, 6, 6, REWRITE);
		const note = describeRedefinition("m.html", before, after, input);
		expect(note).toContain("at line 6, which this call wrote, and at line 5");
		expect(note).toContain(
			"the one this call wrote is the one that runs, and the one at line 5 no longer does",
		);
	});

	it("leaves out the replaced-lines sentence for a pure insertion", () => {
		const lines = LEVEL;
		const after = [...lines.slice(0, 6), ...REWRITE, ...lines.slice(6)];
		const note = describeRedefinition(
			"m.html",
			lines.join("\n"),
			after.join("\n"),
			{
				insert_line: 7,
				new_text: REWRITE.join("\n"),
			},
		);
		expect(note).toContain("`dIt` defined twice");
		expect(note).not.toContain("replaced");
	});

	it("works on a plain .js file", () => {
		const lines = LEVEL.slice(2, 8);
		const { before, after, input } = edit(lines, 2, 2, REWRITE);
		expect(describeRedefinition("game.js", before, after, input)).toContain(
			"`dIt` defined twice",
		);
	});

	it("is silent when the replaced lines held the name (a rewrite in place)", () => {
		const { before, after, input } = edit(LEVEL, 5, 5, REWRITE);
		expect(
			describeRedefinition("m.html", before, after, input),
		).toBeUndefined();
	});

	it("is silent for a getter and setter pair", () => {
		const lines = ["class A {", "    get v() { return this._v; }", "}"];
		const { before, after, input } = edit(lines, 3, 3, [
			"    set v(x) { this._v = x; }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent for a static and an instance method of one name", () => {
		const lines = ["class A {", "    static make() { return new A(); }", "}"];
		const { before, after, input } = edit(lines, 3, 3, [
			"    make() { return 1; }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent when `static` stands on the line above, behind a comment", () => {
		const lines = ["class A {", "    make() { return 1; }", "}"];
		const { before, after, input } = edit(lines, 3, 3, [
			"    static",
			"    // the factory",
			"    make() { return new A(); }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("speaks for two static methods of one name", () => {
		const lines = ["class A {", "    static make() { return 1; }", "}"];
		const { before, after, input } = edit(lines, 3, 3, [
			"    static make() { return 2; }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toContain(
			"`make` defined twice as a static method",
		);
	});

	it("is silent for the same name in two different classes", () => {
		const lines = [
			"class A {",
			"    run() { return 1; }",
			"}",
			"class B {",
			"}",
		];
		const { before, after, input } = edit(lines, 5, 5, [
			"    run() { return 2; }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent for an object literal's method of the class method's name", () => {
		const lines = [
			"class A {",
			"    run() { return 1; }",
			"    opts() {",
			"        return {",
			"        };",
			"    }",
			"}",
		];
		const { before, after, input } = edit(lines, 5, 5, [
			"            run() { return 2; }",
			"        };",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent when a syntax error stands between the two", () => {
		const lines = [
			"class A {",
			"    broken() { call( }",
			"    run() { return 1; }",
			"}",
		];
		const { before, after, input } = edit(lines, 2, 2, [
			"    run() { return 2; }",
			"    broken() { call( }",
		]);
		// The written `run` is first; the parser stops at `broken` before the
		// second, so nothing is proved.
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent when the name has a third head anywhere", () => {
		const lines = [
			"class A {",
			"    run() { return 1; }",
			"}",
			"class B {",
			"    run() { return 3; }",
			"}",
		];
		const { before, after, input } = edit(lines, 3, 3, [
			"    run() { return 2; }",
			"}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("is silent when the line is not in the call's arguments", () => {
		const { before, after } = edit(LEVEL, 4, 4, REWRITE);
		expect(
			describeRedefinition("m.html", before, after, {
				new_text: "something else",
			}),
		).toBeUndefined();
	});

	it("is silent for TypeScript and Python, whose checkers report it", () => {
		const { before, after, input } = edit(LEVEL.slice(2, 8), 2, 2, REWRITE);
		expect(describeRedefinition("a.ts", before, after, input)).toBeUndefined();
		expect(describeRedefinition("a.py", before, after, input)).toBeUndefined();
	});

	it("is silent for two definitions on one line", () => {
		const lines = ["class A {", "    run(){return 1}", "}"];
		const { before, after, input } = edit(lines, 2, 2, [
			"    run(){return 1} run(){return 2}",
		]);
		expect(describeRedefinition("a.js", before, after, input)).toBeUndefined();
	});

	it("keeps CRLF files' line numbers", () => {
		const { before, after, input } = edit(LEVEL, 4, 4, REWRITE);
		const note = describeRedefinition(
			"m.html",
			before.replace(/\n/g, "\r\n"),
			after.replace(/\n/g, "\r\n"),
			input,
		);
		expect(note).toContain("at line 4, which this call wrote, and at line 9");
	});
});

describe("the editor's redefinition note", () => {
	it("is attached to the edit result, and the edit is applied", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "redefinition-"));
		try {
			const file = path.join(dir, "m.html");
			await writeFile(file, LEVEL.join("\n"));
			const editor = createEditorExecutor();
			const result = await editor(
				{
					path: file,
					start_line: 4,
					end_line: 4,
					new_text: REWRITE.join("\n"),
				} as never,
				dir,
				{ agentId: "a", conversationId: "c" } as never,
			);
			expect(result).toContain("Replaced line 4");
			expect(result).toContain("`dIt` defined twice");
			expect(await readFile(file, "utf8")).toContain("dIt(c, x) {");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("adds nothing to an ordinary edit", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "redefinition-"));
		try {
			const file = path.join(dir, "m.html");
			await writeFile(file, LEVEL.join("\n"));
			const editor = createEditorExecutor();
			const result = await editor(
				{
					path: file,
					start_line: 5,
					end_line: 5,
					new_text: REWRITE.join("\n"),
				} as never,
				dir,
				{ agentId: "a", conversationId: "c" } as never,
			);
			expect(result).not.toContain("defined twice");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
