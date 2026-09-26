export function isClineProvider(providerId: string): boolean {
	return providerId === "cline" || providerId === "cline-pass";
}

/**
 * Providers that speak Ollama's native API: `/api/chat`, `options.num_ctx`,
 * `think`, `/api/show`. xOllama is an Ollama fork that may run opencoti as its
 * engine; everything that holds for Ollama's wire holds for it. What does not
 * -- Ollama Cloud's account, the ollama.com catalog -- checks `"ollama"` by
 * name instead.
 */
export function isOllamaNativeProvider(
	providerId: string | undefined | null,
): boolean {
	return providerId === "ollama" || providerId === "xollama";
}
