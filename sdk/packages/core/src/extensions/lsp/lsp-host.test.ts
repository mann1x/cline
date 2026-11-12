import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspServerSpec } from "./lsp-connection";
import { fileUri, LspConnection, uriToPath } from "./lsp-connection";
import {
	createLspHost,
	findHtmlServerTypescriptGap,
	type LspHost,
	languageIdFor,
	repairHtmlServerTypescript,
} from "./lsp-host";

/**
 * The language-server host, against a server that is not real.
 *
 * A stub rather than `typescript-language-server`: the host's job is the
 * protocol -- framing, correlation, answering the server's own requests,
 * keeping documents in sync, collecting diagnostics -- and testing that
 * against a server nobody installed would make the suite depend on the
 * machine it runs on.
 */

/**
 * Before answering `initialize` it asks the client for its configuration
 * with id 1 -- the id of the client's own `initialize` -- and holds the
 * answer. Every document's text is kept as the protocol delivers it; a line
 * containing ERROR is published (or, pulled, returned) as a diagnostic.
 */
const STUB_SERVER = `
const pull = process.env.STUB_PULL === "1";
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
const docs = new Map();
let configAnswer = "unanswered";
let initializeId;
let opens = 0;
const diagnosticsOf = (text) => text.split("\\n").flatMap((line, index) =>
  line.includes("ERROR") ? [{ range: { start: { line: index, character: line.indexOf("ERROR") }, end: { line: index, character: line.indexOf("ERROR") + 5 } }, severity: 1, message: "found ERROR", source: "typescript" }] : []);
const publish = (uri) => { if (!pull) send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnosticsOf(docs.get(uri).text) } }); };
const symbolsOf = (text) => text.split("\\n").flatMap((line, index) => {
  const m = /class (\\w+)/.exec(line);
  return m ? [{ name: m[1], kind: 5, selectionRange: { start: { line: index, character: m.index + 6 } } }] : [];
});
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
    if (message.method === undefined) {
      // The client's answer to our request.
      if (message.id === 1) {
        configAnswer = message.result;
        send({ id: initializeId, result: { capabilities: pull ? { diagnosticProvider: {} } : {} } });
      }
      continue;
    }
    if (message.method === "initialize") {
      initializeId = message.id;
      send({ id: 1, method: "workspace/configuration", params: { items: [{ section: "html.validate" }, { section: "css" }] } });
      continue;
    }
    if (message.method === "textDocument/didOpen") {
      opens++;
      const d = message.params.textDocument;
      docs.set(d.uri, { version: d.version, text: d.text });
      publish(d.uri);
      continue;
    }
    if (message.method === "textDocument/didChange") {
      const d = message.params.textDocument;
      docs.set(d.uri, { version: d.version, text: message.params.contentChanges[0].text });
      publish(d.uri);
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "shutdown") { send({ id: message.id, result: null }); continue; }
    const uri = message.params?.textDocument?.uri;
    const doc = uri ? docs.get(uri) : undefined;
    if (uri && !doc) { send({ id: message.id, result: null }); continue; }
    if (message.method === "textDocument/hover") {
      send({ id: message.id, result: { contents: { value: JSON.stringify({ configAnswer, opens, version: doc.version }) } } });
      continue;
    }
    if (message.method === "textDocument/documentSymbol") {
      send({ id: message.id, result: symbolsOf(doc.text) });
      continue;
    }
    if (message.method === "textDocument/definition") {
      send({ id: message.id, result: [{ uri, range: { start: { line: 4, character: 2 } } }] });
      continue;
    }
    if (message.method === "textDocument/diagnostic") {
      send({ id: message.id, result: { kind: "full", items: diagnosticsOf(doc.text) } });
      continue;
    }
    send({ id: message.id, result: null });
  }
});
`;

const SOURCE = [
	"// a Widget is drawn here",
	"class Widget {",
	"  render() {",
	"    return 1;",
	"  }",
	"}",
].join("\n");

const hosts: LspHost[] = [];

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function workspaceWith(source: string): { cwd: string; file: string } {
	const cwd = mkdtempSync(join(tmpdir(), "core-lsp-host-"));
	writeFileSync(join(cwd, "stub-server.js"), STUB_SERVER);
	const file = join(cwd, "widget.ts");
	writeFileSync(file, source);
	return { cwd, file };
}

function stubSpec(
	cwd: string,
	env: Record<string, string> = {},
): LspServerSpec {
	return {
		name: "stub",
		command: process.execPath,
		args: [join(cwd, "stub-server.js")],
		languages: ["typescript"],
		env,
		settings: { html: { validate: { scripts: true } } },
		sources: { typescript: "ts" },
	};
}

