/**
 * Where an Ollama-API provider is reached when no base URL is configured.
 *
 * Ollama's own code treats an unset base URL as Ollama's default endpoint
 * (:11434). xOllama runs on its own port so it can sit beside a stock Ollama,
 * and an unset URL sent there would ask the wrong server.
 */
export const XOLLAMA_DEFAULT_BASE_URL = "http://localhost:22434"

/** `baseUrl`, or xOllama's default port when it is xOllama's and unset. */
export function withOllamaNativeDefault(providerId: string | undefined, baseUrl: string | undefined): string | undefined {
	if (baseUrl?.trim()) {
		return baseUrl
	}
	return providerId === "xollama" ? XOLLAMA_DEFAULT_BASE_URL : baseUrl
}
