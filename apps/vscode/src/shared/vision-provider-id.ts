/**
 * Where the Vision tab keeps its provider settings.
 *
 * The API configuration panel writes through two paths. One is
 * `useApiConfigurationHandlers`, which the Vision tab redirects into its own
 * snapshot. The other is `useProviderConfig`, which writes providers.json keyed
 * by provider id alone — base URL, context window, thinking level, every
 * sampling parameter, and the per-mode model selection. That path was not
 * redirected, so the Vision tab and the Plan/Act tabs wrote the same entry:
 * picking a vision model overwrote the Act model selection, and retuning the
 * vision sampler retuned the primary model's.
 *
 * Suffixing the id gives the vision configuration its own entry, which is the
 * whole fix — every reader and writer already keys off the id, so there is one
 * place to change rather than one per provider.
 *
 * `parseProviderId` accepts unknown ids and treats them as custom providers, so
 * a suffixed id stores and reads like any other. Requests still go to the base
 * provider: the suffix names a settings entry, not a vendor.
 */
const VISION_PROVIDER_SUFFIX = "@vision"

/** The settings entry the Vision tab reads and writes for this provider. */
export function visionProviderId(providerId: string): string {
	return isVisionProviderId(providerId) ? providerId : `${providerId}${VISION_PROVIDER_SUFFIX}`
}

/** The vendor a settings entry belongs to, whichever tab stored it. */
export function baseProviderId(providerId: string): string {
	return isVisionProviderId(providerId) ? providerId.slice(0, -VISION_PROVIDER_SUFFIX.length) : providerId
}

export function isVisionProviderId(providerId: string): boolean {
	return providerId.endsWith(VISION_PROVIDER_SUFFIX)
}
