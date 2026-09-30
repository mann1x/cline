/**
 * Whether an Ollama or xOllama endpoint answers, for the chat input.
 *
 * The chat box is where a dead server is found out, and until now it was found
 * out by sending a message and reading the error. This is one `GET /api/tags`
 * with a short bound: cheap enough to repeat while the panel is open, and the
 * one read that also says whether the selected model is there at all.
 *
 * Deliberately not {@link readOllamaAccountStatus}: that one also asks
 * ollama.com who the host is signed in as, a signed round trip that has no
 * business on a poll.
 *
 * An unset base URL is resolved the way the chat request resolves it -- the
 * package's own default for Ollama, {@link XOLLAMA_DEFAULT_BASE_URL} for
 * xOllama -- so the probe asks the server the chat would have asked.
 */

import {
	parseOllamaRecommendations,
	unpulledCloudModels,
} from "./ollama-account";
import { XOLLAMA_DEFAULT_BASE_URL } from "./xollama";

/** Where `ollama-ai-provider-v2` sends a request with no base URL. */
export const OLLAMA_PACKAGE_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/** Long enough for a busy server's `/api/tags`, short enough to say "down" promptly. */
export const OLLAMA_REACHABILITY_TIMEOUT_MS = 4000;

export interface OllamaReachability {
	readonly reachable: boolean;
	/** The origin asked, as the user would type it. */
	readonly baseUrl: string;
	/** Why it did not answer: an HTTP status, a timeout, or the network's word. */
	readonly error?: string;
	/**
	 * It answered, and refused the request for want of a key (401). xOllama
	 * with a local key set answers every route so; the server is up and the
	 * fix is in the provider's settings, not on the server.
	 */
	readonly unauthorized?: boolean;
	/**
	 * Whether the model is in `/api/tags`. Absent when no model was named or
	 * the server did not answer -- not the same as `false`.
	 */
	readonly modelFound?: boolean;
}

/** The origin a chat request on this provider goes to. */
export function resolveOllamaOrigin(
	providerId: string,
	baseUrl: string | undefined,
): string {
	const configured = baseUrl?.trim();
	const origin =
		configured ||
		(providerId === "xollama"
			? XOLLAMA_DEFAULT_BASE_URL
			: OLLAMA_PACKAGE_DEFAULT_BASE_URL);
	return origin.replace(/\/+$/, "").replace(/\/(?:v1|api)$/, "");
}

/** The network error's own words, without the "fetch failed" wrapper. */
function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") {
			return `no answer within ${OLLAMA_REACHABILITY_TIMEOUT_MS / 1000}s`;
		}
		const cause = (error as { cause?: { code?: unknown; message?: unknown } })
			.cause;
		if (typeof cause?.code === "string") {
			return cause.code;
		}
		if (typeof cause?.message === "string" && cause.message) {
			return cause.message;
		}
		return error.message || error.name;
	}
	return String(error);
}

function tagNames(payload: unknown): string[] {
	const models = (payload as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) {
		return [];
	}
	return models.flatMap((entry) => {
		const record = entry as { name?: unknown; model?: unknown };
		return [record?.name, record?.model].filter(
			(value): value is string => typeof value === "string",
		);
	});
}

/**
 * A tag without an explicit version is `:latest` to the server, so `qwen3`
 * and `qwen3:latest` name the same model.
 */
function sameTag(a: string, b: string): boolean {
	const full = (name: string) => (name.includes(":") ? name : `${name}:latest`);
	return full(a) === full(b);
}

export async function probeOllamaReachability(
	providerId: string,
	baseUrl: string | undefined,
	modelId?: string,
	fetchImpl: typeof fetch = fetch,
): Promise<OllamaReachability> {
	const origin = resolveOllamaOrigin(providerId, baseUrl);
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/api/tags`, {
			method: "GET",
			signal: AbortSignal.timeout(OLLAMA_REACHABILITY_TIMEOUT_MS),
		});
	} catch (error) {
		return { reachable: false, baseUrl: origin, error: describeFailure(error) };
	}
	if (response.status === 401) {
		return {
			reachable: false,
			baseUrl: origin,
			error: "HTTP 401",
			unauthorized: true,
		};
	}
	if (!response.ok) {
		return {
			reachable: false,
			baseUrl: origin,
			error: `HTTP ${response.status}`,
		};
	}
	const model = modelId?.trim();
	if (!model) {
		return { reachable: true, baseUrl: origin };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		// It answered, which is what was asked; the list is a bonus.
		return { reachable: true, baseUrl: origin };
	}
	if (tagNames(payload).some((name) => sameTag(name, model))) {
		return { reachable: true, baseUrl: origin, modelFound: true };
	}
	// Not pulled is not missing for a cloud model the server offers: it is
	// fetched on first use (`unpulledCloudModels`). Asked only on a miss, so a
	// pulled model costs no second request.
	return {
		reachable: true,
		baseUrl: origin,
		modelFound: await offeredUnpulled(origin, model, fetchImpl),
	};
}

async function offeredUnpulled(
	origin: string,
	model: string,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	try {
		const response = await fetchImpl(
			`${origin}/api/experimental/model-recommendations`,
			{
				method: "GET",
				signal: AbortSignal.timeout(OLLAMA_REACHABILITY_TIMEOUT_MS),
			},
		);
		if (!response.ok) {
			return false;
		}
		return unpulledCloudModels(
			parseOllamaRecommendations(await response.json()),
			[],
		).some((entry) => sameTag(entry.name, model));
	} catch {
		// The tags answered and do not have it; an unanswered second question
		// does not overturn that.
		return false;
	}
}
