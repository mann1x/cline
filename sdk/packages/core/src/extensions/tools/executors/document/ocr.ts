/**
 * Text recognition with tesseract (tesseract.js, WebAssembly, in a worker
 * thread), and the language models it reads with.
 *
 * English ships with the tool (tessdata best_int, 3 MB). Every other language
 * is installed on request into one folder under the data directory, from the
 * same CDN tesseract.js itself defaults to, so a session never downloads
 * anything the user did not ask for.
 */

import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import { resolveBundledTessdata, resolveTesseractWorker } from "./assets";

/** How scanned pages are read. `vision` is the Vision tab's model. */
export type OcrEngine = "tesseract" | "vision" | "off";

/** The user's Document Reader settings, as the host hands them over. */
export interface DocumentReaderSettings {
	/** @default "tesseract" */
	ocr?: OcrEngine;
	/** tesseract language codes. @default ["eng"] */
	ocrLanguages?: readonly string[];
	/** Where installed languages live. @default <data dir>/tessdata */
	ocrDataDir?: string;
	/** Describe extracted pictures with the vision model. @default false */
	describePictures?: boolean;
}

export const BUNDLED_OCR_LANGUAGE = "eng";
const MODEL_SUFFIX = ".traineddata.gz";
/** tesseract's codes: `deu`, `chi_sim`, `chi_tra_vert`, `deu_latf`, `osd`. */
const LANGUAGE_CODE = /^[a-z]{3}(?:_[a-z]{2,8})*$/;

export function resolveOcrDataDir(): string {
	return join(resolveClineDataDir(), "tessdata");
}

/** Codes from a setting or a tool call: "eng+deu", "eng, deu", or a list. */
export function parseOcrLanguages(
	input: string | readonly string[] | undefined | null,
): string[] {
	const raw =
		typeof input === "string" ? input.split(/[+,\s]+/) : (input ?? []);
	const codes = raw.map((code) => code.trim().toLowerCase()).filter(Boolean);
	return [...new Set(codes)];
}

export function isOcrLanguageCode(code: string): boolean {
	return LANGUAGE_CODE.test(code);
}

/** Where a language is downloaded from: tessdata best_int, as tesseract.js's own default. */
export function ocrLanguageSource(code: string): string {
	return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}/4.0.0_best_int/${code}${MODEL_SUFFIX}`;
}

/** The languages that can be read with now: installed ones, and English. */
export async function installedOcrLanguages(
	dataDir: string = resolveOcrDataDir(),
): Promise<string[]> {
	const names = await readdir(dataDir).catch(() => [] as string[]);
	const installed = names
		.filter((name) => name.endsWith(MODEL_SUFFIX))
		.map((name) => name.slice(0, -MODEL_SUFFIX.length));
	if (resolveBundledTessdata()) installed.push(BUNDLED_OCR_LANGUAGE);
	return [...new Set(installed)].sort();
}

export interface OcrInstallResult {
	installed: string[];
	failed: { language: string; reason: string }[];
}

/**
 * Download the languages not installed yet. English is never downloaded: it
 * ships with the tool.
 *
 * Written to a partial file and renamed, so an interrupted download is never
 * taken for a model, and checked for gzip's magic bytes, so an error page
 * served with status 200 is not either.
 */
export async function installOcrLanguages(
	languages: readonly string[],
	options: {
		dataDir?: string;
		fetch?: typeof fetch;
		signal?: AbortSignal;
	} = {},
): Promise<OcrInstallResult> {
	const dataDir = options.dataDir ?? resolveOcrDataDir();
	const fetchImpl = options.fetch ?? fetch;
	const result: OcrInstallResult = { installed: [], failed: [] };
	for (const language of parseOcrLanguages(languages)) {
		if (!isOcrLanguageCode(language)) {
			result.failed.push({ language, reason: "not a tesseract language code" });
			continue;
		}
		const target = join(dataDir, `${language}${MODEL_SUFFIX}`);
		if (existsSync(target)) continue;
		if (language === BUNDLED_OCR_LANGUAGE && resolveBundledTessdata()) continue;
		try {
			const response = await fetchImpl(ocrLanguageSource(language), {
				signal: options.signal,
			});
			if (!response.ok) {
				throw new Error(
					response.status === 404
						? "tesseract has no model for this code"
						: `download failed with HTTP ${response.status}`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes.byteLength < 10_000) {
				throw new Error("the download is not a language model");
			}
			await mkdir(dataDir, { recursive: true });
			const partial = `${target}.part`;
			await writeFile(partial, bytes);
			await rename(partial, target);
			result.installed.push(language);
		} catch (error) {
			await rm(`${target}.part`, { force: true }).catch(() => {});
			result.failed.push({
				language,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

/**
 * The one folder tesseract reads every requested language from.
 *
 * English alone reads from the bundle. Any mix reads from the data directory,
 * with English copied in beside the others once, since tesseract takes a
 * single folder for all of them.
 */
async function languageFolder(
	languages: readonly string[],
	dataDir: string,
): Promise<string> {
	const bundled = resolveBundledTessdata();
	if (bundled && languages.every((code) => code === BUNDLED_OCR_LANGUAGE)) {
		return bundled;
	}
	const missing = languages.filter(
		(code) =>
			!existsSync(join(dataDir, `${code}${MODEL_SUFFIX}`)) &&
			!(code === BUNDLED_OCR_LANGUAGE && bundled),
	);
	if (missing.length > 0) {
		throw new OcrLanguageMissingError(missing);
	}
	const english = join(dataDir, `${BUNDLED_OCR_LANGUAGE}${MODEL_SUFFIX}`);
	if (
		bundled &&
		languages.includes(BUNDLED_OCR_LANGUAGE) &&
		!existsSync(english)
	) {
		await mkdir(dataDir, { recursive: true });
		await copyFile(
			join(bundled, `${BUNDLED_OCR_LANGUAGE}${MODEL_SUFFIX}`),
			english,
		);
	}
	return dataDir;
}

export class OcrLanguageMissingError extends Error {
	constructor(readonly languages: readonly string[]) {
		super(
			`OCR language${languages.length === 1 ? "" : "s"} ${languages.join(", ")} ${languages.length === 1 ? "is" : "are"} not installed.`,
		);
	}
}

type TesseractWorker = Awaited<
	ReturnType<typeof import("tesseract.js")["createWorker"]>
>;

/** How long one page may take: a full page is seconds, a dense one tens. */
const RECOGNIZE_LIMIT_MS = 180_000;
/** How long starting the worker may take: it loads a 10 MB language model. */
const OPEN_LIMIT_MS = 120_000;
const CLOSE_LIMIT_MS = 10_000;

/**
 * A promise with a limit. tesseract runs in a worker thread, and a worker
 * that dies (out of memory, most often) answers nothing: the call it was
 * serving stays open for good.
 */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${what} gave no answer in ${ms / 1000}s`)),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

