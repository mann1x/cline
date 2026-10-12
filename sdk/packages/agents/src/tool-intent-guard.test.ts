import { describe, expect, it } from "vitest";
import {
	buildToolIntentOverrunNudge,
	DEFAULT_TOOL_INTENT_MAX_CHARS,
	ToolIntentGuard,
} from "./tool-intent-guard";

/** The editor's arguments, and a few of its neighbours'. */
const argumentNames = [
	"intent",
	"path",
	"new_text",
	"old_text",
	"start_line",
	"end_line",
	"end_column",
	"task_progress",
	"files",
	"commands",
];

const guard = (maxChars?: number) =>
	new ToolIntentGuard({
		argumentNames,
		...(maxChars ? { maxChars } : {}),
	});

/** Feed text the way a stream does: in pieces that respect nothing. */
function feed(target: ToolIntentGuard, text: string, chunk: number) {
	for (let i = 0; i < text.length; i += chunk) {
		const verdict = target.push("call_1", text.slice(i, i + chunk), "editor");
		if (verdict) {
			return { verdict, consumed: i + chunk };
		}
	}
	return { verdict: undefined, consumed: text.length };
}

const reasoning =
	"Wait, let's re-examine line 110 in the previous `read_files`. ";
const payload =
	"     dIt(c,x){this.it.forEach(it=>{if(!it.cl){c.save();}});};".repeat(400);

/**
 * One call, short intent and large payload, and one whose intent is where the
 * model thinks, in each notation a call has been seen in.
 */
const notations: Array<{ name: string; working: string; runaway: string }> = [
	{
		name: "JSON arguments",
		working: JSON.stringify({
			intent: "Delete the extra closing brace at line 97.",
			new_text: payload,
			path: "manic_miner.html",
			start_line: 97,
		}),
		runaway: `{"end_column":386,"intent":"Fix bracket imbalance. ${reasoning.repeat(1500)}`,
	},
	{
		name: "JSON inside a tag, arguments one level down",
		working: `{"name":"editor","arguments":${JSON.stringify({
			path: "manic_miner.html",
			intent: "Delete the extra closing brace at line 97.",
			new_text: payload,
		})}}`,
		runaway: `{"name": "editor", "arguments": {"path": "manic_miner.html", "intent": "Fix bracket imbalance. ${reasoning.repeat(1500)}`,
	},
	{
		// The first characters of the two calls xOllama's log kept from
		// session x8yap.
		name: "gemma4",
		working: `call:editor{intent:<|"|>Fix syntax error on line 91 by adding missing closing bracket.<|"|>,new_text:<|"|>${payload}<|"|>,path:<|"|>manic_miner.html<|"|>,start_line:91}`,
		runaway: `call:editor{end_column:386,intent:<|"|>Fix bracket imbalance in currentLevelObj.en.forEach callback on line 110. ${reasoning.repeat(1500)}`,
	},
	{
		name: "qwen tagged parameters",
		working: `<function=editor>\n<parameter=intent>\nDelete the extra closing brace.\n</parameter>\n<parameter=new_text>\n${payload}\n</parameter>\n<parameter=path>\nmanic_miner.html\n</parameter>\n</function>`,
		runaway: `<function=editor>\n<parameter=path>\nmanic_miner.html\n</parameter>\n<parameter=intent>\nFix bracket imbalance. ${reasoning.repeat(1500)}`,
	},
	{
		name: "glm key and value tags",
		working: `editor\n<arg_key>intent</arg_key>\n<arg_value>Delete the extra closing brace.</arg_value>\n<arg_key>new_text</arg_key>\n<arg_value>${payload}</arg_value>`,
		runaway: `editor\n<arg_key>path</arg_key>\n<arg_value>a.html</arg_value>\n<arg_key>intent</arg_key>\n<arg_value>Fix bracket imbalance. ${reasoning.repeat(1500)}`,
	},
];

describe("ToolIntentGuard", () => {
	describe.each(notations)("$name", ({ working, runaway }) => {
		it.each([
			1, 3, 5, 7, 64, 500,
		])("passes a short intent with a large payload, in deltas of %i", (chunk) => {
			expect(feed(guard(), working, chunk).verdict).toBeUndefined();
		});

		it.each([
			1, 3, 5, 7, 64, 500,
		])("cuts the call whose intent is the reasoning, in deltas of %i", (chunk) => {
			const { verdict, consumed } = feed(guard(), runaway, chunk);
			expect(verdict).toMatchObject({
				toolCallId: "call_1",
				toolName: "editor",
				maxChars: DEFAULT_TOOL_INTENT_MAX_CHARS,
			});
			expect(consumed).toBeLessThan(
				DEFAULT_TOOL_INTENT_MAX_CHARS + 200 + chunk,
			);
		});
	});

	it("passes a long payload that comes before intent", () => {
		// xOllama's capture: argument order is the model's, and `content` came
		// first.
		const call = `call:editor{new_text:<|"|>${payload}<|"|>,intent:<|"|>Short.<|"|>,path:<|"|>a.html<|"|>}`;
		expect(feed(guard(), call, 9).verdict).toBeUndefined();
	});

	it("passes an intent that is the last argument", () => {
		const call = `{"path":"a.ts","new_text":"${"y".repeat(5000)}","intent":"Rewrite the header."}`;
		expect(feed(guard(), call, 9).verdict).toBeUndefined();
	});

	it("does not end the count on an argument's name in prose", () => {
		// "the path: ..." is a sentence, not the next argument.
		const call = `{"intent":"Fix it. ${"Now the path: is wrong and new_text: too. ".repeat(200)}`;
		expect(feed(guard(), call, 9).verdict).toBeDefined();
	});

	it("measures nothing when it does not know the tools' arguments", () => {
		const blind = new ToolIntentGuard();
		expect(
			feed(blind, notations[0]?.runaway ?? "", 64).verdict,
		).toBeUndefined();
	});

	it("keeps calls apart", () => {
		const target = guard(20);
		expect(target.push("a", '{"intent":"0123456789')).toBeUndefined();
		expect(target.push("b", '{"intent":"0123456789')).toBeUndefined();
		expect(target.push("a", '","path":"x"')).toBeUndefined();
		expect(target.push("b", "0123456789X")?.toolCallId).toBe("b");
		expect(target.push("a", "z".repeat(100))).toBeUndefined();
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