function hostFor(cwd: string, env?: Record<string, string>): LspHost {
	const host = createLspHost({
		cwd,
		servers: [stubSpec(cwd, env)],
		isInstalled: () => true,
	});
	hosts.push(host);
	return host;
}

async function hoverState(host: LspHost, file: string) {
	const text = await host.provider.hover({
		filePath: file,
		line: 1,
		character: 6,
	});
	return JSON.parse(text ?? "{}") as {
		configAnswer: unknown;
		opens: number;
		version: number;
	};
}

async function until<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await read();
		if (done(value)) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return read();
}

describe("languageIdFor", () => {
	it("maps the extensions a model actually edits", () => {
		expect(languageIdFor("/a/b.ts")).toBe("typescript");
		expect(languageIdFor("/a/b.JS")).toBe("javascript");
		expect(languageIdFor("/a/page.html")).toBe("html");
		expect(languageIdFor("/a/main.cpp")).toBe("cpp");
		expect(languageIdFor("/a/Program.cs")).toBe("csharp");
		expect(languageIdFor("/a/run.sh")).toBe("shellscript");
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

describe("the server's own requests", () => {
	// A server request has a numeric id too. Taken for a response, it was
	// never answered -- and, sharing id 1 with the client's `initialize`,
	// resolved that request with the wrong answer.
	it("are answered, and never mistaken for a response", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		const state = await hoverState(host, file);
		expect(state.configAnswer).toEqual([{ scripts: true }, {}]);
	});

	it("get an object for a section nobody set, never null", () => {
		const connection = new LspConnection(
			{ command: "unused", args: [], languages: [], settings: { a: { b: 1 } } },
			tmpdir(),
		);
		expect(connection.setting("a.b")).toBe(1);
		expect(connection.setting("css")).toEqual({});
		expect(connection.setting("a.missing.deeper")).toEqual({});
		expect(connection.setting(undefined)).toEqual({ a: { b: 1 } });
	});
});

describe("documents follow the disk", () => {
	// The CLI re-sent `didOpen` for a changed file; a server holding it open
	// ignores that and answers from the old text.
	it("sends a changed file as a change with the next version, not a second open", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		expect(
			(await host.provider.documentSymbols(file)).map((s) => s.name),
		).toEqual(["Widget"]);
		writeFileSync(file, SOURCE.replace("class Widget", "class Gadget"));
		expect(
			(await host.provider.documentSymbols(file)).map((s) => s.name),
		).toEqual(["Gadget"]);
		const state = await hoverState(host, file);
		expect(state.opens).toBe(1);
		expect(state.version).toBe(2);
	});

	it("sends nothing when the file has not changed", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		await host.provider.documentSymbols(file);
		await host.provider.documentSymbols(file);
		expect((await hoverState(host, file)).version).toBe(1);
	});
});

describe("findSymbolPosition", () => {
	// As the extension: the declaration, from the symbol table, before the
	// first mention in the text -- here a comment on line 0.
	it("finds the declaration before the first mention", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		expect(await host.provider.findSymbolPosition(file, "Widget")).toEqual({
			filePath: file,
			line: 1,
			character: 6,
		});
	});

	it("falls back to the text where no server answers", async () => {
		const { cwd } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		const unserved = join(cwd, "notes.rb");
		writeFileSync(unserved, "# x\nclass Widget; end\n");
		expect(await host.provider.findSymbolPosition(unserved, "Widget")).toEqual({
			filePath: unserved,
			line: 1,
			character: 6,
		});
	});
});

describe("the rest of ask_lsp", () => {
	it("answers a definition through the server", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		expect(
			await host.provider.definitions({
				filePath: file,
				line: 5,
				character: 0,
			}),
		).toEqual([{ filePath: file, line: 4, character: 2 }]);
	});

	it("returns nothing when no server serves the language", async () => {
		const { cwd } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		const unserved = join(cwd, "notes.rb");
		writeFileSync(unserved, "class Widget; end\n");
		expect(host.serves(unserved)).toBe(false);
		expect(
			await host.provider.definitions({
				filePath: unserved,
				line: 0,
				character: 6,
			}),
		).toEqual([]);
	});

	it("quotes the line back from the file on disk, as it is now", async () => {
		const { cwd, file } = workspaceWith(SOURCE);
		const host = hostFor(cwd);
		expect(await host.provider.readLine(file, 2)).toBe("  render() {");
		writeFileSync(file, SOURCE.replace("  render() {", "  paint() {"));
		expect(await host.provider.readLine(file, 2)).toBe("  paint() {");
	});
});

