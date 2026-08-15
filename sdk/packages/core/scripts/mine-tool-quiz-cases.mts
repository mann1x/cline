/**
 * Mine quiz cases out of real Cline sessions.
 *
 * The corpus this feeds is (situation → the tool call that should have been
 * made). The guidance strings in `executors/` are only worth what they make a
 * model *do*, so the behaviour is the specification and the prose is one
 * implementation of it. That makes the corpus useful before any translation
 * exists: run it against today's English strings and it is a regression test on
 * prompt engineering that currently has none.
 *
 * Cases are mined rather than authored on purpose. Imagined scenarios miss
 * exactly the cases the strings were painfully written to prevent — every entry
 * here comes from a call that actually failed, in a session that actually ran.
 *
 * The resolving call is a *candidate* gold, never an accepted one. A call that
 * succeeded is not automatically the call that should have been made: the
 * whole-file rewrite succeeded every time and was still the wrong answer, and
 * removing that behaviour took most of a day. Every case is emitted with
 * `gold_confirmed: false` and a human decides.
 *
 * Usage:
 *   bunx tsx scripts/mine-tool-quiz-cases.mts <sessions-dir> [--out cases.json]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ToolCall {
	index: number;
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface MinedCase {
	/** Where it came from, so a case can always be traced back to its session. */
	session: string;
	/** The call that failed. */
	failed_call: { name: string; input: Record<string, unknown> };
	/** What the tool said. This is the guidance string under test. */
	error: string;
	/** The next successful call to the same tool — a candidate, not a verdict. */
	candidate_gold?: { name: string; input: Record<string, unknown> };
	/** How many failed attempts happened before something worked. */
	attempts_before_success: number;
	/** Always false out of the miner. A human decides what the answer is. */
	gold_confirmed: false;
}

function readMessages(file: string): unknown[] {
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	if (Array.isArray(parsed)) {
		return parsed;
	}
	const messages = (parsed as { messages?: unknown }).messages;
	return Array.isArray(messages) ? messages : [];
}

function blocksOf(message: unknown): Record<string, unknown>[] {
	const content = (message as { content?: unknown })?.content;
	return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

/**
 * An error result, as text.
 *
 * Two shapes count: the explicit `is_error` flag, and a result whose text reads
 * as a refusal. The executors refuse by returning a message rather than
 * throwing — which is the entire reason those strings are prompt engineering —
 * so keying only on `is_error` would miss the cases that matter most.
 */
const REFUSAL_MARKERS = [
	"is required",
	"Read before editing",
	"no longer counts",
	"did not match",
	"not found in",
	"Invalid",
	"refused",
];

function errorTextOf(block: Record<string, unknown>): string | undefined {
	const content = block.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((entry) =>
							typeof entry === "object" && entry && "text" in entry
								? String((entry as { text: unknown }).text)
								: "",
						)
						.join("\n")
				: "";
	if (block.is_error === true) {
		return text;
	}
	return REFUSAL_MARKERS.some((marker) => text.includes(marker))
		? text
		: undefined;
}

export function mineSession(
	sessionId: string,
	messages: unknown[],
): MinedCase[] {
	const calls = new Map<string, ToolCall>();
	const ordered: ToolCall[] = [];
	const failures = new Map<string, string>();

	let index = 0;
	for (const message of messages) {
		for (const block of blocksOf(message)) {
			if (block.type === "tool_use") {
				const call: ToolCall = {
					index: index++,
					id: String(block.id ?? ""),
					name: String(block.name ?? ""),
					input: (block.input as Record<string, unknown>) ?? {},
				};
				calls.set(call.id, call);
				ordered.push(call);
			} else if (block.type === "tool_result") {
				const error = errorTextOf(block);
				if (error) {
					failures.set(String(block.tool_use_id ?? ""), error);
				}
			}
		}
	}

	const cases: MinedCase[] = [];
	for (const [callId, error] of failures) {
		const failed = calls.get(callId);
		if (!failed) {
			continue;
		}
		// The resolving call is the next call to the same tool that did not fail.
		// Same tool, because "it read the file instead" is a different lesson from
		// "it called the editor correctly" and they must not be conflated.
		let attempts = 1;
		let resolved: ToolCall | undefined;
		for (const later of ordered) {
			if (later.index <= failed.index || later.name !== failed.name) {
				continue;
			}
			if (failures.has(later.id)) {
				attempts += 1;
				continue;
			}
			resolved = later;
			break;
		}
		cases.push({
			session: sessionId,
			failed_call: { name: failed.name, input: failed.input },
			error: error.slice(0, 800),
			...(resolved
				? { candidate_gold: { name: resolved.name, input: resolved.input } }
				: {}),
			attempts_before_success: attempts,
			gold_confirmed: false,
		});
	}
	return cases;
}

function main(): void {
	const [dir, ...rest] = process.argv.slice(2);
	if (!dir) {
		console.error(
			"usage: mine-tool-quiz-cases.mts <sessions-dir> [--out cases.json]",
		);
		process.exit(1);
	}
	const outIndex = rest.indexOf("--out");
	const out = outIndex >= 0 ? rest[outIndex + 1] : "quiz-cases.json";

	const cases: MinedCase[] = [];
	for (const entry of readdirSync(dir)) {
		const sessionDir = join(dir, entry);
		if (!statSync(sessionDir).isDirectory()) {
			continue;
		}
		for (const file of readdirSync(sessionDir)) {
			if (!file.endsWith(".messages.json")) {
				continue;
			}
			try {
				cases.push(...mineSession(entry, readMessages(join(sessionDir, file))));
			} catch (error) {
				console.error(`skipped ${file}: ${(error as Error).message}`);
			}
		}
	}

	// Loops first: a case the model failed repeatedly is worth more than one it
	// recovered from immediately, because the guidance clearly did not land.
	cases.sort((a, b) => b.attempts_before_success - a.attempts_before_success);
	writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`, "utf8");

	const byTool = new Map<string, number>();
	for (const item of cases) {
		byTool.set(
			item.failed_call.name,
			(byTool.get(item.failed_call.name) ?? 0) + 1,
		);
	}
	console.log(`${cases.length} cases → ${out}`);
	for (const [tool, count] of [...byTool].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${tool}: ${count}`);
	}
	console.log(
		`  with a candidate gold: ${cases.filter((c) => c.candidate_gold).length}`,
	);
}

if (process.argv[1]?.endsWith("mine-tool-quiz-cases.mts")) {
	main();
}