/** One tesseract worker, for every page of one call. */
export class TesseractReader {
	/** Why the worker is gone, once it is: nothing more is asked of it. */
	private dead: Error | undefined;

	private constructor(
		private readonly worker: TesseractWorker,
		readonly languages: readonly string[],
		private readonly failure: { error?: Error; raise?: (error: Error) => void },
	) {}

	static async open(
		languages: readonly string[],
		dataDir: string = resolveOcrDataDir(),
	): Promise<TesseractReader> {
		const langPath = await languageFolder(languages, dataDir);
		// CommonJS: under Bun the ESM wrapper's named exports can be undefined.
		const loaded = await import("tesseract.js");
		const tesseract =
			(loaded as unknown as { default?: typeof loaded }).default ?? loaded;
		const workerPath = resolveTesseractWorker();
		const failure: { error?: Error; raise?: (error: Error) => void } = {};
		const worker = await within(
			tesseract.createWorker(languages.join("+"), tesseract.OEM.LSTM_ONLY, {
				langPath,
				gzip: true,
				// Not "write", the default: it caches each model into the process's
				// working directory, which here is the user's workspace.
				cacheMethod: "none",
				...(workerPath ? { workerPath } : {}),
				// The worker's own errors arrive here and nowhere else: without
				// this the page being read would wait on a worker that is gone.
				errorHandler: (problem: unknown) => {
					const error =
						problem instanceof Error
							? problem
							: new Error(`the OCR worker failed: ${String(problem)}`);
					failure.error = error;
					failure.raise?.(error);
				},
			}),
			OPEN_LIMIT_MS,
			"Starting the OCR worker",
		);
		return new TesseractReader(worker, languages, failure);
	}

	async recognize(
		png: Uint8Array,
	): Promise<{ text: string; confidence: number }> {
		if (this.dead) throw this.dead;
		if (this.failure.error) {
			this.dead = this.failure.error;
			throw this.dead;
		}
		try {
			const { data } = await within(
				Promise.race([
					this.worker.recognize(Buffer.from(png)),
					new Promise<never>((_resolve, reject) => {
						this.failure.raise = reject;
					}),
				]),
				RECOGNIZE_LIMIT_MS,
				"The OCR worker",
			);
			return {
				text: data.text ?? "",
				confidence: Math.round(data.confidence ?? 0),
			};
		} catch (error) {
			// One page that fails to read is the worker's answer and it goes on.
			// A worker that is silent or gone is not asked again: every later
			// page would wait out the same limit.
			if (
				this.failure.error ||
				(error instanceof Error && /gave no answer/.test(error.message))
			) {
				this.dead = error instanceof Error ? error : new Error(String(error));
			}
			throw error;
		} finally {
			this.failure.raise = undefined;
		}
	}

	async close(): Promise<void> {
		await within(
			this.worker.terminate(),
			CLOSE_LIMIT_MS,
			"Stopping the OCR worker",
		).catch(() => {});
	}
}
