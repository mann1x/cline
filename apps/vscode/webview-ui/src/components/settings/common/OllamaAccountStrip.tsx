import { StringRequest } from "@shared/proto/cline/common"
import type { OllamaAccountResponse, OllamaCatalogModel } from "@shared/proto/cline/models"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * What the configured Ollama endpoint knows about the account and the model.
 *
 * Three facts this panel used to guess, all of them read from the server:
 *
 * - **Whether the model is served from the cloud.** From `/api/tags`'
 *   `remote_host`, and from nothing else. The name does not say: on the
 *   reporter's own server `glm-5.3-flash-tpl2:latest` is a cloud model and
 *   `kimi-k2.6:cloud` reports a family, so neither the suffix nor a missing
 *   family is the discriminator people reach for first.
 * - **Whether the account can use it.** `/api/me` gives the plan, the
 *   recommendations list gives `required_plan`, and a `pro` model on a `free`
 *   account is a request that will fail — worth saying before it does rather
 *   than as an HTTP 402.
 * - **The model's real window and thinking settings.** A cloud tag has no
 *   `parameters` block, so there is no `num_ctx` to read and every one of them
 *   was being budgeted at the local default.
 *
 * Read once on mount and on a model change, deliberately. None of this moves
 * on its own, and the account read costs a signed round trip to ollama.com.
 *
 * Deliberately absent: cost. Ollama publishes no per-token price anywhere —
 * when it writes a model config for another agent client it hardcodes zero for
 * cloud models too — so a price shown here would be one we invented.
 */
export const OllamaAccountStrip = ({ providerId, modelId }: { providerId: string; modelId?: string }) => {
	const [status, setStatus] = useState<OllamaAccountResponse | undefined>()
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let cancelled = false
		ModelsServiceClient.readOllamaAccount(StringRequest.create({ value: providerId }))
			.then((next) => {
				if (!cancelled) {
					setStatus(next)
				}
			})
			.catch(() => {
				if (!cancelled) {
					setFailed(true)
				}
			})
		return () => {
			cancelled = true
		}
	}, [providerId])

	if (failed || !status?.reachable) {
		return null
	}

	const selected: OllamaCatalogModel | undefined = modelId ? status.models.find((model) => model.name === modelId) : undefined
	const recommendation = selected?.recommendation
	const cloudCount = status.models.filter((model) => model.cloud).length
	// Only a plan the server actually reported can fail this comparison. An
	// unreachable `/api/me` says nothing about the account, and a shortfall
	// warning drawn from its silence would tell a signed-in Pro user their plan
	// is too low. `signedIn` is not tested as well: the plan is only ever set
	// alongside it, so the second check would be a guard that cannot fire.
	const planShortfall = recommendation?.requiredPlan === "pro" && status.plan !== undefined && status.plan !== "pro"

	return (
		<div className="mt-[6px] text-xs text-(--vscode-descriptionForeground) flex flex-col gap-[4px]">
			<div>
				{status.signedIn
					? `Signed in as ${status.name}${status.plan ? ` · ${status.plan} plan` : ""}`
					: status.accountReachable
						? "Not signed in to ollama.com"
						: "Account status unavailable"}
				{cloudCount > 0 ? ` · ${cloudCount} cloud ${cloudCount === 1 ? "model" : "models"} available` : ""}
				{!status.signedIn && status.signinUrl ? (
					<>
						{" — "}
						<VSCodeLink className="text-xs" href={status.signinUrl}>
							sign in
						</VSCodeLink>
					</>
				) : null}
			</div>

			{selected && (
				<div>
					{selected.cloud ? "Cloud model" : "Local model"}
					{selected.remoteHost ? ` · served from ${new URL(selected.remoteHost).host}` : ""}
					{selected.family ? ` · ${selected.family}` : ""}
					{recommendation?.requiredPlan ? ` · requires ${recommendation.requiredPlan}` : ""}
				</div>
			)}

			{recommendation && (recommendation.contextLength !== undefined || recommendation.maxOutputTokens !== undefined) && (
				<div>
					{recommendation.contextLength !== undefined
						? `${recommendation.contextLength.toLocaleString()} token context`
						: ""}
					{recommendation.contextLength !== undefined && recommendation.maxOutputTokens !== undefined ? " · " : ""}
					{recommendation.maxOutputTokens !== undefined
						? `${recommendation.maxOutputTokens.toLocaleString()} max output`
						: ""}
				</div>
			)}

			{recommendation && recommendation.thinkingValues.length > 0 && (
				<div>
					Thinking: {recommendation.thinkingValues.join(", ")}
					{recommendation.thinkingDefault ? ` (default ${recommendation.thinkingDefault})` : ""}
				</div>
			)}

			{planShortfall && (
				<div className="text-(--vscode-errorForeground)">
					This model needs a pro plan; the signed-in account is on {status.plan}. Requests will be refused.
				</div>
			)}
		</div>
	)
}
