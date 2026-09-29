/**
 * The vendored office_oxide module (`scripts/build-office-oxide.sh`).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, WasmDocument } from "./office-oxide.generated";

const WASM_FILE = "office_oxide_bg.wasm";

export interface OfficeOxideDocument {
	toMarkdownWithImages(): string;
	plainText(): string;
	free(): void;
}

let loaded = false;

/**
 * Where the module is. Two places, in the order a host would want.
 *
 * Beside the bundle is the shipped case: the extension's build copies it to
 * `dist/office-oxide/`, as it does the tree-sitter grammars. Otherwise it is
 * core's own `assets/`, found by walking up from this module: one level from
 * `dist/`, five from this file in `src/`.
 */
export function resolveOfficeOxideWasm(
	besideDir: string = moduleDirectory(),
): string | undefined {
	const beside = join(besideDir, "office-oxide", WASM_FILE);
	if (existsSync(beside)) return beside;
	let dir = besideDir;
	for (let depth = 0; depth < 7; depth++) {
		const candidate = join(dir, "assets", "office-oxide", WASM_FILE);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function moduleDirectory(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return ".";
	}
}

/** Open a legacy Office file. Throws with a sentence when the module is missing. */
export function openOfficeOxide(
	data: Uint8Array,
	format: "doc" | "xls" | "ppt" | "docx" | "xlsx" | "pptx",
): OfficeOxideDocument {
	if (!loaded) {
		const wasm = resolveOfficeOxideWasm();
		if (!wasm) {
			throw new Error(
				"The reader for Word, Excel and PowerPoint 97-2003 files is missing from this installation (office_oxide_bg.wasm was not found).",
			);
		}
		initSync({ module: readFileSync(wasm) });
		loaded = true;
	}
	return new WasmDocument(data, format) as OfficeOxideDocument;
}
