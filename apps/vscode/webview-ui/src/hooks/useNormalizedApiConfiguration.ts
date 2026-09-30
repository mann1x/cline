import type { ApiProvider, ModelInfo } from "@shared/api"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import { ResolveModelInfoRequest } from "@shared/proto/cline/models"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Mode } from "@shared/storage/types"
import { useEffect, useMemo, useState } from "react"
import { getModeSpecificFields, type NormalizedApiConfig } from "@/components/settings/utils/providerUtils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * Neutral placeholder returned while the catalog has not yet produced a
 * concrete `ModelInfo`. Callers that gate behavior on capabilities
 * (TaskHeader cost display, context-window meter, prompt-cache reasoning
 * surfaces) read these defaults as "we don't know yet" — see the field
 * comments at consumers.
 */
const unknownModelInfo: ModelInfo = {
	supportsPromptCache: false,
}

/**
 * Map a provider id to the `ApiConfiguration.{plan,act}Mode<…>ModelId`
 * field that stores its selected model id. For dynamic-list providers
 * (openrouter, openai-compatible, ollama, …) each one maintains its own
 * per-provider field; static-list providers share the common
 * `apiModelId` field.
 *
 * This mapping mirrors the writers in each provider component / picker
 * and the schema documented in `@/shared/storage/state-keys.ts`. When
 * adding a provider that needs its own model-id field, extend the map
 * here and the corresponding writer.
 */
export function getActiveProviderAndModelId(
	apiConfiguration: ReturnType<typeof useExtensionState>["apiConfiguration"],
	mode: Mode,
) {
	// State written by older builds or other hosts may carry SDK catalog
	// spellings (e.g. `openai-compatible`); fold them back to the legacy
	// `ApiProvider` spelling so the provider-keyed lookups below resolve.
	const provider = toLegacyApiProvider(
		(mode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) || "anthropic",
	) as ApiProvider
	const modeFields = getModeSpecificFields(apiConfiguration, mode)

	const modelId =
		provider === "vscode-lm"
			? modeFields.vsCodeLmModelSelector
				? `${modeFields.vsCodeLmModelSelector.vendor}/${modeFields.vsCodeLmModelSelector.family}`
				: undefined
			: (modeFields[modelIdFieldFor(provider)] as string | undefined)

	return { provider, modelId }
}

/**
 * The per-provider model-id fields, by provider. A provider not listed keeps
 * its model in the shared `apiModelId`. `vscode-lm` is absent on purpose: it
 * stores a selector object, not an id.
 */
const PROVIDER_MODEL_ID_FIELDS = {
	cline: "clineModelId",
	"cline-pass": "clinePassModelId",
	deepseek: "apiModelId",
	openai: "openAiModelId",
	openrouter: "openRouterModelId",
	requesty: "requestyModelId",
	litellm: "liteLlmModelId",
	"vercel-ai-gateway": "vercelAiGatewayModelId",
	ollama: "ollamaModelId",
	lmstudio: "lmStudioModelId",
	groq: "groqModelId",
	baseten: "basetenModelId",
	huggingface: "huggingFaceModelId",
	hicap: "hicapModelId",
	aihubmix: "aihubmixModelId",
	nousResearch: "nousResearchModelId",
	oca: "ocaModelId",
	"huawei-cloud-maas": "huaweiCloudMaasModelId",
	together: "togetherModelId",
	fireworks: "fireworksModelId",
	sapaicore: "apiModelId",
} as const satisfies Record<string, keyof ReturnType<typeof getModeSpecificFields>>

/**
 * The mode field that holds a provider's selected model id -- the name a
 * snapshot's `mode` record files it under, and the `ApiConfiguration` field
 * once prefixed with `planMode`/`actMode`. Not meaningful for `vscode-lm`,
 * whose selection is a selector object rather than an id; callers skip it.
 */
export function modelIdFieldFor(provider: string): keyof ReturnType<typeof getModeSpecificFields> {
	const legacy = toLegacyApiProvider(provider) as string
	return Object.hasOwn(PROVIDER_MODEL_ID_FIELDS, legacy)
		? PROVIDER_MODEL_ID_FIELDS[legacy as keyof typeof PROVIDER_MODEL_ID_FIELDS]
		: "apiModelId"
}

/**
 * Webview's universal handle on "what model is currently selected, with
 * what capabilities". Sources its answer from the extension over gRPC
 * (`ResolveModelInfo`), which combines the SDK catalog with the user's
 * committed selection.
 *
 * The returned `selectedModelInfo` may be `unknownModelInfo` for a few
 * render frames while the gRPC call is in flight, especially the first
 * time a provider is selected after a config change. UI callers must
 * treat `unknownModelInfo` as "no data yet" — render placeholders, do
 * not assume features are unsupported.
 */
export function useNormalizedApiConfiguration(mode: Mode): NormalizedApiConfig {
	const { apiConfiguration } = useExtensionState()
	const { provider, modelId } = getActiveProviderAndModelId(apiConfiguration, mode)
	const [resolvedInfo, setResolvedInfo] = useState<
		Awaited<ReturnType<typeof ModelsServiceClient.resolveModelInfo>> | undefined
	>(undefined)

	useEffect(() => {
		setResolvedInfo(undefined)
		let cancelled = false
		// The host-side handler awaits the catalog on a cache miss, so a
		// single round-trip yields authoritative data. We do not retry
		// or warm; if the response is `unknown`, the catalog truly has no
		// data and the UI renders a placeholder.
		void ModelsServiceClient.resolveModelInfo(
			ResolveModelInfoRequest.create({ providerId: provider, modelId: modelId || undefined }),
		)
			.then((response) => {
				if (!cancelled) {
					setResolvedInfo(response)
				}
			})
			.catch(() => {
				// The handler does not throw in production paths; a host-side
				// error here is logged at the gRPC layer. Leave resolvedInfo
				// undefined so the hook returns the neutral loading state.
			})
		return () => {
			cancelled = true
		}
	}, [provider, modelId])

	return useMemo(() => {
		if (!resolvedInfo || resolvedInfo.source === "unknown" || !resolvedInfo.modelInfo) {
			return {
				selectedProvider: provider,
				selectedModelId: resolvedInfo?.modelId || modelId || "",
				selectedModelInfo: unknownModelInfo,
			}
		}
		return {
			selectedProvider: provider,
			selectedModelId: resolvedInfo.modelId,
			selectedModelInfo: fromProtobufModelInfo(resolvedInfo.modelInfo),
		}
	}, [provider, modelId, resolvedInfo])
}
