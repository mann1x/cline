/**
 * Writes a gzipped tar file by file, without holding it in memory: an export
 * of the Library carries the books' own files, and a shelf of them is large.
 *
 * What `extractTarGz` reads back: regular files, with a PAX record for a name
 * past the header's 100 bytes.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { createGzip } from "node:zlib";

const BLOCK = 512;
/** The largest size an octal field of eleven digits holds. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024 * 1024 - 1;

export interface TarEntry {
	/** The path inside the archive, with forward slashes. */
	name: string;
	/** A file to copy in, */
	path?: string;
	/** or the content itself. */
	data?: string | Uint8Array;
}

function header(name: string, size: number, type: string): Buffer {
	const block = Buffer.alloc(BLOCK);
	Buffer.from(name, "utf8").copy(block, 0, 0, 100);
	block.write("0000644\0", 100);
	block.write("0000000\0", 108);
	block.write("0000000\0", 116);
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	block.write(
		`${Math.floor(Date.now() / 1000)
			.toString(8)
			.padStart(11, "0")}\0`,
		136,
	);
	block.fill(0x20, 148, 156);
	block.write(type, 156);
	block.write("ustar\0", 257);
	block.write("00", 263);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

function paxRecord(name: string): Buffer {
	const record = ` path=${name}\n`;
	const bytes = Buffer.byteLength(record);
	let length = bytes + 1;
	while (String(length).length + bytes !== length) length++;
	return Buffer.from(`${length}${record}`);
}

/**
 * Write `entries` to `target` as a gzipped tar. Resolves with the number of
 * files written.
 */
export async function writeTarGz(
	target: string,
	entries: Iterable<TarEntry> | AsyncIterable<TarEntry>,
): Promise<number> {
	const gzip = createGzip();
	const out = createWriteStream(target);
	const finished = once(out, "finish");
	const failed = new Promise<never>((_resolve, reject) => {
		out.once("error", reject);
		gzip.once("error", reject);
	});
	// Not awaited on its own: it only ever rejects, and only matters while
	// something below is waiting.
	failed.catch(() => {});
	gzip.pipe(out);

	const write = async (data: Uint8Array): Promise<void> => {
		if (!gzip.write(data)) {
			await Promise.race([once(gzip, "drain"), failed]);
		}
	};
	const pad = async (size: number): Promise<void> => {
		const padding = (BLOCK - (size % BLOCK)) % BLOCK;
		if (padding) await write(Buffer.alloc(padding));
	};

	let files = 0;
	for await (const entry of entries) {
		const data =
			typeof entry.data === "string"
				? Buffer.from(entry.data, "utf8")
				: Buffer.from(entry.data ?? new Uint8Array());
		const size =
			entry.path !== undefined ? statSync(entry.path).size : data.length;
		if (size > MAX_ENTRY_BYTES) {
			throw new Error(
				`${entry.name} is too large for an archive (8 GB a file).`,
			);
		}
		if (Buffer.byteLength(entry.name) > 100) {
			const record = paxRecord(entry.name);
			await write(header("PaxHeader", record.length, "x"));
			await write(record);
			await pad(record.length);
		}
		await write(header(entry.name, size, "0"));
		if (entry.path !== undefined) {
			let copied = 0;
			for await (const chunk of createReadStream(entry.path)) {
				copied += (chunk as Buffer).length;
				await write(chunk as Buffer);
			}
			if (copied !== size) {
				throw new Error(`${entry.path} changed while it was being archived.`);
			}
		} else {
			await write(data);
		}
		await pad(size);
		files++;
	}
	await write(Buffer.alloc(BLOCK * 2));
	gzip.end();
	await Promise.race([finished, failed]);
	return files;
}