describe("diagnostics", () => {
	it("keeps what the server publishes, labelled as the editor labels it", async () => {
		const { cwd, file } = workspaceWith(`${SOURCE}\nconst x = ERROR;\n`);
		const host = hostFor(cwd);
		expect(host.serves(file)).toBe(true);
		await host.touch(file);
		const held = await until(host.readDiagnostics, (files) =>
			files.some(
				(entry) =>
					entry.filePath === file &&
					!entry.pending &&
					entry.diagnostics.length > 0,
			),
		);
		expect(held).toEqual([
			{
				filePath: file,
				pending: false,
				diagnostics: [
					{
						range: {
							start: { line: 6, character: 10 },
							end: { line: 6, character: 15 },
						},
						severity: "error",
						message: "found ERROR",
						source: "ts",
					},
				],
			},
		]);
	});

	it("marks a changed file pending until the server reports on it again", async () => {
		const { cwd, file } = workspaceWith(`${SOURCE}\nconst x = ERROR;\n`);
		const host = hostFor(cwd);
		await host.touch(file);
		await until(host.readDiagnostics, (files) =>
			files.some((entry) => entry.diagnostics.length > 0),
		);
		writeFileSync(file, SOURCE);
		await host.touch(file, { save: true });
		const settled = await until(host.readDiagnostics, (files) =>
			files.some((entry) => entry.filePath === file && !entry.pending),
		);
		expect(settled[0]?.diagnostics).toEqual([]);
	});

	// csharp-ls answers only when asked.
	it("asks a server that pulls, on every touch", async () => {
		const { cwd, file } = workspaceWith(`${SOURCE}\nconst x = ERROR;\n`);
		const host = hostFor(cwd, { STUB_PULL: "1" });
		await host.touch(file);
		const held = await until(host.readDiagnostics, (files) =>
			files.some((entry) => !entry.pending && entry.diagnostics.length > 0),
		);
		expect(held[0]?.diagnostics.map((entry) => entry.source)).toEqual(["ts"]);
	});
});

describe("status", () => {
	it("says which server answers for which language", () => {
		const { cwd } = workspaceWith(SOURCE);
		const host = createLspHost({
			cwd,
			servers: [
				stubSpec(cwd),
				{
					name: "absent",
					command: "/nonexistent/server",
					args: [],
					languages: ["go"],
				},
			],
		});
		hosts.push(host);
		expect(
			host.status().map((entry) => [entry.server, entry.installed]),
		).toEqual([
			["stub", true],
			["absent", false],
		]);
	});
});

describe("the HTML server's TypeScript libraries", () => {
	// vscode-langservers-extracted 4.10.0 reads them one node_modules too deep.
	function fakePrefix(withLink: boolean): LspServerSpec {
		const prefix = mkdtempSync(join(tmpdir(), "core-lsp-prefix-"));
		const pkg = join(prefix, "node_modules", "vscode-langservers-extracted");
		mkdirSync(join(pkg, "bin"), { recursive: true });
		const server = join(pkg, "bin", "vscode-html-language-server");
		writeFileSync(server, "");
		mkdirSync(join(prefix, "node_modules", "typescript", "lib"), {
			recursive: true,
		});
		writeFileSync(
			join(prefix, "node_modules", "typescript", "lib", "lib.d.ts"),
			"",
		);
		if (withLink) {
			mkdirSync(join(prefix, "node_modules", "node_modules"));
			symlinkSync(
				join(prefix, "node_modules", "typescript"),
				join(prefix, "node_modules", "node_modules", "typescript"),
			);
		}
		return { command: server, args: ["--stdio"], languages: ["html"] };
	}

	it("finds the gap, and the TypeScript that would fill it", () => {
		const gap = findHtmlServerTypescriptGap(fakePrefix(false));
		expect(gap?.expected).toMatch(
			/node_modules\/node_modules\/typescript\/lib$/,
		);
		expect(gap?.typescript).toMatch(/node_modules\/typescript$/);
	});

	it("is filled by the repair", () => {
		const spec = fakePrefix(false);
		const gap = findHtmlServerTypescriptGap(spec);
		expect(gap && repairHtmlServerTypescript(gap)).toBe(true);
		expect(findHtmlServerTypescriptGap(spec)).toBeUndefined();
	});

	it("says nothing when the libraries are there, or the server is another", () => {
		expect(findHtmlServerTypescriptGap(fakePrefix(true))).toBeUndefined();
		expect(
			findHtmlServerTypescriptGap({
				command: process.execPath,
				args: [],
				languages: ["html"],
			}),
		).toBeUndefined();
	});
});
