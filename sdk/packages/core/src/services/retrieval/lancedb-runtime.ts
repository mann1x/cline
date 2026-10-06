/**
 * LanceDB, fetched when it is first needed.
 *
 * The vector index of the Library is LanceDB, whose native library is 200 to
 * 390 MB depending on the platform. That cannot ship in the extension, so it
 * is downloaded once into the data folder, the way OCR languages are: the
 * JavaScript packages and the one native package for this machine, straight
 * from the npm registry, each checked against the integrity pinned in
 * `lancedb-runtime.manifest.ts` before anything is used.
 *
 * Keyword search does not depend on any of this.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	LANCEDB_RUNTIME_MANIFEST,
	type LanceDbRuntimeManifest,
	type LanceDbRuntimePackage,
} from "./lancedb-runtime.manifest";
import { extractTarGz } from "./tar-extract";

const MARKER = ".installed.json";

export interface LanceDbInstallProgress {
	/** The package being fetched, and how many there are. */
	packageIndex: number;
	packageCount: number;
	path: string;
	/** Bytes of this package received so far, and its size when the server said. */
	receivedBytes: number;
	totalBytes?: number;
}

export interface LanceDbRuntimeOptions {
	/** The folder runtimes are kept in, e.g. `<data>/runtimes/lancedb`. */
	directory: string;
	manifest?: LanceDbRuntimeManifest;
	fetch?: typeof fetch;
	onProgress?: (progress: LanceDbInstallProgress) => void;
	signal?: AbortSignal;
	/** For tests: the platform key to install for. */
	platformKey?: string;
}

export interface LanceDbRuntime {
	/** The `@lancedb/lancedb` module. */
	// biome-ignore lint/suspicious/noExplicitAny: a module loaded at run time, typed where it is used
	lancedb: any;
	/** The `apache-arrow` module LanceDB was installed with. */
	// biome-ignore lint/suspicious/noExplicitAny: as above
	arrow: any;
	version: string;
	root: string;
}

export class LanceDbUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LanceDbUnavailableError";
	}
}

