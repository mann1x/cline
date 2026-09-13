import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCliCodeIntelProvider,
	languageIdFor,
} from "./code-intel-support";
import { fileUri, uriToPath } from "./lsp-client";

/**
 * The CLI's `code_intel`, against a language server that is not real.
 *
 * A stub rather than `typescript-language-server`: the client's job is the
 * protocol -- framing, request correlation, opening a document before asking
 * about it -- and testing that against a server nobody installed would make the
 * suite depend on the machine it runs on.
 */

/** A language server that answers the four requests these cases ask for. */
const STUB_SERVER = `
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
const opened = new Set();
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end === -1) return;
    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    const start = end + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString());
    buffer = buffer.subarray(start + length);
    if (message.method === "textDocument/didOpen") {
      opened.add(message.params.textDocument.uri);
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") { send({ id: message.id, result: { capabilities: {} } }); continue; }
    if (message.method === "shutdown") { send({ id: message.id, result: null }); continue; }
    const uri = message.params?.textDocument?.uri;
    // Every position-addressed answer is conditional on the document having
    // been opened first, which is the part of the protocol worth testing.
    if (uri && !opened.has(uri)) { send({ id: message.id, result: null }); continue; }
    if (message.method === "textDocument/definition") {
      send({ id: message.id, result: [{ uri, range: { start: { line: 4, character: 2 } } }] });
      continue;
    }
    if (message.method === "textDocument/documentSymbol") {
      send({ id: message.id, result: [
        { name: "Widget", kind: 5, selectionRange: { start: { line: 0, character: 6 } },
          children: [{ name: "render", kind: 6, selectionRange: { start: { line: 1, character: 2 } } }] },
      ] });
      continue;
    }
    if (message.method === "textDocument/hover") {
      send({ id: message.id, result: { contents: { value: "class Widget" } } });
      continue;
    }
    send({ id: message.id, result: null });
  }
});
`;

function workspaceWith(source: string): { cwd: string; file: string } {
	const cwd = mkdtempSync(join(tmpdir(), "cli-code-intel-"));
	const stub = join(cwd, "stub-server.js");
	writeFileSync(stub, STUB_SERVER);
	const file = join(cwd, "widget.ts");
	writeFileSync(file, source);
	return { cwd, file };
}

function providerFor(cwd: string) {
	return createCliCodeIntelProvider({
		cwd,
		servers: [
			{
				command: process.execPath,
				args: [join(cwd, "stub-server.js")],
				languages: ["typescript"],
			},
		],
	});
}

const SOURCE = [
	"class Widget {",
	"  render() {",
	"    return 1;",
	"  }",
	"}",
	"const w = new Widget();",
].join("\n");

describe("languageIdFor", () => {
	it("maps the extensions a model actually edits", () => {
		expect(languageIdFor("/a/b.ts")).toBe("typescript");
		expect(languageIdFor("/a/b.JS")).toBe("javascript");
		expect(languageIdFor("/a/page.html")).toBe("html");
	});

	it("has nothing to say about a file no server serves", () => {
		expect(languageIdFor("/a/notes.txt")).toBeUndefined();
	});
});

describe("fileUri", () => {
	it("survives a round trip through a path with a space", () => {
		expect(uriToPath(fileUri("/tmp/some dir/app.ts"))).toBe(
			"/tmp/some dir/app.ts",
		);
	});
});

describe("createCliCodeIntelProvider", () => {
	it("finds a symbol's position by reading the file", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		expect(await provider.findSymbolPosition(file, "Widget")).toEqual({
			filePath: file,
			line: 0,
			character: 6,
		});
	});

	it("answers a definition through the server", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		const found = await provider.definitions({
			filePath: file,
			line: 5,
			character: 14,
		});
		expect(found).toEqual([{ filePath: file, line: 4, character: 2 }]);
	});

	it("flattens the symbol tree, keeping what contains what", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		const symbols = await provider.documentSymbols(file);
		expect(symbols).toEqual([
			{
				name: "Widget",
				kind: "class",
				location: { filePath: file, line: 0, character: 6 },
				containerName: undefined,
			},
			{
				name: "render",
				kind: "method",
				location: { filePath: file, line: 1, character: 2 },
				containerName: "Widget",
			},
		]);
	});

	it("reads hover text out of the shape the server chose", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		expect(
			await provider.hover({ filePath: file, line: 0, character: 6 }),
		).toBe("class Widget");
	});

	// The honest failure. A language nobody installed a server for answers
	// nothing rather than failing the turn, which is what the extension does for
	// a language whose support the user never installed.
	it("returns nothing when no server serves the language", async () => {
		const { cwd } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		const unserved = join(cwd, "notes.rb");
		writeFileSync(unserved, "class Widget; end\n");
		expect(
			await provider.definitions({
				filePath: unserved,
				line: 0,
				character: 6,
			}),
		).toEqual([]);
	});

	it("quotes the line back from the file on disk", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		expect(await provider.readLine(file, 1)).toBe("  render() {");
	});

	// The cache is keyed on mtime because the model edits these files while it
	// works; a stale answer here is a model told its own edit did not happen.
	it("sees a file that changed under it", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const provider = providerFor(cwd);
		expect(await provider.readLine(file, 1)).toBe("  render() {");
		writeFileSync(file, SOURCE.replace("  render() {", "  paint() {"));
		expect(await provider.readLine(file, 1)).toBe("  paint() {");
	});
});
