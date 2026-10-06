/**
 * Unpacks an npm tarball (gzip over tar) as it streams in, without holding
 * it in memory: the native library the Library downloads is 200 MB and more.
 *
 * Only what npm tarballs contain is handled: regular files and directories,
 * with PAX and GNU long names. Links and devices are skipped. The first path
 * component (`package/`) is dropped, and a path that would leave the target
 * folder is refused.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
	const slice = block.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
	const value = text(block, start, length).trim();
	return value ? Number.parseInt(value, 8) : 0;
}

function paxPath(data: Buffer): string | undefined {
	// Records are "<length> <key>=<value>\n".
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number.parseInt(data.subarray(offset, space).toString(), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = data
			.subarray(space + 1, offset + length - 1)
			.toString("utf8");
		const equals = record.indexOf("=");
		if (equals !== -1 && record.slice(0, equals) === "path") {
			return record.slice(equals + 1);
		}
		offset += length;
	}
	return undefined;
}

function targetPath(root: string, name: string): string | undefined {
	const stripped = name.split("/").slice(1).join("/");
	if (!stripped || stripped.endsWith("/")) {
		return undefined;
	}
	const relative = normalize(stripped);
	if (
		isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(`..${sep}`)
	) {
		throw new Error(`The archive holds a path outside its folder: ${name}`);
	}
	return join(root, relative);
}

/**
 * Unpack the gzipped tar read from `source` into `root`. Resolves with the
 * number of files written.
 */
export async function extractTarGz(
	source: AsyncIterable<Uint8Array>,
	root: string,
): Promise<number> {
	const gunzip = createGunzip();
	const pump = (async () => {
		try {
			for await (const chunk of source) {
				if (!gunzip.write(chunk)) {
					await new Promise<void>((resolve) =>
						gunzip.once("drain", () => resolve()),
					);
				}
			}
			gunzip.end();
		} catch (error) {
			gunzip.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	})();

	let pending: Buffer = Buffer.alloc(0);
	let files = 0;
	let longName: string | undefined;
	// The entry being read: how much of its body is left, and where it goes.
	let remaining = 0;
	let padding = 0;
	let out: ReturnType<typeof createWriteStream> | undefined;
	let collect: Buffer[] | undefined;
	let collectKind: "pax" | "gnu" | undefined;

	const closeOut = async () => {
		if (!out) return;
		const stream = out;
		out = undefined;
		await new Promise<void>((resolve, reject) => {
			stream.once("error", reject);
			stream.end(resolve);
		});
	};

	for await (const chunk of gunzip as AsyncIterable<Buffer>) {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		for (;;) {
			if (remaining > 0) {
				if (pending.length === 0) break;
				const take = pending.subarray(0, Math.min(remaining, pending.length));
				pending = pending.subarray(take.length);
				remaining -= take.length;
				if (out) {
					if (!out.write(take)) {
						await new Promise<void>((resolve) => {
							out?.once("drain", () => resolve());
						});
					}
				} else if (collect) {
					collect.push(Buffer.from(take));
				}
				if (remaining > 0) break;
				await closeOut();
				if (collect) {
					const data = Buffer.concat(collect);
					longName =
						collectKind === "pax"
							? (paxPath(data) ?? longName)
							: data.toString("utf8").replace(/\0+$/, "");
					collect = undefined;
				}
				continue;
			}
			if (padding > 0) {
				if (pending.length < padding) break;
				pending = pending.subarray(padding);
				padding = 0;
				continue;
			}
			if (pending.length < BLOCK) break;
			const header = pending.subarray(0, BLOCK);
			pending = pending.subarray(BLOCK);
			if (header.every((byte) => byte === 0)) {
				continue; // end-of-archive padding
			}
			const size = octal(header, 124, 12);
			const type = String.fromCharCode(header[156] || 0x30);
			remaining = size;
			padding = (BLOCK - (size % BLOCK)) % BLOCK;
			if (type === "x" || type === "L") {
				collect = [];
				collectKind = type === "x" ? "pax" : "gnu";
				continue;
			}
			const prefix = text(header, 345, 155);
			const name =
				longName ?? (prefix ? `${prefix}/` : "") + text(header, 0, 100);
			longName = undefined;
			if (type !== "0" && type !== "\0") {
				continue; // directory, link, global header: nothing to write
			}
			const path = targetPath(root, name);
			if (!path) continue;
			mkdirSync(dirname(path), { recursive: true });
			out = createWriteStream(path);
			files++;
			if (size === 0) {
				await closeOut();
			}
		}
	}
	await closeOut();
	await pump;
	return files;
}
