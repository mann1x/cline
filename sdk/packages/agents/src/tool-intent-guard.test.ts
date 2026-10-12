import { describe, expect, it } from "vitest";
import {
	buildToolIntentOverrunNudge,
	DEFAULT_TOOL_INTENT_MAX_CHARS,
	ToolIntentGuard,
} from "./tool-intent-guard";

/** Feed text the way a stream does: in pieces that respect nothing. */
function feed(guard: ToolIntentGuard, text: string, chunk = 7) {
	for (let i = 0; i < text.length; i += chunk) {
		const verdict = guard.push("call_1", text.slice(i, i + chunk), "editor");
		if (verdict) {
			return { verdict, consumed: i + chunk };
		}
	}
	return { verdict: undefined, consumed: text.length };
}

describe("ToolIntentGuard", () => {
	it("lets a call with a one-sentence intent and a large payload through", () => {
		const guard = new ToolIntentGuard();
		const call = JSON.stringify({
			intent: "Delete the extra closing brace at line 97.",
			new_text: "x".repeat(60_000),
			path: "manic_miner.html",
			start_line: 97,
		});
		expect(feed(guard, call).verdict).toBeUndefined();
	});

	it("answers as soon as intent passes the limit, without waiting for the call to close", () => {
		const guard = new ToolIntentGuard();
		// Session x8yap: the reasoning went into `intent` and never came out.
		const call = `{"end_column":386,"intent":"Fix bracket imbalance. ${"Wait, let's re-examine line 110. ".repeat(3000)}`;
		const { verdict, consumed } = feed(guard, call);
		expect(verdict).toMatchObject({
			toolCallId: "call_1",
			toolName: "editor",
			maxChars: DEFAULT_TOOL_INTENT_MAX_CHARS,
		});
		expect(consumed).toBeLessThan(DEFAULT_TOOL_INTENT_MAX_CHARS + 100);
	});

	it("measures intent wherever it comes among the arguments", () => {
		const guard = new ToolIntentGuard({ maxChars: 50 });
		const call = `{"path":"a.ts","new_text":"${"y".repeat(500)}","intent":"${"z".repeat(80)}"}`;
		expect(feed(guard, call).verdict?.chars).toBe(51);
	});

	it("does not take a nested or quoted 'intent' for the argument", () => {
		const guard = new ToolIntentGuard({ maxChars: 50 });
		const call = JSON.stringify({
			files: [{ intent: "n".repeat(300) }],
			new_text: `"intent":"${"q".repeat(300)}"`,
			intent: "Short.",
		});
		expect(feed(guard, call).verdict).toBeUndefined();
	});

	it("reads escaped quotes inside intent as part of it", () => {
		const guard = new ToolIntentGuard({ maxChars: 30 });
		const call = JSON.stringify({ intent: 'say "hi" '.repeat(10) });
		expect(feed(guard, call, 3).verdict).toBeDefined();
	});

	it("keeps calls apart", () => {
		const guard = new ToolIntentGuard({ maxChars: 20 });
		expect(guard.push("a", '{"intent":"0123456789')).toBeUndefined();
		expect(guard.push("b", '{"intent":"0123456789')).toBeUndefined();
		expect(guard.push("a", '0123456789"')).toBeUndefined();
		expect(guard.push("b", "0123456789X")?.toolCallId).toBe("b");
	});

	describe("gemma4 call syntax", () => {
		const feedGemma = (guard: ToolIntentGuard, text: string, chunk: number) => {
			for (let i = 0; i < text.length; i += chunk) {
				const verdict = guard.push(
					"call_1",
					text.slice(i, i + chunk),
					"editor",
					"gemma4",
				);
				if (verdict) {
					return { verdict, consumed: i + chunk };
				}
			}
			return { verdict: undefined, consumed: text.length };
		};

		// The first lines of the two calls in xOllama's log for session x8yap.
		const working =
			'call:editor{intent:<|"|>Fix syntax error on line 91 by adding missing closing bracket.<|"|>,new_text:<|"|>' +
			"     dIt(c,x){this.it.forEach(it=>{if(!it.cl){c.save();}});};".repeat(
				400,
			) +
			'<|"|>,path:<|"|>manic_miner.html<|"|>,start_line:91}';
		const runaway = `call:editor{end_column:386,intent:<|"|>Fix bracket imbalance in currentLevelObj.en.forEach callback on line 110. ${"Wait, let's re-examine line 110 in the previous `read_files`. ".repeat(1500)}`;

		it.each([
			1, 3, 4, 5, 7, 64,
		])("passes a short intent with a large payload, in deltas of %i", (chunk) => {
			expect(
				feedGemma(new ToolIntentGuard(), working, chunk).verdict,
			).toBeUndefined();
		});

		it.each([
			1, 3, 4, 5, 7, 64,
		])("cuts the call whose intent is the reasoning, in deltas of %i", (chunk) => {
			const { verdict, consumed } = feedGemma(
				new ToolIntentGuard(),
				runaway,
				chunk,
			);
			expect(verdict?.toolName).toBe("editor");
			expect(consumed).toBeLessThan(DEFAULT_TOOL_INTENT_MAX_CHARS + 200);
		});

		it("counts intent to its closing delimiter and no further", () => {
			const guard = new ToolIntentGuard({ maxChars: 50 });
			const call = `call:editor{intent:<|"|>${"z".repeat(40)}<|"|>,new_text:<|"|>${"y".repeat(500)}<|"|>}`;
			expect(feedGemma(guard, call, 3).verdict).toBeUndefined();
		});

		it("does not take 'intent:' inside another argument for the argument", () => {
			const guard = new ToolIntentGuard({ maxChars: 50 });
			const call = `call:editor{new_text:<|"|>{intent:${"q".repeat(300)}}<|"|>,files:[{intent:<|"|>${"n".repeat(300)}<|"|>}],intent:<|"|>Short.<|"|>}`;
			expect(feedGemma(guard, call, 3).verdict).toBeUndefined();
		});
	});

	it("tells the model what was cut and what intent is for", () => {
		const text = buildToolIntentOverrunNudge({
			toolCallId: "call_1",
			toolName: "editor",
			chars: 2001,
			maxChars: 2000,
		});
		expect(text).toContain("`editor`");
		expect(text).toContain("nothing ran");
		expect(text).toContain("2,000 characters");
	});
});
