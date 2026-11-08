import type { CoreAgentMode } from "../../types/config";
import type { DefaultToolName, DefaultToolsConfig } from "./types";

export interface ToolRoutingRule {
	/**
	 * Optional rule label for debugging and logs.
	 */
	name?: string;
	/**
	 * Which mode the rule applies to.
	 * @default "any"
	 */
	mode?: CoreAgentMode | "any";
	/**
	 * Case-insensitive substrings that must match the model ID.
	 * When omitted/empty, the rule is not constrained by model ID.
	 */
	modelIdIncludes?: string[];
	/**
	 * A case-insensitive regular expression the model ID must match, for a
	 * rule a substring cannot state. Both this and `modelIdIncludes` must
	 * match when both are given.
	 */
	modelIdPattern?: string;
	/**
	 * Case-insensitive substrings that must match the provider ID.
	 * When omitted/empty, the rule is not constrained by provider ID.
	 */
	providerIdIncludes?: string[];
	/**
	 * Enable these tools when the rule matches.
	 */
	enableTools?: DefaultToolName[];
	/**
	 * Disable these tools when the rule matches.
	 */
	disableTools?: DefaultToolName[];
}

const TOOL_NAME_TO_FLAG: Record<
	DefaultToolName,
	keyof Pick<
		DefaultToolsConfig,
		| "enableReadFiles"
		| "enableSearch"
		| "enableBash"
		| "enableWebFetch"
		| "enableApplyPatch"
		| "enableEditor"
		| "enableGrep"
		| "enableSed"
		| "enableAwk"
		| "enableExtractDocument"
		| "enableSkills"
		| "enableAskQuestion"
		| "enableSubmitAndExit"
	>
> = {
	read_files: "enableReadFiles",
	search_codebase: "enableSearch",
	run_commands: "enableBash",
	fetch_web_content: "enableWebFetch",
	apply_patch: "enableApplyPatch",
	editor: "enableEditor",
	grep: "enableGrep",
	sed: "enableSed",
	awk: "enableAwk",
	extract_document: "enableExtractDocument",
	skills: "enableSkills",
	ask_question: "enableAskQuestion",
	submit_and_exit: "enableSubmitAndExit",
};

export const DEFAULT_MODEL_TOOL_ROUTING_RULES: ToolRoutingRule[] = [
	{
		name: "openai-native-use-apply-patch",
		mode: "act",
		providerIdIncludes: ["openai-native"],
		enableTools: ["apply_patch"],
		disableTools: ["editor"],
	},
	{
		name: "codex-and-gpt-use-apply-patch",
		mode: "act",
		// OpenAI's own models: `gpt-` and a version digit, or `codex`, as a
		// word. "gpt" anywhere took the editor from GPTQ quantisations and
		// from gpt-oss, which were not trained on apply_patch (automaticum
		// audit 2026-11-08, rest M9).
		modelIdPattern: "(^|[^a-z0-9])(gpt-\\d|codex)",
		enableTools: ["apply_patch"],
		disableTools: ["editor"],
	},
];

function matchesModelId(
	modelId: string,
	includes: string[] | undefined,
): boolean {
	if (!includes || includes.length === 0) {
		return true;
	}
	const normalizedModelId = modelId.toLowerCase();
	return includes.some((value) =>
		normalizedModelId.includes(value.toLowerCase()),
	);
}

function matchesModelIdPattern(
	modelId: string,
	pattern: string | undefined,
): boolean {
	if (!pattern) {
		return true;
	}
	try {
		return new RegExp(pattern, "i").test(modelId);
	} catch {
		// A rule that does not compile matches nothing rather than everything.
		return false;
	}
}

function matchesRule(
	rule: ToolRoutingRule,
	providerId: string,
	modelId: string,
	mode: CoreAgentMode,
): boolean {
	if (rule.mode && rule.mode !== "any" && rule.mode !== mode) {
		return false;
	}
	return (
		matchesModelId(providerId, rule.providerIdIncludes) &&
		matchesModelId(modelId, rule.modelIdIncludes) &&
		matchesModelIdPattern(modelId, rule.modelIdPattern)
	);
}

export function resolveToolRoutingConfig(
	providerId: string,
	modelId: string,
	mode: CoreAgentMode,
	rules: ToolRoutingRule[] | undefined,
): Partial<DefaultToolsConfig> {
	if (!rules || rules.length === 0) {
		return {};
	}

	const toggles = new Map<DefaultToolName, boolean>();

	for (const rule of rules) {
		if (!matchesRule(rule, providerId, modelId, mode)) {
			continue;
		}
		for (const toolName of rule.disableTools ?? []) {
			toggles.set(toolName, false);
		}
		for (const toolName of rule.enableTools ?? []) {
			toggles.set(toolName, true);
		}
	}

	const config: Partial<DefaultToolsConfig> = {};
	for (const [toolName, enabled] of toggles.entries()) {
		config[TOOL_NAME_TO_FLAG[toolName]] = enabled;
	}
	return config;
}
