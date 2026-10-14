import { describe, expect, it } from "vitest";
import {
	parseTemplateReasoningLevels,
	readTemplateReasoningLevels,
} from "./template-reasoning-levels";

// The Qwen3.8 omnimerge template, as /props served it on eleven2go, 2026-10-14.
const OMNIMERGE = `{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
    {%- if resolved_reasoning_effort == 'xhigh' %}x{%- elif resolved_reasoning_effort == 'low' %}l{%- endif %}
{%- endif %}`;

// gpt-oss: the level is rendered as text, and only its default is named.
const HARMONY = `{%- if not reasoning_effort is defined %}
    {%- set reasoning_effort = "medium" %}
{%- endif %}
{{- "Reasoning: " + reasoning_effort + "\\n\\n" }}`;

describe("parseTemplateReasoningLevels", () => {
	it("reads a template that lists its levels, in escalating order", () => {
		expect(parseTemplateReasoningLevels(OMNIMERGE)).toEqual({
			levels: ["low", "medium", "xhigh"],
			default: "xhigh",
		});
	});

	it("offers only what a template names", () => {
		expect(parseTemplateReasoningLevels(HARMONY)).toEqual({
			levels: ["medium"],
			default: "medium",
		});
	});

	it("offers nothing for a template without the variable", () => {
		expect(
			parseTemplateReasoningLevels(
				"{%- if enable_thinking %}<think>{%- endif %}",
			),
		).toEqual({ levels: [] });
	});

	it("does not offer the off switch as a level", () => {
		expect(
			parseTemplateReasoningLevels(
				`{%- if reasoning_effort == 'none' %}{%- elif reasoning_effort == "high" %}{%- endif %}`,
			),
		).toEqual({ levels: ["high"] });
	});
});

describe("readTemplateReasoningLevels", () => {
	it("reads /props at the server root, not under /v1", async () => {
		let url = "";
		const fetchStub = (async (input: Parameters<typeof fetch>[0]) => {
			url = String(input);
			return new Response(JSON.stringify({ chat_template: OMNIMERGE }), {
				status: 200,
			});
		}) as typeof fetch;
		const read = await readTemplateReasoningLevels(
			"http://host:8080/v1",
			fetchStub,
		);
		expect(url).toBe("http://host:8080/props");
		expect(read).toEqual({
			reachable: true,
			hasTemplate: true,
			levels: ["low", "medium", "xhigh"],
			default: "xhigh",
		});
	});

	it("says there is no template on a server without /props", async () => {
		const fetchStub = (async () =>
			new Response("not found", { status: 404 })) as typeof fetch;
		expect(
			await readTemplateReasoningLevels("http://vllm:8000/v1", fetchStub),
		).toEqual({
			reachable: true,
			hasTemplate: false,
			levels: [],
		});
	});
});
