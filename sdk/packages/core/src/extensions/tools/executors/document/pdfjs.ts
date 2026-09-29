/**
 * pdf.js, from `pdfjs-dist`'s legacy build, run in this thread.
 *
 * Not unpdf's "serverless" build, which this reader used first: to be
 * dependency-free, that build replaces pdf.js's WebAssembly decoders with
 * stubs, so every CCITT, JBIG2 and JPEG 2000 image fails to decode ("JBig2
 * failed to initialize"). Those are how most scanners and archives store a
 * page, which made it useless for the one job OCR needs it for: getting the
 * page image out.
 */

import { sep } from "node:path";
import { resolvePdfjsCmapDirectory, resolvePdfjsWasmDirectory } from "./assets";

export type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<Pdfjs> | undefined;

/**
 * Loaded on first use: pdf.js is megabytes of code that a session which never
 * reads a PDF should not pay for at startup.
 *
 * The worker's code is put on `globalThis.pdfjsWorker`, which pdf.js checks
 * before starting a worker: it then runs in this thread, with no worker file
 * to find, which is what lets it be bundled.
 */
export function loadPdfjs(): Promise<Pdfjs> {
	loading ??= (async () => {
		installDomMatrix();
		const host = globalThis as { pdfjsWorker?: unknown };
		if (!host.pdfjsWorker) {
			host.pdfjsWorker = await import(
				// @ts-expect-error -- the worker build ships without declarations
				"pdfjs-dist/legacy/build/pdf.worker.mjs"
			);
		}
		return await quietly(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
	})();
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}

/**
 * Run pdf.js's module setup without its canvas warnings.
 *
 * On load it looks for `@napi-rs/canvas` to draw with and says, on the
 * console, that it cannot find it and cannot polyfill `Path2D`. Nothing here
 * draws, so both lines are noise in the host's log on every first PDF; they
 * are printed before any verbosity option can be passed, hence the filter.
 */
async function quietly<T>(load: () => Promise<T>): Promise<T> {
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		const first = String(args[0] ?? "");
		if (
			/^Warning: Cannot (load "@napi-rs\/canvas"|polyfill `(Path2D|DOMMatrix|ImageData)`)/.test(
				first,
			)
		)
			return;
		original(...args);
	};
	try {
		return await load();
	} finally {
		console.warn = original;
	}
}

/**
 * A 2D `DOMMatrix`, for a runtime without one.
 *
 * pdf.js builds one when its module loads (`SCALE_MATRIX = new DOMMatrix()`),
 * and in Node it gets the class from `@napi-rs/canvas`, a native package the
 * extension does not ship. Without either the import throws "DOMMatrix is not
 * defined" -- measured on the bundled build, where the lab had found the
 * package in `node_modules` and passed. Text and operator lists never draw, so
 * the affine subset pdf.js calls is all that is needed.
 */
function installDomMatrix(): void {
	const host = globalThis as { DOMMatrix?: unknown };
	if (host.DOMMatrix) return;
	class AffineMatrix {
		a = 1;
		b = 0;
		c = 0;
		d = 1;
		e = 0;
		f = 0;
		constructor(init?: ArrayLike<number>) {
			if (init && init.length >= 6) {
				[this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(
					init,
				).slice(0, 6) as [number, number, number, number, number, number];
			}
		}
		private set(m: readonly number[]): this {
			[this.a, this.b, this.c, this.d, this.e, this.f] = m as [
				number,
				number,
				number,
				number,
				number,
				number,
			];
			return this;
		}
		private product(l: AffineMatrix, r: AffineMatrix): number[] {
			return [
				l.a * r.a + l.c * r.b,
				l.b * r.a + l.d * r.b,
				l.a * r.c + l.c * r.d,
				l.b * r.c + l.d * r.d,
				l.a * r.e + l.c * r.f + l.e,
				l.b * r.e + l.d * r.f + l.f,
			];
		}
		multiplySelf(
			other: ArrayLike<number> | AffineMatrix = new AffineMatrix(),
		): this {
			const r = other instanceof AffineMatrix ? other : new AffineMatrix(other);
			return this.set(this.product(this, r));
		}
		preMultiplySelf(
			other: ArrayLike<number> | AffineMatrix = new AffineMatrix(),
		): this {
			const l = other instanceof AffineMatrix ? other : new AffineMatrix(other);
			return this.set(this.product(l, this));
		}
		multiply(other?: ArrayLike<number> | AffineMatrix): AffineMatrix {
			return new AffineMatrix(this.toArray()).multiplySelf(other);
		}
		translateSelf(x = 0, y = 0): this {
			return this.multiplySelf([1, 0, 0, 1, x, y]);
		}
		translate(x = 0, y = 0): AffineMatrix {
			return new AffineMatrix(this.toArray()).translateSelf(x, y);
		}
		scaleSelf(x = 1, y = x): this {
			return this.multiplySelf([x, 0, 0, y, 0, 0]);
		}
		scale(x = 1, y = x): AffineMatrix {
			return new AffineMatrix(this.toArray()).scaleSelf(x, y);
		}
		invertSelf(): this {
			const det = this.a * this.d - this.b * this.c;
			if (!det)
				return this.set([
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
					Number.NaN,
				]);
			return this.set([
				this.d / det,
				-this.b / det,
				-this.c / det,
				this.a / det,
				(this.c * this.f - this.d * this.e) / det,
				(this.b * this.e - this.a * this.f) / det,
			]);
		}
		inverse(): AffineMatrix {
			return new AffineMatrix(this.toArray()).invertSelf();
		}
		toArray(): number[] {
			return [this.a, this.b, this.c, this.d, this.e, this.f];
		}
	}
	host.DOMMatrix = AffineMatrix;
}

function asDirectoryUrl(directory: string | undefined): string | undefined {
	// pdf.js appends a file name to these, so the separator must be there.
	return directory ? `${directory.replace(/[\\/]+$/, "")}${sep}` : undefined;
}

/** What every document is opened with: decoders and character maps found. */
export function pdfjsDocumentOptions(): Record<string, unknown> {
	const wasmUrl = asDirectoryUrl(resolvePdfjsWasmDirectory());
	const cMapUrl = asDirectoryUrl(resolvePdfjsCmapDirectory());
	return {
		// Font data is needed only to draw glyphs; text extraction reads the
		// mapping without it.
		disableFontFace: true,
		useSystemFonts: false,
		isEvalSupported: false,
		// Errors only: a malformed but readable PDF warns on every page.
		verbosity: 0,
		...(wasmUrl ? { wasmUrl } : {}),
		...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
	};
}
