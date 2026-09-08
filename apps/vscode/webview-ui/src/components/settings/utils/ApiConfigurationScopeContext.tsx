import type { ApiConfiguration } from "@shared/api"
import { createContext, useContext } from "react"

/**
 * Redirects where the API configuration panel writes.
 *
 * The Vision tab shows the same panel as Plan and Act, but its settings belong
 * to a second model rather than to the session's configuration. Rather than
 * teach every field in the panel about a third destination, the tab renders the
 * ordinary panel inside a scope: reads come from an overridden
 * `ExtensionStateContext`, and writes come here instead of going straight to
 * the extension.
 */
export interface ApiConfigurationScope {
	/** Receives the whole configuration with the edit already applied. */
	save: (configuration: ApiConfiguration) => Promise<void>
	/**
	 * Whether provider settings belong to this scope rather than the session.
	 *
	 * `useApiConfigurationHandlers` was the only write path this context
	 * redirected. `useProviderConfig` writes providers.json keyed by provider id
	 * alone, so the Vision tab and the Plan/Act tabs shared one entry — and the
	 * model selection is stored per mode in that same entry, so choosing a
	 * vision model overwrote Act's. This tells that hook to key off its own
	 * entry instead.
	 */
	ownsProviderSettings?: boolean
	/**
	 * The provider settings this scope holds, and how to change them.
	 *
	 * Not the host's provider store. `commitSelection` there writes the global
	 * `<mode>ModeApiProvider` and model-id keys as well as providers.json, so a
	 * second configuration routed through it does not get its own entry — it
	 * overwrites the session's. Measured: choosing a vision model wrote nothing
	 * under the scoped id and left the picker showing the first model in the
	 * list, because nothing had been committed anywhere it reads from.
	 */
	providerSettings?: Record<string, unknown>
	writeProviderSettings?: (patch: Record<string, unknown>) => Promise<void>
	/**
	 * The whole selection, not just its model id.
	 *
	 * This took `modelId: string` and dropped everything else on the floor,
	 * which is where Per-Turn Max Output Tokens went: that field writes through
	 * `commitModelSelection` with `overrides.maxTokens`, so on Vision and Agents
	 * it could not be saved at all — the value was discarded before it reached
	 * the snapshot, and the panel showed the old one back.
	 */
	commitModelSelection?: (selection: ScopedModelSelection) => Promise<void>
}

/** What a scoped tab stores when a model is committed on it. */
export interface ScopedModelSelection {
	modelId: string
	overrides?: Record<string, unknown>
}

export const ApiConfigurationScopeContext = createContext<ApiConfigurationScope | undefined>(undefined)

export const useApiConfigurationScope = (): ApiConfigurationScope | undefined => useContext(ApiConfigurationScopeContext)
