/**
 * The context window of an agent that runs a model the session does not.
 *
 * An agent file, a profile or a spawn can name another model on the session's
 * Ollama server. The session's `knownModels` describe the session's model and
 * nothing else, so the agent's model had no window: the gateway sized its
 * output as uncapped and compaction had no trigger, while the Ollama provider
 * still sent a `num_ctx` -- the model's own, or the 32,768 default. The agent
 * worked against a wall nothing on this side could see. Reported 2026-11-26
 * (mann1x/cline#118): a `docker-deploy` agent on a local 27B, under a session
 * of 1,048,576, had its turns cut at the window and compacted only after each
 * overflow, five times in half an hour.
 *
 * The fix is the rule the session already follows (`readResolvedOllamaWindow`):
 * the wire's `num_ctx` and the budget come from one value. The window written
 * here is exactly what `readOllamaNumCtx` will send for this model, so the two
 * cannot disagree, and `/api/show` is read first so a model that declares a
 * window of its own gets it rather than the default.
 */

import {
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	primeDeclaredNumCtx,
	readResolvedOllamaWindow,
} from "@cline/llms";
import type { AgentConfig } from "@cline/shared";
import { isOllamaNativeProvider } from "@cline/shared";

type ModelWindowConnection = Pick<
	AgentConfig,
	"providerId" | "modelId" | "baseUrl" | "providerConfig" | "knownModels"
>;

type ModelEntry = { contextWindow?: number; maxInputTokens?: number };

const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

function providerKnownModels(
	connection: ModelWindowConnection,
): Record<string, ModelEntry> | undefined {
	const config = connection.providerConfig as
		| { knownModels?: Record<string, ModelEntry> }
		| undefined;
	return config?.knownModels;
}

function baseUrlOf(connection: ModelWindowConnection): string | undefined {
	return (
		connection.baseUrl ??
		(connection.providerConfig as { baseUrl?: string } | undefined)?.baseUrl
	);
}

/** Whether something already states this model's window: the session's, a profile's, a catalog's. */
function statesWindow(connection: ModelWindowConnection): boolean {
	const id = connection.modelId;
	const entries = [
		connection.knownModels?.[id] as ModelEntry | undefined,
		providerKnownModels(connection)?.[id],
	];
	return entries.some(
		(entry) =>
			positive(entry?.contextWindow) || positive(entry?.maxInputTokens),
	);
}

function needsWindow(connection: ModelWindowConnection): boolean {
	return (
		!!connection.modelId &&
		isOllamaNativeProvider(connection.providerId) &&
		!statesWindow(connection)
	);
}

/**
 * Read the model's `/api/show` before the agent's first request, so
 * {@link withAgentModelWindow} finds the window it declares. Cached per server
 * and model by the provider, the same read its handler makes; a failure leaves
 * the default, which is what the wire would use anyway.
 */
export function primeAgentModelWindow(
	connection: ModelWindowConnection,
	fetchImpl: typeof fetch = fetch,
): Promise<void> | undefined {
	// Nothing to read is nothing to wait for: an \`await\` on an empty promise
	// still yields, and a spawn of several agents builds them in that gap.
	if (!needsWindow(connection)) return undefined;
	return primeDeclaredNumCtx(
		baseUrlOf(connection),
		connection.modelId,
		fetchImpl,
	).catch(() => {
		// Unread is the default, and the default is what will be sent.
	});
}

/**
 * The connection with its model's window stated, when it was not: in both
 * places a window is read from (the agent's `knownModels` and its provider
 * config's), so the gateway's output cap and compaction size against the
 * `num_ctx` the request carries. Unchanged for any other provider, and for a
 * model whose window something already states -- the session's own above all.
 */
export function withAgentModelWindow<T extends ModelWindowConnection>(
	connection: T,
): T {
	if (!needsWindow(connection)) return connection;
	const id = connection.modelId;
	const contextWindow =
		readResolvedOllamaWindow(baseUrlOf(connection), id) ??
		OLLAMA_DEFAULT_CONTEXT_WINDOW;
	const entry = (existing: unknown) => ({
		...((existing as object | undefined) ?? {}),
		id,
		contextWindow,
	});
	const providerConfig = connection.providerConfig as
		| (Record<string, unknown> & { knownModels?: Record<string, unknown> })
		| undefined;
	return {
		...connection,
		knownModels: {
			...(connection.knownModels ?? {}),
			[id]: entry(connection.knownModels?.[id]),
		},
		...(providerConfig
			? {
					providerConfig: {
						...providerConfig,
						knownModels: {
							...(providerConfig.knownModels ?? {}),
							[id]: entry(providerConfig.knownModels?.[id]),
						},
					},
				}
			: {}),
	} as T;
}
