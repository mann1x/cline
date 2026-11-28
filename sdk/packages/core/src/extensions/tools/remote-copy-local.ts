/**
 * The local half of `remote_copy`: keeping local paths inside the workspace,
 * packing a folder for upload, and unpacking a download without letting the
 * archive write anywhere it should not. Archives are gzipped tar: every Open
 * Terminal machine has `tar`, and so does this package.
 */

import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { create, extract, list } from "tar";

/** What one transfer may move, either way: archives are held in memory. */
export const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024;

/** Left out of an uploaded folder unless the call names its own list. */
export const DEFAULT_UPLOAD_EXCLUDES = [".git", "node_modules"];

function samePathCase(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function isInside(root: string, path: string): boolean {
	const r = samePathCase(root);
	const p = samePathCase(path);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * `given` as an absolute local path inside `root`, or an error. Relative paths
 * start at `root`. Links are followed for the part that exists, so a link in
 * the workspace cannot lead the copy out of it.
 */
export async function resolveLocalPath(
	root: string,
	given: string,
): Promise<string> {
	const rootReal = await realpath(root);
	const wanted = isAbsolute(given) ? resolve(given) : resolve(rootReal, given);
	let existing = wanted;
	const rest: string[] = [];
	for (;;) {
		try {
			await lstat(existing);
			break;
		} catch {
			const parent = dirname(existing);
			if (parent === existing) break;
			rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
			existing = parent;
		}
	}
	const real = join(await realpath(existing), ...rest);
	if (!isInside(rootReal, real)) {
		throw new Error(
			`${given} is outside the workspace (${rootReal}); remote_copy only reads and writes inside it.`,
		);
	}
	return real;
}

function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
			} else out += "[^/]*";
		} else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/**
 * Whether a path inside the copied folder (forward slashes, no leading `./`)
 * is excluded. A pattern without `/` matches any one path segment (`.git`,
 * `*.log`); one with `/` matches the whole relative path (`build/**`).
 */
export function isExcluded(
	relativePath: string,
	patterns: readonly string[],
): boolean {
	const segments = relativePath.split("/").filter(Boolean);
	return patterns.some((pattern) => {
		const clean = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
		if (!clean) return false;
		const re = globToRegExp(clean);
		return clean.includes("/")
			? re.test(segments.join("/"))
			: segments.some((segment) => re.test(segment));
	});
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_TRANSFER_BYTES) {
			throw new Error(
				`more than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB to send; copy a smaller folder or leave more out with \`exclude\`.`,
			);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export interface PackedFolder {
	archive: Buffer;
	files: number;
	bytes: number;
	excluded: number;
}

/** A folder's contents as a gzipped tar, without the excluded paths. Links are left out. */
export async function packFolder(
	folder: string,
	excludes: readonly string[],
): Promise<PackedFolder> {
	let files = 0;
	let bytes = 0;
	let excluded = 0;
	const stream = create(
		{
			gzip: true,
			cwd: folder,
			portable: true,
			filter: (path, entry) => {
				const rel = path.replace(/^\.\/?/, "");
				if (rel && isExcluded(rel, excludes)) {
					excluded += 1;
					return false;
				}
				const info = entry as {
					isFile?: () => boolean;
					isSymbolicLink?: () => boolean;
					size?: number;
				};
				if (info.isSymbolicLink?.()) return false;
				if (info.isFile?.()) {
					files += 1;
					bytes += info.size ?? 0;
				}
				return true;
			},
		},
		["."],
	);
	const archive = await collect(stream as unknown as NodeJS.ReadableStream);
	return { archive, files, bytes, excluded };
}

export interface UnpackResult {
	files: number;
	bytes: number;
	/** Links and devices in the archive, not written. */
	skipped: number;
	/** Files that already existed and were replaced. */
	replaced: number;
}

const WRITABLE_TYPES = new Set([
	"File",
	"OldFile",
	"ContiguousFile",
	"Directory",
]);

/**
 * Unpacks a gzipped tar into `destination`, dropping the first `strip` path
 * parts. Only files and folders are written; an entry that would land outside
 * `destination` stops the whole copy before anything is written, and so does
 * an existing file unless `overwrite`.
 */
export async function unpackArchive(
	archive: Uint8Array,
	destination: string,
	options: { strip?: number; overwrite?: boolean } = {},
): Promise<UnpackResult> {
	const strip = options.strip ?? 0;
	const targets: Array<{ path: string; type: string; size: number }> = [];
	let skipped = 0;
	const lister = list({
		onReadEntry: (entry) => {
			const parts = entry.path
				.split("/")
				.filter((part) => part && part !== ".");
			if (parts.length <= strip) return;
			if (!WRITABLE_TYPES.has(entry.type)) {
				skipped += 1;
				return;
			}
			if (parts.includes("..") || isAbsolute(entry.path)) {
				throw new Error(
					`the archive holds a path outside its folder: ${entry.path}`,
				);
			}
			targets.push({
				path: join(destination, ...parts.slice(strip)),
				type: entry.type,
				size: entry.size ?? 0,
			});
		},
	});
	Readable.from([Buffer.from(archive)]).pipe(
		lister as unknown as NodeJS.WritableStream,
	);
	await finished(lister as unknown as NodeJS.WritableStream);

	let replaced = 0;
	const clashes: string[] = [];
	for (const target of targets) {
		if (!isInside(destination, target.path)) {
			throw new Error(
				`the archive holds a path outside its folder: ${target.path}`,
			);
		}
		if (target.type === "Directory") continue;
		try {
			const existing = await lstat(target.path);
			if (existing.isSymbolicLink() || existing.isDirectory()) {
				throw new Error(
					`${relative(destination, target.path)} exists here and is not a plain file; nothing was copied.`,
				);
			}
			replaced += 1;
			if (!options.overwrite) clashes.push(relative(destination, target.path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (clashes.length > 0) {
		const shown = clashes.slice(0, 5).join(", ");
		throw new Error(
			`${clashes.length} file${clashes.length === 1 ? "" : "s"} already exist here (${shown}${clashes.length > 5 ? ", …" : ""}); nothing was copied. Call again with overwrite: true to replace them.`,
		);
	}

	await mkdir(destination, { recursive: true });
	const unpacker = extract({
		cwd: destination,
		strip,
		noChmod: true,
		preserveOwner: false,
		filter: (_path, entry) =>
			WRITABLE_TYPES.has((entry as { type?: string }).type ?? ""),
	});
	Readable.from([Buffer.from(archive)]).pipe(
		unpacker as unknown as NodeJS.WritableStream,
	);
	await finished(unpacker as unknown as NodeJS.WritableStream);

	const files = targets.filter((target) => target.type !== "Directory");
	return {
		files: files.length,
		bytes: files.reduce((sum, file) => sum + file.size, 0),
		skipped,
		replaced,
	};
}

/** Writes one downloaded file; refuses to replace an existing one unless `overwrite`. */
export async function writeLocalFile(
	path: string,
	data: Uint8Array,
	overwrite: boolean,
): Promise<{ replaced: boolean }> {
	let replaced = false;
	try {
		const existing = await stat(path);
		if (existing.isDirectory()) {
			throw new Error(
				`${path} is a folder here; name a file path, or a new folder for a folder download.`,
			);
		}
		if (!overwrite) {
			throw new Error(
				`${path} already exists; nothing was copied. Call again with overwrite: true to replace it.`,
			);
		}
		replaced = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, data);
	return { replaced };
}
