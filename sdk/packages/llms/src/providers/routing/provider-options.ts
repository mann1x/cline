import type {
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { buildAnthropicProviderOptions } from "./anthropic-compatible";
import { buildCompatibleProviderOptions } from "./generic-compatible";
import {
	resolvePortableReasoning,
	withoutPortableReasoning,
} from "./portable-reasoning";
import {
	buildProviderOptionRulePatches,
	matchProviderOptionRules,
	PROVIDER_OPTION_RULES,
	resolveProviderOptionSuppressions,
} from "./provider-option-rules";
import {
	type AiSdkProviderOptionsTarget,
	inferProviderOptionsTarget,
	type ProviderOptionMatchInput,
} from "./provider-options-types";
import { normalizeReasoningRequest } from "./reasoning-options";
import { type ProviderOptionsPatch, toProviderOptionsKey } from "./utils";

export type { AiSdkProviderOptionsTarget } from "./provider-options-types";
export type { ProviderOptionsPatch } from "./utils";

/**
 * Merge patches in order. Later patches override earlier ones per bucket key;
 * nested object values are replaced, not deep-merged.
 */
export function mergeProviderOptionPatches(
	patches: ReadonlyArray<ProviderOptionsPatch | undefined>,
): Record<string, unknown> {
	const result: Record<string, Record<string, unknown>> = {};
	for (const patch of patches) {
		if (!patch) {
			continue;
		}
		for (const [bucket, options] of Object.entries(patch)) {
			result[bucket] = { ...(result[bucket] ?? {}), ...options };
		}
	}
	return result;
}

function buildBaseProviderOptionsPatch(
	compatibleOptions: Record<string, unknown>,
	anthropicOptions: Record<string, unknown>,
): ProviderOptionsPatch {
	return {
		anthropic: anthropicOptions,
		openaiCompatible: compatibleOptions,
	};
}

/**
 * Compose AI SDK `providerOptions` from named provider/model-family rules.
 *
 * The rule table in `provider-option-rules.ts` is the behavior matrix for
 * special providers and model families. Keep the composer boring: build shared
 * buckets once, then merge ordered rule patches.
 *
 * Routing ownership boundary:
 * - Gateway model capabilities say what a model can do, such as reasoning.
 * - Model metadata records stable known-model facts, such as
 *   `reasoningDefaultOn`.
 * - Provider metadata records stable provider policy, such as prompt caching.
 * - Provider-option rules encode only non-portable request intent into
 *   provider wire formats, such as exact budgets and native toggle objects.
 */
export function composeAiSdkProviderOptions(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
	target: AiSdkProviderOptionsTarget = inferProviderOptionsTarget(
		request.providerId,
	),
): Record<string, unknown> {
	const normalizedRequest = normalizeReasoningRequest(
		withoutPortableReasoning(request),
		context,
	);
	const providerOptionsKey = toProviderOptionsKey(normalizedRequest.providerId);
	// Resolved from the request as it arrived, because the line above has
	// already taken the intent off it -- and, for a provider that keeps its
	// intent, because `normalizeReasoningRequest` clamps the level to what the
	// model *declares* it supports. A llama.cpp server declares nothing, so the
	// clamp silently turned Max into High and a rule translating the level would
	// have quietly resolved the wrong budget.
	const portableReasoning =
		resolvePortableReasoning(request) ?? request.reasoning?.effort;
	const matchInput: ProviderOptionMatchInput = {
		request: normalizedRequest,
		context,
		providerOptionsKey,
		target,
		...(typeof portableReasoning === "string" ? { portableReasoning } : {}),
		// Also from the request as it arrived, and for a sharper reason than the
		// line above: normalization erases an explicit off, and the portable
		// resolver invents a level for a bare `enabled: true`. Both are lossy in
		// the direction a rule deciding whether to send `think` cares about.
		...(request.reasoning ? { requestedReasoning: request.reasoning } : {}),
	};
	const matchedRules = matchProviderOptionRules(
		PROVIDER_OPTION_RULES,
		matchInput,
	);
	const suppressions = resolveProviderOptionSuppressions(matchedRules);
	const compatibleOptions = buildCompatibleProviderOptions({
		request: normalizedRequest,
		context,
		target,
		suppressions,
	});
	const anthropicOptions = buildAnthropicProviderOptions(
		normalizedRequest,
		context,
	);
	const buildInput = {
		...matchInput,
		compatibleOptions,
		anthropicOptions,
		suppressions,
	};

	return mergeProviderOptionPatches([
		buildBaseProviderOptionsPatch(compatibleOptions, anthropicOptions),
		...buildProviderOptionRulePatches(matchedRules, buildInput),
	]);
}
