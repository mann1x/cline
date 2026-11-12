import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HostFileDiagnostics } from "../diagnostics/types";
import {
	createLspHost,
	DEFAULT_LSP_SERVERS,
	isServerInstalled,
} from "./lsp-host";

/**
 * The default servers, for real. Run with CORE_LSP_LIVE=1 on a machine that
 * has them on PATH (`npm i -g typescript typescript-language-server
 * vscode-langservers-extracted`); each case skips a server that is missing.
 */
const live = process.env.CORE_LSP_LIVE === "1";
const has = (name: string) =>
	DEFAULT_LSP_SERVERS.some(
		(spec) => spec.name === name && isServerInstalled(spec),
	);

const cwd = mkdtempSync(join(tmpdir(), "core-lsp-live-"));
const host = createLspHost({ cwd });
afterAll(() => host.dispose());

async function settledFor(
	filePath: string,
): Promise<HostFileDiagnostics | undefined> {
	const deadline = Date.now() + 20_000;
	let last: HostFileDiagnostics | undefined;
	while (Date.now() < deadline) {
		last = (await host.readDiagnostics()).find(
			(entry) => entry.filePath === filePath,
		);
		if (last && !last.pending && last.diagnostics.length > 0) {
			return last;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return last;
}

describe.skipIf(!live)("default language servers, live", () => {
	it.skipIf(!has("typescript-language-server"))(
		"reports a type error from tsserver as ts",
		async () => {
			const file = join(cwd, "broken.ts");
			writeFileSync(file, "const n: number = 'text';\n");
			await host.touch(file);
			const held = await settledFor(file);
			expect(held?.diagnostics[0]?.source).toBe("ts");
			expect(held?.diagnostics[0]?.severity).toBe("error");
		},
		30_000,
	);

	// Answered with null, workspace/configuration crashed the CSS validator,
	// which aborted the whole page's validation: a page whose script does not
	// parse reported nothing.
	it.skipIf(!has("vscode-html-language-server"))(
		"reports a page whose script does not parse",
		async () => {
			const file = join(cwd, "page.html");
			writeFileSync(
				file,
				"<!doctype html><html><head><style>body { color: red; }</style></head><body><script>\nfunction f( {\n</script></body></html>\n",
			);
			await host.touch(file);
			const held = await settledFor(file);
			expect(held?.diagnostics.length ?? 0).toBeGreaterThan(0);
		},
		30_000,
	);

	it.skipIf(!has("vscode-css-language-server"))(
		"reports a broken stylesheet",
		async () => {
			const file = join(cwd, "style.css");
			writeFileSync(file, "body { color: red;\n");
			await host.touch(file);
			const held = await settledFor(file);
			expect(held?.diagnostics.length ?? 0).toBeGreaterThan(0);
		},
		30_000,
	);

	it.skipIf(!has("vscode-json-language-server"))(
		"reports broken JSON",
		async () => {
			const file = join(cwd, "data.json");
			writeFileSync(file, '{ "a": 1, }\n');
			await host.touch(file);
			const held = await settledFor(file);
			expect(held?.diagnostics.length ?? 0).toBeGreaterThan(0);
		},
		30_000,
	);

	it.skipIf(!has("clangd"))(
		"reports a C error from clangd",
		async () => {
			const file = join(cwd, "main.c");
			writeFileSync(file, "int main(void) { return undefined_name; }\n");
			await host.touch(file);
			const held = await settledFor(file);
			expect(held?.diagnostics.length ?? 0).toBeGreaterThan(0);
		},
		30_000,
	);

	it.skipIf(!has("typescript-language-server"))(
		"hovers what the file now says after an edit",
		async () => {
			const file = join(cwd, "edited.ts");
			writeFileSync(file, "export const value = 1;\n");
			const first = await host.provider.hover({
				filePath: file,
				line: 0,
				character: 14,
			});
			writeFileSync(file, "export const value = 'one';\n");
			const second = await host.provider.hover({
				filePath: file,
				line: 0,
				character: 14,
			});
			expect(first).toMatch(/1/);
			expect(second).toMatch(/one|string/);
		},
		30_000,
	);
});
