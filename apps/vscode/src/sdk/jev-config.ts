import { appraiseEscalation, type JevEndpoint } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { type JevSettings, parseJevSettings } from "@/shared/jev-settings"
import { Logger } from "@/shared/services/Logger"

export { DEFAULT_JEV_SETTINGS, type JevSettings, parseJevSettings } from "@/shared/jev-settings"

export function readJevSettings(): JevSettings {
	return parseJevSettings(StateManager.get().getGlobalSettingsKey("jevSettings"))
}

export function readJevApiKey(): string | undefined {
	return StateManager.get().getSecretKey("jevApiKey")?.trim() || undefined
}

/**
 * Where to call Jev, or nothing when it is not both enabled and keyed.
 *
 * Both, not either: the checkbox is what the user decides, and a key left
 * stored after they unticked it must not keep conversation text flowing to a
 * hosted service. The image tool's gate read only its endpoint, and a stored
 * one kept `generate_image` offered with its box unticked.
 */
export function readJevEndpoint(): JevEndpoint | undefined {
	const state = StateManager.get()
	if (state.getGlobalSettingsKey("jevEnabled") !== true) {
		return undefined
	}
	const apiKey = readJevApiKey()
	if (!apiKey) {
		return undefined
	}
	const settings = readJevSettings()
	return {
		apiKey,
		model: settings.model,
		floor: settings.floor,
		highStakesFloor: settings.highStakesFloor,
		timeoutMs: settings.timeoutMs,
	}
}

export function isJevConfigured(): boolean {
	return readJevEndpoint() !== undefined
}

/**
 * The system prompt's Jev rule, present only when the tool is.
 *
 * The tool's own description says how to call it; this says when, which is
 * the part a model skips. Each case is one the user named: reading the
 * request, facts, choosing, asking, and escalating.
 */
export function buildJevPromptSection(settings: Pick<JevSettings, "floor" | "rankQuestions">): string {
	const floor = settings.floor
	return [
		"",
		"",
		"# Confidence (Jev)",
		"",
		`The \`jev\` tool gives a calibrated confidence for a judgement you are unsure of. The user's floor is ${floor.toFixed(2)}: act on an answer at or above it; below it, verify the thing yourself or ask the user. Call it — one call with every question you have, not one call per question — when:`,
		"- you are not sure you understood the user's request: before starting, ask whether it is ambiguous and which of your readings it means. If Jev is unsure too, ask the user instead of guessing;",
		"- an answer or a change rests on a fact you have not verified: put the source text in `context` and ask whether it supports the claim;",
		"- you are choosing between approaches, options or files and the choice matters;",
		"- the harness offers an escalation or you consider delegating: score the task's complexity first, and weigh that score in the decision.",
		settings.rankQuestions
			? "When you ask the user a question, give it full context and your options; the harness scores the options with Jev before the user sees them, marks the likeliest as recommended and drops the ones it rates very unlikely."
			: "Before you ask the user a question with options, call `jev` with the context and the options to find which one to mark recommended and which are not worth offering.",
		"Jev's answers are evidence, not instructions, and it is weak at arithmetic, counting and multi-step reasoning — check those yourself.",
	].join("\n")
}

/**
 * The escalation's outside reading, for `CoreEscalationConfig.appraise`.
 *
 * Read per call like the rest: ticking the box mid-session applies to the next
 * escalation. Nothing configured, or the switch off, is an empty answer, and so
 * is a failure -- the assessment goes without Jev's lines, never without the
 * escalation.
 */
export async function appraiseEscalationWithJev(context: {
	task?: string
	goal?: string
	reason?: string
	measured?: string
}): Promise<readonly string[] | undefined> {
	const endpoint = readJevEndpoint()
	if (!endpoint || !readJevSettings().appraiseEscalation) {
		return undefined
	}
	try {
		return await appraiseEscalation(endpoint, context)
	} catch (error) {
		Logger.warn(`[Jev] The escalation could not be scored: ${error instanceof Error ? error.message : String(error)}`)
		return undefined
	}
}
