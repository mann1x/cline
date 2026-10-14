import { polykvRoot } from "./polykv";

/**
 * The thinking levels a llama.cpp chat template states for its
 * `reasoning_effort` variable, in the order they escalate, and its default.
 *
 * llama.cpp (and opencoti from c13) hands a top-level `reasoning_effort` to
 * the template, and a template that checks the value raises on any other one:
 * measured on eleven2go, 2026-10-14, "high" against a template listing
 * xhigh/medium/low failed the turn with a 500. So only what the template names
 * is offered. Read from the Jinja source, which is all a llama.cpp server
 * publishes about it:
 *
 *  - comparisons: `reasoning_effort == 'low'`, `'low' == reasoning_effort`;
 *  - membership: `reasoning_effort not in ('xhigh', 'medium', 'low')`;
 *  - defaults: `reasoning_effort|default('xhigh')`,
 *    `{% set reasoning_effort = "medium" %}`;
 *
 * and the same for any variable the template copies it into
 * (`{% set resolved = reasoning_effort|default('xhigh') %}`). "none" is not a
 * level: it is thinking off, which is the checkbox.
 */
export function parseTemplateReasoningLevels(template: string): {
	levels: string[];
	default?: string;
} {
	const names = new Set(["reasoning_effort"]);
	for (const match of template.matchAll(
		/set\s+(\w+)\s*=\s*reasoning_effort\b/g,
	)) {
		names.add(match[1] as string);
	}
	const found: string[] = [];
	let fallback: string | undefined;
	const note = (value: string | undefined) => {
		const level = value?.trim().toLowerCase();
		if (level && !OFF_WORDS.has(level) && !found.includes(level)) {
			found.push(level);
		}
	};
	for (const name of names) {
		const n = escapeRegExp(name);
		for (const m of template.matchAll(
			new RegExp(`\\b${n}\\s*[!=]=\\s*['"]([\\w-]+)['"]`, "g"),
		)) {
			note(m[1]);
		}
		for (const m of template.matchAll(
			new RegExp(`['"]([\\w-]+)['"]\\s*[!=]=\\s*${n}\\b`, "g"),
		)) {
			note(m[1]);
		}
		for (const m of template.matchAll(
			new RegExp(`\\b${n}\\s+(?:not\\s+)?in\\s*[([]([^)\\]]*)[)\\]]`, "g"),
		)) {
			for (const literal of (m[1] as string).matchAll(/['"]([\w-]+)['"]/g)) {
				note(literal[1]);
			}
		}
		for (const m of template.matchAll(
			new RegExp(
				`(?:\\b${n}\\s*\\|\\s*default\\(\\s*|set\\s+${n}\\s*=\\s*)['"]([\\w-]+)['"]`,
				"g",
			),
		)) {
			note(m[1]);
			const level = m[1]?.trim().toLowerCase();
			if (!fallback && level && !OFF_WORDS.has(level)) {
				fallback = level;
			}
		}
	}
	const rank = (level: string) => {
		const index = LADDER.indexOf(level);
		return index === -1 ? LADDER.length : index;
	};
	const levels = found
		.map((level, order) => ({ level, order }))
		.sort((a, b) => rank(a.level) - rank(b.level) || a.order - b.order)
		.map(({ level }) => level);
	return { levels, ...(fallback ? { default: fallback } : {}) };
}

const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
const OFF_WORDS = new Set(["none", "off", "false", "disabled"]);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the levels from the server's own `/props`, fresh: the template is the
 * loaded model's, and a server can be restarted on another model at any time,
 * so this is not cached the way the engine probe is.
 */
export async function readTemplateReasoningLevels(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 5_000,
): Promise<{
	reachable: boolean;
	hasTemplate: boolean;
	levels: string[];
	default?: string;
}> {
	if (!baseUrl) {
		return { reachable: false, hasTemplate: false, levels: [] };
	}
	try {
		const response = await fetchImpl(`${polykvRoot(baseUrl)}/props`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return { reachable: true, hasTemplate: false, levels: [] };
		}
		const body = (await response.json()) as { chat_template?: unknown };
		if (typeof body.chat_template !== "string" || body.chat_template === "") {
			return { reachable: true, hasTemplate: false, levels: [] };
		}
		return {
			reachable: true,
			hasTemplate: true,
			...parseTemplateReasoningLevels(body.chat_template),
		};
	} catch {
		return { reachable: false, hasTemplate: false, levels: [] };
	}
}
