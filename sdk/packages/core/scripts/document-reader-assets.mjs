/**
 * The Document Reader's data files, for a host that bundles core.
 *
 *   dist/pdfjs/wasm/      pdf.js's CCITT, JBIG2 and JPEG 2000 decoders (0.5 MB)
 *   dist/pdfjs/cmaps/     character maps for CJK text (1.7 MB)
 *   dist/tesseract/       tesseract's worker, bundled on its own, and its core (5.7 MB)
 *   dist/tessdata/        the English model, tessdata best_int (3 MB)
 *
 * Core looks for each beside itself first (`executors/document/assets.ts`),
 * which after bundling is `dist/`. Each is copied from the package that ships
 * it, at the version core depends on, so the decoders always match the pdf.js
 * that loads them.
 *
 * Only two of tesseract's six cores are shipped: the SIMD and plain LSTM
 * builds. The worker picks relaxed SIMD where the runtime has it, and the
 * legacy (non-LSTM) builds for an engine mode core never asks for; both are
 * pointed at the shipped pair when the worker is bundled, which saves 11 MB.
 *
 * Missing packages are not fatal: the tool then says scanned pages cannot be
 * read, and every other format still works.
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function packageDir(from, name) {
	try {
		return dirname(
			createRequire(join(from, "package.json")).resolve(`${name}/package.json`),
		);
	} catch {
		return undefined;
	}
}

function sizeOf(path) {
	const stat = statSync(path);
	if (!stat.isDirectory()) return stat.size;
	return readdirSync(path).reduce(
		(total, name) => total + sizeOf(join(path, name)),
		0,
	);
}

/**
 * @param {string} destDir the bundle's output directory
 * @param {{ esbuild: { build: (options: object) => Promise<unknown> }, log?: (line: string) => void }} options
 *   `esbuild` is esbuild, or anything with its `build(options)`: the CLI passes
 *   an adapter over `Bun.build`, which takes the same plugin shape.
 */
export async function writeDocumentReaderAssets(
	destDir,
	{ esbuild, log = console.log },
) {
	const pdfjs = packageDir(coreDir, "pdfjs-dist");
	if (pdfjs) {
		const wasmInto = join(destDir, "pdfjs", "wasm");
		mkdirSync(wasmInto, { recursive: true });
		for (const name of readdirSync(join(pdfjs, "wasm"))) {
			if (/^(jbig2|openjpeg|qcms_bg)\.wasm$|^LICENSE_/.test(name)) {
				copyFileSync(join(pdfjs, "wasm", name), join(wasmInto, name));
			}
		}
		cpSync(join(pdfjs, "cmaps"), join(destDir, "pdfjs", "cmaps"), {
			recursive: true,
		});
		log(
			`[documents] pdf.js decoders and cmaps: ${(sizeOf(join(destDir, "pdfjs")) / 1048576).toFixed(1)} MB`,
		);
	} else {
		log(
			"[documents] pdfjs-dist not found; CCITT/JBIG2/JPEG 2000 scans will not decode",
		);
	}

	const tesseract = packageDir(coreDir, "tesseract.js");
	const tesseractCore = tesseract && packageDir(tesseract, "tesseract.js-core");
	if (tesseract && tesseractCore) {
		const into = join(destDir, "tesseract");
		mkdirSync(into, { recursive: true });
		/** @type {import("esbuild").Plugin} */
		const shippedCores = {
			name: "tesseract-shipped-cores",
			setup(build) {
				build.onResolve(
					{ filter: /^tesseract\.js-core\/tesseract-core/ },
					(args) => {
						const simd = /simd/.test(args.path);
						return {
							path: join(
								tesseractCore,
								simd ? "tesseract-core-simd-lstm.js" : "tesseract-core-lstm.js",
							),
						};
					},
				);
			},
		};
		await esbuild.build({
			entryPoints: [
				join(tesseract, "src", "worker-script", "node", "index.js"),
			],
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node20",
			minify: true,
			outfile: join(into, "worker.cjs"),
			// Only reached where the runtime has no fetch, which no supported one lacks.
			external: ["node-fetch"],
			plugins: [shippedCores],
			logLevel: "warning",
		});
		for (const name of [
			"tesseract-core-simd-lstm.wasm",
			"tesseract-core-lstm.wasm",
			"LICENSE",
		]) {
			copyFileSync(
				join(tesseractCore, name),
				join(into, name === "LICENSE" ? "LICENSE-tesseract-core" : name),
			);
		}
		copyFileSync(
			join(tesseract, "LICENSE.md"),
			join(into, "LICENSE-tesseract.js.md"),
		);
		log(
			`[documents] tesseract worker and cores: ${(sizeOf(into) / 1048576).toFixed(1)} MB`,
		);
	} else {
		log(
			"[documents] tesseract.js not found; scanned pages will not be recognized on this machine",
		);
	}

	const english = packageDir(coreDir, "@tesseract.js-data/eng");
	const model =
		english && join(english, "4.0.0_best_int", "eng.traineddata.gz");
	if (model && existsSync(model)) {
		mkdirSync(join(destDir, "tessdata"), { recursive: true });
		copyFileSync(model, join(destDir, "tessdata", "eng.traineddata.gz"));
		log(
			`[documents] English OCR model: ${(statSync(model).size / 1048576).toFixed(1)} MB`,
		);
	} else {
		log(
			"[documents] English OCR model not found; tesseract will have no language to read with",
		);
	}
}