/** `linux-x64-gnu`, `win32-x64`, `darwin-arm64`: the key into the manifest. */
export function currentPlatformKey(): string {
	const base = `${process.platform}-${process.arch}`;
	if (process.platform !== "linux") {
		return base;
	}
	// glibc reports its version; musl has none to report.
	const report = (
		process as unknown as {
			report?: {
				getReport?: () => { header?: { glibcVersionRuntime?: string } };
			};
		}
	).report?.getReport?.();
	return `${base}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

export function lanceDbRuntimeRoot(
	options: Pick<LanceDbRuntimeOptions, "directory" | "manifest">,
): string {
	return join(
		options.directory,
		(options.manifest ?? LANCEDB_RUNTIME_MANIFEST).version,
	);
}

export function isLanceDbInstalled(
	options: Pick<LanceDbRuntimeOptions, "directory" | "manifest">,
): boolean {
	return existsSync(join(lanceDbRuntimeRoot(options), MARKER));
}

/** Why LanceDB cannot run here, or undefined when it can. */
export function lanceDbUnsupportedReason(
	options: Pick<LanceDbRuntimeOptions, "manifest" | "platformKey"> = {},
): string | undefined {
	const manifest = options.manifest ?? LANCEDB_RUNTIME_MANIFEST;
	const key = options.platformKey ?? currentPlatformKey();
	if (!manifest.platforms[key]) {
		return `LanceDB ${manifest.version} is not published for ${key}. Keyword search still works.`;
	}
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (major < 22) {
		return `LanceDB needs Node 22 or newer, and this runs on ${process.versions.node}. Keyword search still works.`;
	}
	return undefined;
}

/** How much will be downloaded and unpacked for this platform, when known. */
export function lanceDbInstallBytes(
	options: Pick<LanceDbRuntimeOptions, "manifest" | "platformKey"> = {},
): number | undefined {
	const manifest = options.manifest ?? LANCEDB_RUNTIME_MANIFEST;
	return manifest.platforms[options.platformKey ?? currentPlatformKey()]
		?.unpackedBytes;
}

async function fetchPackage(
	entry: LanceDbRuntimePackage,
	root: string,
	options: LanceDbRuntimeOptions,
	index: number,
	count: number,
): Promise<void> {
	const send = options.fetch ?? fetch;
	const response = await send(entry.tarball, { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new LanceDbUnavailableError(
			`${entry.tarball} answered ${response.status}.`,
		);
	}
	const [algorithm, expected] = entry.integrity.split("-", 2);
	const hash = createHash(algorithm);
	const total = Number(response.headers.get("content-length")) || undefined;
	let received = 0;
	const body = response.body as unknown as AsyncIterable<Uint8Array>;
	async function* tee(): AsyncGenerator<Uint8Array> {
		for await (const chunk of body) {
			hash.update(chunk);
			received += chunk.length;
			options.onProgress?.({
				packageIndex: index,
				packageCount: count,
				path: entry.path,
				receivedBytes: received,
				totalBytes: total,
			});
			yield chunk;
		}
	}
	await extractTarGz(tee(), join(root, entry.path));
	if (hash.digest("base64") !== expected) {
		throw new LanceDbUnavailableError(
			`${entry.tarball} does not match its recorded integrity; nothing from it was kept.`,
		);
	}
}

/**
 * Download and unpack LanceDB for this machine, unless it is already there.
 * Everything lands in a folder of its own first and is moved into place only
 * when every package has been verified, so an interrupted or failed install
 * leaves nothing that looks installed.
 */
export async function installLanceDb(
	options: LanceDbRuntimeOptions,
): Promise<string> {
	const manifest = options.manifest ?? LANCEDB_RUNTIME_MANIFEST;
	const root = lanceDbRuntimeRoot(options);
	if (isLanceDbInstalled(options)) {
		return root;
	}
	const reason = lanceDbUnsupportedReason(options);
	if (reason) {
		throw new LanceDbUnavailableError(reason);
	}
	const key = options.platformKey ?? currentPlatformKey();
	const entries = [...manifest.packages, manifest.platforms[key]];
	mkdirSync(options.directory, { recursive: true });
	const staging = `${root}.partial-${process.pid}-${Date.now()}`;
	rmSync(staging, { recursive: true, force: true });
	try {
		mkdirSync(staging, { recursive: true });
		writeFileSync(
			join(staging, "package.json"),
			`${JSON.stringify({ name: "cerebriline-lancedb-runtime", private: true }, null, "\t")}\n`,
		);
		for (const [index, entry] of entries.entries()) {
			await fetchPackage(entry, staging, options, index, entries.length);
		}
		writeFileSync(
			join(staging, MARKER),
			`${JSON.stringify({ version: manifest.version, arrow: manifest.arrow, platform: key, installedAt: new Date().toISOString() }, null, "\t")}\n`,
		);
		try {
			renameSync(staging, root);
		} catch (error) {
			// Another process finished first: theirs is as good as ours.
			if (!isLanceDbInstalled(options)) throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return root;
}

const loaded = new Map<string, LanceDbRuntime>();

/** Load an installed LanceDB. Throws `LanceDbUnavailableError` when it is not installed. */
export function loadLanceDb(
	options: Pick<LanceDbRuntimeOptions, "directory" | "manifest">,
): LanceDbRuntime {
	const root = lanceDbRuntimeRoot(options);
	const cached = loaded.get(root);
	if (cached) {
		return cached;
	}
	if (!isLanceDbInstalled(options)) {
		throw new LanceDbUnavailableError(
			"LanceDB is not installed yet. It is downloaded the first time vector search is turned on.",
		);
	}
	const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as {
		version: string;
	};
	const require = createRequire(join(root, "package.json"));
	try {
		const runtime: LanceDbRuntime = {
			lancedb: require("@lancedb/lancedb"),
			arrow: require("apache-arrow"),
			version: marker.version,
			root,
		};
		loaded.set(root, runtime);
		return runtime;
	} catch (error) {
		throw new LanceDbUnavailableError(
			`LanceDB at ${root} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Install if needed, then load. */
export async function ensureLanceDb(
	options: LanceDbRuntimeOptions,
): Promise<LanceDbRuntime> {
	await installLanceDb(options);
	return loadLanceDb(options);
}
