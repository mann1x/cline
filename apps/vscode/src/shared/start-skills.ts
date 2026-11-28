/**
 * Skills that start every new conversation (Skills tab, the ▶ on a skill).
 *
 * Stored as one JSON setting, `startSkills`: `[{name, message?}]`, by skill
 * name -- the same name `/name` resolves -- so a skill keeps its place whether
 * it is global, workspace or built in.
 *
 * Two behaviours, both opt-in per skill:
 *  - the user's first message of a new conversation is sent as if it began
 *    with `/name` (skipped when the message already names it);
 *  - a skill with a message starts the conversation by itself when the user
 *    opens a new chat: `/name message` is sent without typing anything.
 */

export interface StartSkill {
	name: string
	/** Sent automatically when a new chat is opened; empty means "wait for the user's message". */
	message?: string
}

export function parseStartSkills(raw: string | undefined): StartSkill[] {
	if (!raw) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	const seen = new Set<string>()
	return parsed.flatMap((item) => {
		if (!item || typeof item !== "object") return []
		const record = item as Record<string, unknown>
		const name = typeof record.name === "string" ? record.name.trim() : ""
		if (!name || seen.has(name)) return []
		seen.add(name)
		const message = typeof record.message === "string" ? record.message.trim() : ""
		return [message ? { name, message } : { name }]
	})
}

export function serializeStartSkills(skills: readonly StartSkill[]): string {
	return skills.length === 0 ? "" : JSON.stringify(skills)
}

export function setStartSkill(skills: readonly StartSkill[], name: string, on: boolean): StartSkill[] {
	const rest = skills.filter((skill) => skill.name !== name)
	if (!on) return rest
	const existing = skills.find((skill) => skill.name === name)
	return [...rest, existing ?? { name }]
}

export function setStartSkillMessage(skills: readonly StartSkill[], name: string, message: string): StartSkill[] {
	const text = message.trim()
	return skills.map((skill) => (skill.name === name ? (text ? { name, message: text } : { name }) : skill))
}

const mentions = (text: string, name: string) =>
	new RegExp(`(^|\\s)/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.md)?(?=\\s|$)`).test(text)

/** The first message of a new conversation, with the start skills it does not already name in front. */
export function withStartSkills(text: string, skills: readonly StartSkill[]): string {
	const missing = skills.filter((skill) => !mentions(text, skill.name)).map((skill) => `/${skill.name}`)
	if (missing.length === 0) return text
	return text.trim() ? `${missing.join(" ")} ${text}` : missing.join(" ")
}

/** What to send when a new chat opens, or nothing when no start skill has a message. */
export function autoStartMessage(skills: readonly StartSkill[]): string | undefined {
	const messages = skills.map((skill) => skill.message?.trim()).filter((message): message is string => !!message)
	if (messages.length === 0) return undefined
	return `${skills.map((skill) => `/${skill.name}`).join(" ")} ${messages.join("\n\n")}`
}
