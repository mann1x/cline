import type { ProviderSettings } from "@cline/core";
import type { CliReasoningEffort } from "./types";

type ActiveCliReasoningEffort = Exclude<CliReasoningEffort, "none">;

const ACTIVE_REASONING_EFFORTS = new Set<ActiveCliReasoningEffort>([
	"low",
	"medium",
	"high",
	"xhigh",
]);

export interface ResolveCliReasoningInput {
	thinking: boolean;
	thinkingExplicitlySet?: boolean;
	reasoningEffort?: CliReasoningEffort;
	persistedReasoning?: ProviderSettings["reasoning"];
}

export interface ResolvedCliReasoning {
	thinking?: boolean;
	reasoningEffort?: ActiveCliReasoningEffort;
}

function isActiveReasoningEffort(
	effort: unknown,
): effort is ActiveCliReasoningEffort {
	return (
		typeof effort === "string" &&
		ACTIVE_REASONING_EFFORTS.has(effort as ActiveCliReasoningEffort)
	);
}

export function resolveCliReasoning({
	thinking,
	thinkingExplicitlySet,
	reasoningEffort,
	persistedReasoning,
}: ResolveCliReasoningInput): ResolvedCliReasoning {
	if (thinkingExplicitlySet) {
		return {
			thinking,
			reasoningEffort: isActiveReasoningEffort(reasoningEffort)
				? reasoningEffort
				: undefined,
		};
	}

	if (
		persistedReasoning?.enabled === false ||
		persistedReasoning?.effort === "none"
	) {
		return { thinking: false, reasoningEffort: undefined };
	}

	if (isActiveReasoningEffort(persistedReasoning?.effort)) {
		return { thinking: true, reasoningEffort: persistedReasoning.effort };
	}

	if (persistedReasoning?.enabled === true) {
		// On, with no level named. Deliberately not `medium`: a level is not a
		// synonym for "on" on every provider. On Ollama a level *is* a thinking
		// budget and outranks the model's own `PARAMETER think_budget`, so
		// naming one here capped an otherwise unbounded model at 2,000 tokens
		// and halved a model declaring `high`. The provider decides what an
		// unlevelled "on" means; `provider.ollama.native-options` turns it into
		// a bare `think: true`.
		return { thinking: true, reasoningEffort: undefined };
	}

	return { thinking: undefined, reasoningEffort: undefined };
}
