import { describe, expect, it } from "vitest";
import {
	closeStreamSideParts,
	openStreamSideParts,
	STREAM_SIDE_PARTS_HEADER,
	streamSidePartsOf,
	withStreamSideParts,
} from "./stream-side-parts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("withStreamSideParts", () => {
	it("is the main stream when there is no queue", async () => {
		async function* main() {
			yield 1;
			yield 2;
		}
		const seen: unknown[] = [];
		for await (const part of withStreamSideParts(main(), undefined)) {
			seen.push(part);
		}
		expect(seen).toEqual([1, 2]);
	});

	it("delivers side parts while the main stream is silent", async () => {
		const queue = openStreamSideParts();
		let release: () => void = () => undefined;
		const silent = new Promise<void>((resolve) => {
			release = resolve;
		});
		async function* main() {
			await silent;
			yield "call";
		}
		const seen: unknown[] = [];
		const reading = (async () => {
			for await (const part of withStreamSideParts(main(), queue)) {
				seen.push(part);
			}
		})();
		queue.push({ type: "tool-input-delta", id: "a", delta: "one" });
		await tick();
		queue.push({ type: "tool-input-delta", id: "a", delta: "two" });
		await tick();
		// Both are out before the main stream has said anything.
		expect(seen).toEqual([
			{ type: "tool-input-delta", id: "a", delta: "one" },
			{ type: "tool-input-delta", id: "a", delta: "two" },
		]);
		release();
		await reading;
		expect(seen.at(-1)).toBe("call");
		closeStreamSideParts(queue);
	});

	it("lets the reader leave while the main stream is still silent", async () => {
		const queue = openStreamSideParts();
		let returned = false;
		const main: AsyncIterable<string> = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<string>>(() => undefined),
				return: async () => {
					returned = true;
					return { done: true, value: undefined };
				},
			}),
		};
		queue.push({ type: "tool-input-delta", id: "a", delta: "runaway" });
		for await (const part of withStreamSideParts(main, queue)) {
			expect(part).toMatchObject({ delta: "runaway" });
			// The guard's cut: stop reading with the model still writing.
			break;
		}
		expect(returned).toBe(true);
		closeStreamSideParts(queue);
	});

	it("finds a request's queue by its header, in any case, until closed", () => {
		const queue = openStreamSideParts();
		expect(
			streamSidePartsOf({ [STREAM_SIDE_PARTS_HEADER.toUpperCase()]: queue.id }),
		).toBe(queue);
		expect(streamSidePartsOf({ other: "x" })).toBeUndefined();
		closeStreamSideParts(queue);
		expect(
			streamSidePartsOf({ [STREAM_SIDE_PARTS_HEADER]: queue.id }),
		).toBeUndefined();
	});
});
