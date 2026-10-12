import type { AgentModelEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { abortWhenAbandoned } from "./ai-sdk";
import { primeStream } from "./gateway";

function text(value: string): AgentModelEvent {
	return { type: "text-delta", text: value } as AgentModelEvent;
}

describe("a consumer that leaves a stream early", () => {
	it("closes the source behind the gateway's look-ahead", async () => {
		let closed = false;
		async function* source() {
			try {
				yield 1;
				yield 2;
				yield 3;
			} finally {
				closed = true;
			}
		}
		const { rest } = await primeStream(source());
		const seen: number[] = [];
		for await (const value of rest) {
			seen.push(value);
			if (value === 2) {
				break;
			}
		}
		await Promise.resolve();
		expect(seen).toEqual([1, 2]);
		expect(closed).toBe(true);
	});

	it("leaves a source that ended on its own alone", async () => {
		let returns = 0;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				let n = 0;
				return {
					next: async () =>
						n < 2
							? { done: false, value: ++n }
							: { done: true, value: undefined },
					return: async () => {
						returns += 1;
						return { done: true, value: undefined };
					},
				};
			},
		};
		const { rest } = await primeStream(source);
		const seen: number[] = [];
		for await (const value of rest) {
			seen.push(value);
		}
		expect(seen).toEqual([1, 2]);
		expect(returns).toBe(0);
	});

	it("aborts the request even when the stream's close never settles", async () => {
		let signal: AbortSignal | undefined;
		let returned = false;
		const stuck: AsyncIterable<AgentModelEvent> = {
			[Symbol.asyncIterator]() {
				let n = 0;
				return {
					next: async () => ({ done: false, value: text(`part ${++n}`) }),
					// A tee'd response body: its close waits on a branch nobody reads.
					return: () => {
						returned = true;
						return new Promise<IteratorResult<AgentModelEvent>>(() => {});
					},
				};
			},
		};
		const stream = abortWhenAbandoned({ messages: [] } as never, (owned) => {
			signal = owned.signal;
			return stuck;
		});
		let count = 0;
		for await (const _event of stream) {
			count += 1;
			if (count === 2) {
				break;
			}
		}
		expect(count).toBe(2);
		expect(signal?.aborted).toBe(true);
		expect(returned).toBe(true);
	});

	it("does not abort a response read to a clean finish", async () => {
		let signal: AbortSignal | undefined;
		async function* whole(): AsyncGenerator<AgentModelEvent> {
			yield text("done");
			yield { type: "finish", reason: "stop" } as AgentModelEvent;
		}
		const stream = abortWhenAbandoned({ messages: [] } as never, (owned) => {
			signal = owned.signal;
			return whole();
		});
		for await (const _event of stream) {
			// read to the end
		}
		expect(signal?.aborted).toBe(false);
	});
});
