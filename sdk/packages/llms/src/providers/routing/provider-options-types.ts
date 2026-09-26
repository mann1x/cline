import type {
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import type { ProviderOptionsPatch } from "./utils";

export type AiSdkProviderOptionsTarget =
	| "cline"
	| "openai"
	| "openai-compatible"
	| "anthropic"
	| "google"
	| "vertex"
	| "bedrock"
	| "mistral"
	| "claude-code"
	| "openai-codex"
	| "opencode"
	| "dify"
	| "ollama"
	| "opencoti"
	| "sapaicore";

export type ProviderOptionSuppression = {
	genericThinking?: boolean;
	genericFanout?: boolean;
};

export type ProviderOptionMatchInput = {
	request: GatewayStreamRequest;
	context: GatewayProviderContext;
	providerOptionsKey: string;
	target: AiSdkProviderOptionsTarget;
	/**
	 * The effort level the AI SDK would have sent as `reasoning_effort`.
	 *
	 * `request.reasoning` is gone by the time a rule runs — `withoutPortableReasoning`
	 * moves the intent into the SDK's own call option and clears it, because the
	 * SDK ignores top-level reasoning once provider options carry a reasoning
	 * control. A rule that has to *translate* the level rather than pass it
	 * through therefore has nothing to read, which is how llama.cpp came to be
	 * sent a field it discards and no budget at all.
	 */
	portableReasoning?: string;
	/**
	 * The reasoning the caller actually asked for, untouched.
	 *
	 * `portableReasoning` cannot stand in for it in either direction. It reports
	 * `"medium"` for a bare `enabled: true`, so a rule reading it cannot tell a
	 * level the user chose from one the portable resolver invented; and
	 * `normalizeReasoningRequest` erases an explicit `enabled: false` entirely
	 * for a model that advertises no off control, so an off becomes
	 * indistinguishable from never having asked.
	 *
	 * A rule that must not invent a level, and must not override an explicit
	 * off, needs the intent as it arrived. `provider.ollama.native-options` is
	 * the one that does.
	 */
	requestedReasoning?: GatewayStreamRequest["reasoning"];
};

export type ProviderOptionBuildInput = ProviderOptionMatchInput & {
	compatibleOptions: Record<string, unknown>;
	anthropicOptions: Record<string, unknown>;
	suppressions: ProviderOptionSuppression;
};

export type ProviderOptionRule = {
	id: string;
	phase:
		| "adapter"
		| "provider"
		| "provider-fanout"
		| "provider-reasoning"
		| "model-family"
		| "model-overlay";
	description: string;
	applies(input: ProviderOptionMatchInput): boolean;
	suppresses?: ProviderOptionSuppression;
	build(input: ProviderOptionBuildInput): ProviderOptionsPatch | undefined;
};

export type MatchedProviderOptionRule = {
	rule: ProviderOptionRule;
};

export function inferProviderOptionsTarget(
	providerId: string,
): AiSdkProviderOptionsTarget {
	switch (providerId) {
		case "cline":
		case "cline-pass":
			return "cline";
		case "openai-native":
			return "openai";
		case "anthropic":
			return "anthropic";
		case "google":
		case "gemini":
			return "google";
		case "vertex":
			return "vertex";
		case "bedrock":
			return "bedrock";
		case "mistral":
			return "mistral";
		case "claude-code":
			return "claude-code";
		case "openai-codex":
			return "openai-codex";
		case "opencode":
			return "opencode";
		case "dify":
			return "dify";
		// xOllama is Ollama's wire: every Ollama option rule holds for it.
		case "ollama":
		case "xollama":
			return "ollama";
		case "sapaicore":
			return "sapaicore";
		default:
			return "openai-compatible";
	}
}
