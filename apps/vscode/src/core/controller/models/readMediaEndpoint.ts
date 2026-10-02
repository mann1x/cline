import { listMediaModels, MEDIA_KINDS, type MediaKind } from "@cline/core"
import { String as ProtoString, StringRequest } from "@shared/proto/cline/common"
import { readImageEditTab, readImageGenerationTab } from "@/sdk/image-generation-config"
import { type MediaTabSettings, probeMediaServer, readLeadMediaProvider, resolveMediaTab } from "@/sdk/media-endpoint-config"
import type { MediaEndpointStatus } from "@/shared/media-endpoint-status"
import { Controller } from ".."

/** The tab that configures each kind. A kind with no tab yet has no entry. */
const TABS: Partial<Record<MediaKind, () => MediaTabSettings>> = {
	image_generation: readImageGenerationTab,
	image_edit: readImageEditTab,
}

/**
 * Where one kind of media tool would go right now, and why.
 *
 * Asked by the settings tab rather than worked out in it: the answer depends
 * on what two servers serve, and on a key the webview is never given. It is
 * the same resolution the session runs when it builds its tools, so what the
 * tab says is what the next session does.
 */
export async function readMediaEndpoint(_controller: Controller, request: StringRequest): Promise<ProtoString> {
	const kind = request.value as MediaKind
	const status: MediaEndpointStatus = {}
	const tab = MEDIA_KINDS.includes(kind) ? TABS[kind]?.() : undefined
	if (!tab) {
		return ProtoString.create({ value: JSON.stringify({ disabled: "no settings exist for this yet" }) })
	}
	try {
		const provider = readLeadMediaProvider()
		const probe = provider?.baseUrl ? await probeMediaServer(provider.baseUrl, provider.apiKey) : undefined
		if (probe) {
			const serves = probe.server !== "openai" && probe.kinds[kind] === true
			status.provider = {
				server: probe.server,
				serves,
				// Only what the server says serves it: a chat model listed next
				// to the image engine is not a choice here.
				models: serves ? listMediaModels({ ...probe, models: probe.models.filter((m) => m.kinds) }, kind) : [],
			}
		}
		// What the typed endpoint itself lists for this kind, for the picker.
		const typedProbe = tab.baseUrl?.trim() ? await probeMediaServer(tab.baseUrl, tab.apiKey) : undefined
		if (typedProbe) {
			status.typedModels = listMediaModels(typedProbe, kind)
		}
		const resolved = await resolveMediaTab(kind, tab, provider)
		if ("disabled" in resolved) {
			status.disabled = resolved.disabled
		} else {
			status.resolved = {
				source: resolved.source,
				server: resolved.server,
				model: resolved.endpoint.model,
				...(resolved.warning ? { warning: resolved.warning } : {}),
			}
		}
	} catch (error) {
		status.disabled = error instanceof Error ? error.message : String(error)
	}
	return ProtoString.create({ value: JSON.stringify(status) })
}
