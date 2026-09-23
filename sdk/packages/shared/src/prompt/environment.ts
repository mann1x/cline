/**
 * The per-session parts of a system prompt, marked so they can be moved.
 *
 * A system prompt is mostly the same text for every conversation on a machine
 * -- instructions, conventions, the tool contract -- with a few values that
 * are not: the date, the working directory, the workspace's rules, the mode.
 * Substituted in place they sit twenty lines into the system turn, and on an
 * engine that shares a prefix across sessions (opencoti's PolyKV) the first
 * byte that differs ends what can be shared. Chat templates render tool
 * schemas after the system text, inside the same turn, so a different working
 * directory also stops the tools -- a third of the window -- from being shared.
 *
 * So a prompt built for such an engine carries those values as marked spans
 * instead. The provider that understands them lifts every span out of the
 * system turn into an `<environment>` block of its own, sent as the first user
 * turn; the system turn left behind is identical for every session. Every
 * other provider flattens them: the same block, appended to the system prompt.
 * Either way the model reads the same words.
 *
 * The marks are invisible separators around a label, so a span that escaped
 * both paths would read as text rather than as markup.
 */

const OPEN = "⁣⟦";
const LABEL_END = "⟧";
const CLOSE = "⟦/⟧⁣";

const SPAN = new RegExp(
	`${OPEN}([^${LABEL_END}]*)${LABEL_END}([\\s\\S]*?)${CLOSE}`,
	"g",
);

/** What the static text says where a moved value was. */
export const PROMPT_ENVIRONMENT_REFERENCE = "see <environment>";

/** A value that belongs to this session, not to the prompt. `""` when empty. */
export function markPromptEnvironment(
	label: string,
	value: string | undefined,
): string {
	const text = value?.trim();
	return text ? `${OPEN}${label}${LABEL_END}${text}${CLOSE}` : "";
}

export function hasPromptEnvironment(text: string | undefined): boolean {
	return typeof text === "string" && text.includes(OPEN);
}

/**
 * Split a prompt into its static text and its environment block.
 *
 * `undefined` when there is nothing marked. Blank lines left where spans were
 * are collapsed, so the static text does not depend on which values a session
 * happened to have.
 */
export function hoistPromptEnvironment(
	text: string,
): { system: string; environment: string } | undefined {
	if (!hasPromptEnvironment(text)) {
		return undefined;
	}
	const entries: string[] = [];
	const system = text
		.replace(SPAN, (_match, label: string, value: string) => {
			entries.push(`## ${label}\n${value.trim()}`);
			return "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (entries.length === 0) {
		return { system, environment: "" };
	}
	return {
		system,
		environment: `<environment>\n${entries.join("\n\n")}\n</environment>`,
	};
}

/** The prompt as one text: the environment block appended to the static part. */
export function flattenPromptEnvironment(text: string): string {
	const hoisted = hoistPromptEnvironment(text);
	if (!hoisted) {
		return text;
	}
	return hoisted.environment
		? `${hoisted.system}\n\n${hoisted.environment}`
		: hoisted.system;
}
