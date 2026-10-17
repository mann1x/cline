import { afterEach, describe, expect, it } from "vitest";
import {
	buildNoticesField,
	hideKnownNoticeLines,
	readGenerationNoticeCapability,
	readNoticeFields,
	resetNoticeRequests,
	setNoticeCopyBar,
	setNoticeTemplates,
	withGenerationNotices,
} from "./generation-notices";

afterEach(() => {
	resetNoticeRequests();
	setNoticeCopyBar(undefined);
});

// opencoti docs/llamafile-flags.md "Generation notices (contract v3)", f89f9bee7a.
const THINK_80 =
	"I'm stopping my thinking now and writing the answer — only {words} words left.";
const ANSWER_80 = "I'm writing the conclusion now.";
const V3_PROPS = {
	features: ["generation_notice_v2", "generation_notice_v3"],
	generation_notice: {
		version: 2,
		hide: [{ open: "<engine_status", close: "</engine_status>" }],
		v3: {
			think: [{ at_percent: 80, template: THINK_80 }],
			answer: [{ at_percent: 80, template: ANSWER_80 }],
			message: "A new message is waiting, so I'm finishing this reply briefly.",
			wildcards: { left: "integer", total: "integer", words: "integer" },
		},
	},
};

describe("notices v3", () => {
	it("reads v3 support and the v2 spans from /props", () => {
		expect(readGenerationNoticeCapability(V3_PROPS)).toEqual({
			supported: true,
			v3: true,
			hide: [{ open: "<engine_status", close: "</engine_status>" }],
		});
	});

	it("asks for version 3 with the wording set for each step, and none on v2", () => {
		setNoticeTemplates({
			think: ["", "Wrap up: {words} words left."],
			answer: ["Finish now."],
		});
		const settings = { enabled: true, thinkSteps: [60, 80], answerSteps: [70] };
		expect(buildNoticesField(settings, "k", { v3: true })).toEqual({
			version: 3,
			key: "k",
			think: [
				{ at_percent: 60 },
				{ at_percent: 80, template: "Wrap up: {words} words left." },
			],
			answer: [{ at_percent: 70, template: "Finish now." }],
		});
		expect(buildNoticesField(settings, "k")).toEqual({
			key: "k",
			think: [{ at_percent: 60 }, { at_percent: 80 }],
			answer: [{ at_percent: 70 }],
		});
	});

	it("reads the copy bar from the feature or the /props block, v3 only", () => {
		expect(
			readGenerationNoticeCapability({
				...V3_PROPS,
				features: [...V3_PROPS.features, "generation_notice_copy_bar"],
			}).copyBar,
		).toBe(true);
		expect(
			readGenerationNoticeCapability({
				features: ["generation_notice_v3"],
				generation_notice: {
					v3: { copy_bar: { think: true, answer: true } },
				},
			}).copyBar,
		).toBe(true);
		expect(readGenerationNoticeCapability(V3_PROPS).copyBar).toBeUndefined();
		expect(
			readGenerationNoticeCapability({
				features: ["generation_notice_v2", "generation_notice_copy_bar"],
			}).copyBar,
		).toBeUndefined();
	});

	it("says the copy bar per phase, on for thinking by default, only where it is taken", () => {
		const settings = { enabled: true, thinkSteps: [80], answerSteps: [80] };
		expect(
			buildNoticesField(settings, "k", { v3: true, copyBar: true })?.copy_bar,
		).toEqual({ think: true, answer: false });
		setNoticeCopyBar({ think: false, answer: true });
		expect(
			buildNoticesField(settings, "k", { v3: true, copyBar: true })?.copy_bar,
		).toEqual({ think: false, answer: true });
		setNoticeCopyBar({ answer: true });
		expect(
			buildNoticesField(settings, "k", { v3: true, copyBar: true })?.copy_bar,
		).toEqual({ think: true, answer: true });
		// An older v3 engine, or a v2 one, answers the field with a 400.
		expect(
			buildNoticesField(settings, "k", { v3: true })?.copy_bar,
		).toBeUndefined();
		expect(
			buildNoticesField(settings, "k", { copyBar: true })?.copy_bar,
		).toBeUndefined();
	});

	it("keeps a template to one line", () => {
		setNoticeTemplates({ answer: ["Finish\nnow."] });
		expect(
			buildNoticesField(
				{ enabled: true, answerSteps: [70], thinkSteps: [] },
				"k",
				{ v3: true },
			),
		).toEqual({
			version: 3,
			key: "k",
			answer: [{ at_percent: 70, template: "Finish now." }],
		});
	});

	it("hides the exact line the stream named, with its line break, in its own channel", () => {
		const line =
			"I'm stopping my thinking now and writing the answer — only 450 words left.";
		readNoticeFields(
			`data: {"choices":[],"notice":{"index":0,"phase":"thinking","text":${JSON.stringify(line)}}}`,
		);
		const reasoning = `Checking line 90.\n${line}\nSo the fix is the brace.`;
		expect(hideKnownNoticeLines(reasoning, { channel: "reasoning" })).toBe(
			"Checking line 90.\nSo the fix is the brace.",
		);
		// Not the reply's: the reply keeps a sentence that only looks like it.
		expect(hideKnownNoticeLines(`Quote: ${line}`, { channel: "text" })).toBe(
			`Quote: ${line}`,
		);
		// Inside a line it is the model's own sentence.
		expect(
			hideKnownNoticeLines(`He said ${line}`, { channel: "reasoning" }),
		).toBe(`He said ${line}`);
	});

	it("holds back the start of a named line while it streams", () => {
		readNoticeFields(
			`{"model":"m","message":{"content":""},"notice":{"index":0,"phase":"answer","text":"I'm writing the conclusion now."}}`,
		);
		expect(
			hideKnownNoticeLines("The fix works.\nI'm writing the con", {
				streaming: true,
				channel: "text",
			}),
		).toBe("The fix works.\n");
		expect(
			hideKnownNoticeLines("The fix works.\nI'm writing the con", {
				channel: "text",
			}),
		).toBe("The fix works.\nI'm writing the con");
	});

	it("reads the end-of-response list", () => {
		readNoticeFields(
			`data: {"timings":{"notices_planted":1,"notices":[{"index":0,"phase":"message","text":"A new message is waiting, so I'm finishing this reply briefly."}]}}`,
		);
		expect(
			hideKnownNoticeLines(
				"Done.\n\nA new message is waiting, so I'm finishing this reply briefly.\n",
				{ channel: "text" },
			),
		).toBe("Done.\n\n");
	});

	it("hides a waiting-message line where the engine wrote it, by its channel", () => {
		const line =
			"A new message is waiting, so I'm finishing this reply briefly.";
		readNoticeFields(
			`data: {"notice":{"index":2,"phase":"message","channel":"reasoning","text":${JSON.stringify(line)}}}`,
		);
		expect(
			hideKnownNoticeLines(`Still checking.\n${line}\n`, {
				channel: "reasoning",
			}),
		).toBe("Still checking.\n");
		expect(hideKnownNoticeLines(`Reply.\n${line}`, { channel: "text" })).toBe(
			`Reply.\n${line}`,
		);
	});

	it("removes the exact break the engine wrote after the line", () => {
		const line = "I'm writing the conclusion now.";
		readNoticeFields(
			`data: {"notice":{"index":1,"phase":"answer","channel":"content","text":${JSON.stringify(line)},"break":"\\n\\n"}}`,
		);
		expect(
			hideKnownNoticeLines(`First paragraph.\n\n${line}\n\nLast one.`, {
				channel: "text",
			}),
		).toBe("First paragraph.\n\nLast one.");
	});

	it("hides a whole line equal to a built-in form or our own template when no stream named it", () => {
		readGenerationNoticeCapability(V3_PROPS);
		setNoticeTemplates({ answer: ["Finish now, {left} tokens left."] });
		const stored =
			"Reading.\nI'm stopping my thinking now and writing the answer — only 1230 words left.\nDone.\nFinish now, 300 tokens left.";
		expect(hideKnownNoticeLines(stored)).toBe("Reading.\nDone.");
		// A wildcard is a whole number, and the line must be the whole form.
		expect(hideKnownNoticeLines("Finish now, many tokens left.")).toBe(
			"Finish now, many tokens left.",
		);
		expect(hideKnownNoticeLines("So: I'm writing the conclusion now.")).toBe(
			"So: I'm writing the conclusion now.",
		);
	});

	it("hides a v2 notice by its published span, over several lines, and holds an open back while streaming", () => {
		readGenerationNoticeCapability(V3_PROPS);
		expect(
			hideKnownNoticeLines(
				'one\n<engine_status output_budget="300">300 left</engine_status>\ntwo',
			),
		).toBe("one\ntwo");
		expect(
			hideKnownNoticeLines("one\n<engine_status>a\nb</engine_status>\ntwo"),
		).toBe("one\ntwo");
		expect(hideKnownNoticeLines("one\n<engine_st", { streaming: true })).toBe(
			"one",
		);
		expect(
			hideKnownNoticeLines("one\n<engine_status>still coming", {
				streaming: true,
			}),
		).toBe("one");
	});

	it("names each line from the response body as it passes, on a v3 server", async () => {
		const line = "I'm writing the conclusion now.";
		const sse = [
			`data: {"choices":[{"delta":{"content":"ok"}}],"notice":{"index":0,"phase":"answer","text":${JSON.stringify(line)}}}`,
			`data: {"choices":[{"delta":{"content":"\\n${line}\\n"}}]}`,
			"data: [DONE]",
			"",
		].join("\n");
		let sent: Record<string, unknown> | undefined;
		const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return new Response(sse, {
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		const wrapped = withGenerationNotices(fetchImpl, {
			settings: { enabled: true },
			sessionId: "s",
			isChat: () => true,
			capability: async () => readGenerationNoticeCapability(V3_PROPS),
			signalUrl: "http://x/v1/notice",
		});
		const response = await wrapped("http://x/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});
		await response.text();
		expect(sent?.notices).toMatchObject({ version: 3 });
		expect(hideKnownNoticeLines(`ok\n${line}\n`, { channel: "text" })).toBe(
			"ok\n",
		);
	});
});
