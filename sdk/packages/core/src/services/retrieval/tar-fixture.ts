/** Test fixtures: gzipped tars built in memory, so no tool is needed. */

import { gzipSync } from "node:zlib";

type Entry = { name: string; body?: string | Buffer; type?: string };

function header(name: string, size: number, type: string): Buffer {
	const block = Buffer.alloc(512);
	block.write(name.slice(0, 100), 0, "utf8");
	block.write("0000644\0", 100);
	block.write("0000000\0", 108);
	block.write("0000000\0", 116);
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	block.write("00000000000\0", 136);
	block.fill(0x20, 148, 156);
	block.write(type, 156);
	block.write("ustar\0", 257);
	block.write("00", 263);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

/** A gzipped tar the way npm writes one, built here so no tool is needed. */
export function tarGz(entries: Entry[]): Buffer {
	const blocks: Buffer[] = [];
	const push = (name: string, body: Buffer, type: string) => {
		blocks.push(header(name, body.length, type), body);
		const padding = (512 - (body.length % 512)) % 512;
		if (padding) blocks.push(Buffer.alloc(padding));
	};
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? "");
		if (entry.name.length > 100) {
			const record = ` path=${entry.name}\n`;
			let length = record.length + 1;
			while (`${length}${record}`.length !== length) length++;
			push("PaxHeader", Buffer.from(`${length}${record}`), "x");
		}
		push(entry.name, body, entry.type ?? "0");
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

/** The archive in pieces of `size` bytes, as a download delivers it. */
export async function* pieces(
	data: Buffer,
	size: number,
): AsyncGenerator<Uint8Array> {
	for (let offset = 0; offset < data.length; offset += size) {
		yield data.subarray(offset, offset + size);
	}
}
