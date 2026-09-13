import type { Message } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	getMessageBuilderOptionsFromEnv,
	MessageBuilder,
} from "./message-builder";

const PATH = "manic_miner.html";

/**
 * A read of `PATH`, optionally ranged, whose body carries a unique marker so
 * the assertions can say which copies survived rather than counting bytes.
 */
function readTurn(
	id: string,
	range: { start: number; end: number } | undefined,
	marker: string,
): Message[] {
	const query = range ? `${PATH}:${range.start}-${range.end}` : PATH;
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id,
					name: "read_files",
					input: {
						files: [
							range
								? { path: PATH, start_line: range.start, end_line: range.end }
								: { path: PATH },
						],
					},
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					name: "read_files",
					content: JSON.stringify([
						{ query, result: `${marker}-${"X".repeat(4_000)}`, success: true },
					]),
				},
			],
		},
	];
}

/**
 * Production reads the threshold from the environment, so the tests that pin
 * rewrite behaviour have to build the options the same way. A test that calls
 * `new MessageBuilder()` directly cannot observe an environment override at
 * all — which is exactly how `CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES=disable`
 * stayed invisible across a whole run of live sessions.
 */
function buildEagerly(messages: Message[]): string {
	const builder = new MessageBuilder(
		getMessageBuilderOptionsFromEnv({
			CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES: "0",
		}),
	);
	return JSON.stringify(builder.buildForApi(messages) as Message[]);
}

describe("read supersession", () => {
	it("keeps a ranged read that came after a whole-file read", () => {
		// The regression. The old index recorded the latest whole-file read as
		// the path's owner and compared it to each block by identity, so this
		// newer range was reported as outdated by an older full copy.
		const built = buildEagerly([
			...readTurn("read_full", undefined, "FULL"),
			...readTurn("read_range", { start: 29, end: 136 }, "RANGE"),
		]);

		expect(built).toContain("RANGE");
		// The range does not contain the whole file, so the full copy stays too.
		expect(built).toContain("FULL");
	});

	it("drops a ranged read once the whole file is read again", () => {
		const built = buildEagerly([
			...readTurn("read_range", { start: 29, end: 136 }, "RANGE"),
			...readTurn("read_full", undefined, "FULL"),
		]);

		expect(built).not.toContain("RANGE");
		expect(built).toContain("FULL");
	});

	it("drops a ranged read contained by a later, wider range", () => {
		const built = buildEagerly([
			...readTurn("read_inner", { start: 50, end: 100 }, "INNER"),
			...readTurn("read_outer", { start: 1, end: 200 }, "OUTER"),
		]);

		expect(built).not.toContain("INNER");
		expect(built).toContain("OUTER");
	});

	it("keeps a ranged read that a later, narrower range does not contain", () => {
		const built = buildEagerly([
			...readTurn("read_outer", { start: 1, end: 200 }, "OUTER"),
			...readTurn("read_inner", { start: 50, end: 100 }, "INNER"),
		]);

		expect(built).toContain("OUTER");
		expect(built).toContain("INNER");
	});

	it("keeps only the last of repeated identical whole-file reads", () => {
		const built = buildEagerly([
			...readTurn("read_a", undefined, "FIRST"),
			...readTurn("read_b", undefined, "SECOND"),
			...readTurn("read_c", undefined, "THIRD"),
		]);

		expect(built).not.toContain("FIRST");
		expect(built).not.toContain("SECOND");
		expect(built).toContain("THIRD");
	});

	it("keeps ranges of different files apart", () => {
		const other: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "read_other",
						name: "read_files",
						input: { files: [{ path: "other.html" }] },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "read_other",
						name: "read_files",
						content: JSON.stringify([
							{
								query: "other.html",
								result: `OTHER-${"X".repeat(4_000)}`,
								success: true,
							},
						]),
					},
				],
			},
		];
		const built = buildEagerly([
			...readTurn("read_range", { start: 29, end: 136 }, "RANGE"),
			...other,
		]);

		expect(built).toContain("RANGE");
		expect(built).toContain("OTHER");
	});
});

describe("environment-driven rewrite threshold", () => {
	it("falls back to the default when the variable is unset", () => {
		expect(
			getMessageBuilderOptionsFromEnv({}).minOutdatedRewriteBytes,
		).toBeUndefined();
	});

	it("treats 'disable' as an off switch rather than a number", () => {
		// Guards the reading of the trace as much as the behaviour: this value
		// serialises to `null` through JSON.stringify, same as NaN.
		const options = getMessageBuilderOptionsFromEnv({
			CLINE_MESSAGE_BUILDER_MIN_OUTDATED_REWRITE_BYTES: "disable",
		});
		expect(options.minOutdatedRewriteBytes).toBe(Number.POSITIVE_INFINITY);

		const builder = new MessageBuilder(options);
		const built = JSON.stringify(
			builder.buildForApi([
				...readTurn("read_a", undefined, "FIRST"),
				...readTurn("read_b", undefined, "SECOND"),
			]) as Message[],
		);
		expect(built).toContain("FIRST");
		expect(built).toContain("SECOND");
	});
});
