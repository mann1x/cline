import { matchOllamaRecommendation, readOllamaAccountStatus } from "@cline/llms"
import { StringRequest } from "@/shared/proto/cline/common"
import { OllamaAccountResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * An Ollama endpoint's account and model catalog, for the settings panel.
 *
 * The base URL comes from the stored provider config rather than from the
 * request, so the panel shows the server it is configured against and cannot be
 * pointed somewhere else from the webview.
 *
 * Each of the three reads stands alone. `/api/me` is the only one that needs
 * the host to be signed in, and a refusal there must not take the
 * recommendations — which need no auth — down with it.
 */
export async function readOllamaAccount(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<OllamaAccountResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const status = await readOllamaAccountStatus(config.baseUrl)
	return OllamaAccountResponse.create({
		reachable: status.reachable,
		accountReachable: status.account.reachable,
		signedIn: status.account.signedIn,
		plan: status.account.plan,
		name: status.account.name,
		signinUrl: status.account.signinUrl,
		models: status.models.map((model) => {
			// Matched here rather than in the webview: `remote_model` is what
			// says which model a re-templated tag actually is, and it is a
			// catalog field the panel would otherwise have to carry and re-join.
			const recommendation = matchOllamaRecommendation(status.recommendations, {
				name: model.name,
				...(model.remoteModel ? { remoteModel: model.remoteModel } : {}),
			})
			return {
				name: model.name,
				cloud: model.cloud,
				remoteHost: model.remoteHost,
				remoteModel: model.remoteModel,
				family: model.family,
				capabilities: [...model.capabilities],
				...(recommendation
					? {
							recommendation: {
								model: recommendation.model,
								description: recommendation.description,
								contextLength: recommendation.contextLength,
								maxOutputTokens: recommendation.maxOutputTokens,
								requiredPlan: recommendation.requiredPlan,
								thinkingValues: [...(recommendation.thinkingValues ?? [])],
								thinkingDefault: recommendation.thinkingDefault,
							},
						}
					: {}),
			}
		}),
	})
}
