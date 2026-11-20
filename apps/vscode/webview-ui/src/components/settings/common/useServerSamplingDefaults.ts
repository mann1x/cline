import { ServerSamplingDefaultsRequest } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * The providers on the OpenAI-compatible form that are llama.cpp servers and
 * answer `/props`: the generic OpenAI-compatible provider, which is how
 * llama.cpp is reached, and opencoti. The hosted providers on the same form
 * are not asked: they have no `/props`, and a settings panel has no business
 * sending them a request each time it opens.
 */
const PROPS_PROVIDERS = new Set(["openai-compatible", "opencoti"])

/**
 * What the server applies to a sampler a request leaves out, keyed by
 * llama.cpp's names, for the sampling placeholders -- the same question
 * Ollama's `/api/show` answers on the other form.
 *
 * Asked again when the base URL or the model changes: the values are the
 * running server's, after its flags and the model's own metadata. Empty while
 * pending, on a server that does not answer, or on a provider that is not a
 * llama.cpp server, and the fields then read "model default" as before.
 */
export function useServerSamplingDefaults(
	providerId: string,
	baseUrl: string | undefined,
	modelId: string | undefined,
): Record<string, string> {
	const [parameters, setParameters] = useState<Record<string, string>>({})
	const enabled = PROPS_PROVIDERS.has(providerId) && Boolean(baseUrl)
	useEffect(() => {
		setParameters({})
		if (!enabled) {
			return
		}
		let cancelled = false
		void ModelsServiceClient.readServerSamplingDefaults(
			ServerSamplingDefaultsRequest.create({ providerId, modelId: modelId || undefined }),
		)
			.then((response) => {
				if (!cancelled) {
					setParameters(response?.parameters ?? {})
				}
			})
			.catch(() => {
				// Placeholder text only; a server that is down leaves "model default".
			})
		return () => {
			cancelled = true
		}
		// baseUrl is a dependency although the host reads it from the stored
		// config: a changed URL is a different server.
	}, [providerId, enabled, baseUrl, modelId])
	return parameters
}
