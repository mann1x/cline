import { StringRequest } from "@shared/proto/cline/common"
import type {
	ImageSupport,
	RetrievalAction,
	RetrievalActionResult,
	RetrievalImageModels,
	RetrievalImageSupport,
} from "@shared/retrieval-status"
import { useEffect, useState } from "react"
import { StateServiceClient } from "@/services/grpc-client"

/** The scope key of the tab whose model describes pictures. */
export const VISION_SCOPE_KEY = "visionModeApiConfiguration"

async function ask(action: RetrievalAction): Promise<RetrievalActionResult | undefined> {
	try {
		const response = await StateServiceClient.retrievalAction(StringRequest.create({ value: JSON.stringify(action) }))
		return JSON.parse(response.value) as RetrievalActionResult
	} catch (error) {
		console.error("Failed to ask which models read images:", error)
		return undefined
	}
}

/**
 * What the Vision tab's model and each saved profile's model can do, asked
 * again whenever `changed` does — the stored profiles, or the tab's snapshot.
 */
export function useImageSupport(changed: string | undefined): RetrievalImageSupport | undefined {
	const [support, setSupport] = useState<RetrievalImageSupport>()
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changed` is the trigger, not an input.
	useEffect(() => {
		let alive = true
		void ask({ action: "imageSupport" }).then((result) => {
			if (alive) {
				setSupport(result?.imageSupport)
			}
		})
		return () => {
			alive = false
		}
	}, [changed])
	return support
}

/** One Ollama or xOllama server's models split by what it reports; nothing while `enabled` is off. */
export function useImageModels(
	providerId: string,
	baseUrl: string | undefined,
	enabled: boolean,
): RetrievalImageModels | undefined {
	const [models, setModels] = useState<RetrievalImageModels>()
	useEffect(() => {
		if (!enabled) {
			setModels(undefined)
			return
		}
		let alive = true
		void ask({ action: "imageModels", providerId, ...(baseUrl ? { baseUrl } : {}) }).then((result) => {
			if (alive) {
				setModels(result?.imageModels)
			}
		})
		return () => {
			alive = false
		}
	}, [providerId, baseUrl, enabled])
	return models
}

/**
 * The models a picture-describing picker offers: everything the server did not
 * report as unable to read images. The selected model stays, so a choice made
 * before the filter existed is shown rather than silently blanked.
 */
export function modelsThatMayReadImages(
	models: readonly string[],
	reported: RetrievalImageModels | undefined,
	selected: string | undefined,
): string[] {
	if (!reported?.reported) {
		return [...models]
	}
	const cannot = new Set(reported.notVision)
	return models.filter((model) => model === selected || !cannot.has(model))
}

export interface DescribingProfile {
	name: string
	model: string
	images: ImageSupport
}

/** The saved profiles the Library offers for describing pictures. Same rule: only a reported "no" is left out. */
export function profilesThatMayReadImages(
	names: readonly string[],
	support: RetrievalImageSupport | undefined,
	selected: string,
): DescribingProfile[] {
	const answers = new Map((support?.profiles ?? []).map((profile) => [profile.name, profile]))
	return names
		.map((name) => ({
			name,
			model: answers.get(name)?.model ?? "",
			images: answers.get(name)?.images ?? ("unknown" as const),
		}))
		.filter((profile) => profile.name === selected || profile.images !== "no")
}
