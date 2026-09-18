import type { BasicLogger } from "@cline/shared";

/**
 * Silence a warning about a request that is never sent.
 *
 * `ollama-ai-provider-v2` builds every chat request twice. `prepareRequest`
 * runs `convertToOllamaResponsesMessages` and keeps **only its warnings** --
 * the messages are destructured away and dropped on the floor -- and then
 * builds the body from `convertToOllamaChatMessages`, which carries `thinking`
 * as a field on the assistant message. So the responses converter is dead code
 * whose sole effect is to complain, once per reasoning part per request, that
 * reasoning "is not supported", about a conversion the provider then discards.
 *
 * Measured: 23,695 of them in one transaction, about 87 per request. The cost
 * is not the logging -- it is that a log with 87 identical false warnings per
 * request is a log nobody reads, so the real warnings in it are gone too. That
 * is the reason to filter rather than to set `AI_SDK_LOG_WARNINGS = false`,
 * which would take the real ones with it.
 *
 * Keyed on the vendor's own name for the converter (`for Ollama responses`)
 * under an `ollama.responses` provider id, and on nothing else. A provider that
 * genuinely cannot carry reasoning keeps saying so, and so does ollama's *chat*
 * converter, whose warnings are about the request that does go out.
 *
 * The invariant is asserted against the installed package in the test beside
 * this file, so a version bump that makes the responses converter live fails
 * there rather than hiding a real limitation here.
 */

interface AiSdkWarning {
	type?: string;
	message?: string;
	setting?: string;
	details?: string;
}

interface AiSdkWarningPayload {
	provider?: string;
	model?: string;
	warnings: AiSdkWarning[];
}

type WarningLogger = (payload: AiSdkWarningPayload) => void;

interface WarningGlobal {
	AI_SDK_LOG_WARNINGS?: WarningLogger | boolean;
}

/** The provider id the dead converter reports itself under. */
const DEAD_CONVERTER_PROVIDER = "ollama.responses";
/** The vendor's own wording for which converter emitted a warning. */
const DEAD_CONVERTER_MARKER = "for Ollama responses";

let installed: WarningLogger | undefined;
let suppressed = 0;
let announced = false;

/** How many false warnings have been dropped since the logger was installed. */
export function suppressedWarningCount(): number {
	return suppressed;
}

function isDeadConverterWarning(
	payload: AiSdkWarningPayload,
	warning: AiSdkWarning,
): boolean {
	return (
		payload.provider === DEAD_CONVERTER_PROVIDER &&
		typeof warning.message === "string" &&
		warning.message.includes(DEAD_CONVERTER_MARKER)
	);
}

function describe(payload: AiSdkWarningPayload, warning: AiSdkWarning): string {
	const where = [payload.provider, payload.model].filter(Boolean).join(" ");
	if (typeof warning.message === "string" && warning.message.length > 0) {
		return `AI SDK warning${where ? ` (${where})` : ""}: ${warning.message}`;
	}
	if (typeof warning.setting === "string") {
		return `AI SDK warning${where ? ` (${where})` : ""}: unsupported setting \`${warning.setting}\`${
			warning.details ? ` -- ${warning.details}` : ""
		}`;
	}
	return `AI SDK warning${where ? ` (${where})` : ""}: ${warning.type ?? "unknown"}`;
}

/**
 * Route the AI SDK's warnings through our logger, minus the false ones.
 *
 * Idempotent: the SDK reads one global, and installing twice from two provider
 * modules would otherwise leave whichever ran last holding a stale logger.
 */
export function installAiSdkWarningLogger(options?: {
	logger?: BasicLogger;
}): void {
	if (installed) {
		return;
	}
	const logger = options?.logger;
	const log: WarningLogger = (payload) => {
		const kept: AiSdkWarning[] = [];
		let dropped = 0;
		for (const warning of payload.warnings ?? []) {
			if (isDeadConverterWarning(payload, warning)) {
				dropped += 1;
				continue;
			}
			kept.push(warning);
		}
		if (dropped > 0) {
			suppressed += dropped;
			if (!announced) {
				announced = true;
				// Once, and said out loud: a filter nobody can see is
				// indistinguishable from a provider that stopped warning.
				logger?.log(
					"Hiding ollama's warnings about reasoning parts: they come from its unused responses converter, " +
						"whose output the provider discards before building the request. The request itself carries " +
						"`thinking`. Real warnings are unaffected.",
					{ severity: "info" },
				);
			}
		}
		for (const warning of kept) {
			logger?.log(describe(payload, warning), { severity: "warn" });
		}
	};
	installed = log;
	(globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS = log;
}

export function resetAiSdkWarningLogger(): void {
	installed = undefined;
	suppressed = 0;
	announced = false;
	delete (globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS;
}
