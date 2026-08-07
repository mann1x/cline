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
}

export const ApiConfigurationScopeContext = createContext<ApiConfigurationScope | undefined>(undefined)

export const useApiConfigurationScope = (): ApiConfigurationScope | undefined => useContext(ApiConfigurationScopeContext)
