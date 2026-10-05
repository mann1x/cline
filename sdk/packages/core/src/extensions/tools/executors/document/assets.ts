/**
 * Where the document readers' data files are: pdf.js's decoders and
 * character maps, tesseract's worker and core, and the bundled English model.
 *
 * Each is looked for beside the bundle first, which is where the extension's
 * and the CLI's builds copy them, and then in the npm package it ships in,
 * which is the case for tests and for an embedder using core from
 * `node_modules`.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function moduleDirectory(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return ".";
	}
}

function packageDirectory(name: string): string | undefined {
	try {
		const require = createRequire(join(moduleDirectory(), "noop.js"));
		return dirname(require.resolve(`${name}/package.json`));
	} catch {
		return undefined;
	}
}

/**
 * A directory beside the bundle, or inside a package. `probe` is a file the
 * directory must contain to count, so an empty folder left by a failed copy
 * is not taken for the real one.
 */
function resolveAssetDirectory(
	beside: string,
	pkg: string,
	inside: string,
	probe: string,
): string | undefined {
	const bundled = join(moduleDirectory(), beside);
	if (existsSync(join(bundled, probe))) return bundled;
	const root = packageDirectory(pkg);
	const packaged = root ? join(root, inside) : undefined;
	return packaged && existsSync(join(packaged, probe)) ? packaged : undefined;
}

/** pdf.js's CCITT, JBIG2 and JPEG 2000 decoders, and its colour management. */
export function resolvePdfjsWasmDirectory(): string | undefined {
	return resolveAssetDirectory(
		"pdfjs/wasm",
		"pdfjs-dist",
		"wasm",
		"jbig2.wasm",
	);
}

/** pdf.js's character maps, which CJK text needs to decode. */
export function resolvePdfjsCmapDirectory(): string | undefined {
	return resolveAssetDirectory(
		"pdfjs/cmaps",
		"pdfjs-dist",
		"cmaps",
		// A file pdf.js ships: `Identity-H` is built in and has no file, and
		// probing for it meant the maps were never found.
		"UniJIS-UCS2-H.bcmap",
	);
}

/**
 * tesseract's worker, bundled on its own because it runs in a worker thread.
 * Undefined means the package's own, which is right when core runs from
 * `node_modules`.
 */
export function resolveTesseractWorker(): string | undefined {
	// `.cjs`: a bundle's folder may be an ES module package (the CLI's is), where
	// a `.js` worker would be loaded as a module with no `require`.
	const bundled = join(moduleDirectory(), "tesseract", "worker.cjs");
	return existsSync(bundled) ? bundled : undefined;
}

/** The English model that ships with the tool (tessdata best_int). */
export function resolveBundledTessdata(): string | undefined {
	return resolveAssetDirectory(
		"tessdata",
		"@tesseract.js-data/eng",
		"4.0.0_best_int",
		"eng.traineddata.gz",
	);
}
