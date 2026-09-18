// What an Ollama server knows about the account it is signed in as, and about
// the models it is offering.
//
// Three endpoints, none of which this fork read before:
//
// - `POST /api/me` proxies ollama.com's whoami through the local server, which
//   signs it with the SSH key in `~/.ollama`. It answers `401` with a
//   `signin_url` when the host is not signed in, so it is the only honest way
//   to know whether a cloud model will work at all.
// - `GET /api/experimental/model-recommendations` is re-served from a local
//   cache and needs no auth. Per model it carries `required_plan`, the real
//   `context_length` and `max_output_tokens`, and which thinking levels the
//   model actually accepts -- four things this client has been guessing.
// - `GET /api/tags` carries `remote_host` and `remote_model`, which is what
//   makes a model a cloud model.
//
// **`remote_host` is the discriminator, and nothing else is.** A cloud tag does
// not have to end in `:cloud` -- `glm-5.3-flash-tpl2:latest` and
// `igovet/glm-5.2-opencode:latest` are both cloud models on the reporter's own
// server -- and a cloud model does report a family: `kimi-k2.6:cloud` says
// `kimi-k2`. Reading the name, or reading a missing family, gets both of those
// backwards. The suffix is kept only as a fallback for a catalog that could not
// be read at all.
//
// The recommendations list is **not** a census of cloud models. It held five
// entries against a server with 123 tags, so it enriches a model that appears
// in it and says nothing about one that does not.

import type { BasicLogger } from "@cline/shared";

/** The plan an account is on, or a model requires. Open-ended on purpose: the
 * server sends a string and a plan tier this build has never heard of must
 * still render. */
export type OllamaPlan = string;

export interface OllamaAccount {
	/** Whether `/api/me` answered at all. Not signed in and not reachable are
	 * different conditions and the panel says which. */
	readonly reachable: boolean;
	readonly signedIn: boolean;
	readonly plan?: OllamaPlan;
	readonly name?: string;
	readonly email?: string;
	/** Where to sign in, as the server itself computed it. */
	readonly signinUrl?: string;
}

export interface OllamaRecommendation {
	readonly model: string;
	readonly description?: string;
	readonly contextLength?: number;
	readonly maxOutputTokens?: number;
	readonly requiredPlan?: OllamaPlan;
	/**
	 * The thinking settings the model accepts, normalized to strings.
	 *
	 * The wire mixes booleans and levels in one array -- `[false, "low",
	 * "high", "max"]` for one model and `[false, true]` for another -- so
	 * `false` renders as `off` and `true` as `on`. A model whose values are
	 * `off`/`on` has a switch; one with levels has a picker.
	 */
	readonly thinkingValues?: readonly string[];
	readonly thinkingDefault?: string;
	/** Present on local recommendations only; the cloud ones carry no size. */
	readonly vramBytes?: number;
}

export interface OllamaCatalogEntry {
	readonly name: string;
	/** True when `/api/tags` gave it a `remote_host` or a `remote_model`. */
	readonly cloud: boolean;
	readonly remoteHost?: string;
	readonly remoteModel?: string;
	readonly family?: string;
	readonly capabilities: readonly string[];
}

export interface OllamaAccountStatus {
	/** Whether the server answered `/api/tags`. */
	readonly reachable: boolean;
	readonly account: OllamaAccount;
	readonly recommendations: readonly OllamaRecommendation[];
	readonly models: readonly OllamaCatalogEntry[];
}

const UNREACHABLE_ACCOUNT: OllamaAccount = {
	reachable: false,
	signedIn: false,
};

const UNREACHABLE: OllamaAccountStatus = {
	reachable: false,
	account: UNREACHABLE_ACCOUNT,
	recommendations: [],
	models: [],
};

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** `false` and `true` are settings here, not absences, so they are named. */
function thinkingValue(value: unknown): string | undefined {
	if (value === false) {
		return "off";
	}
	if (value === true) {
		return "on";
	}
	return nonEmptyString(value);
}

/**
 * Read `POST /api/me`.
 *
 * The response uses Go's exported field names (`Name`, `Plan`, `Email`), not
 * the snake_case every other Ollama endpoint uses; both spellings are accepted
 * so a future rename does not silently empty the strip.
 */
export function parseOllamaWhoami(
	status: number,
	payload: unknown,
): OllamaAccount {
	const body = (payload ?? {}) as Record<string, unknown>;
	if (status === 401) {
		return {
			reachable: true,
			signedIn: false,
			...(nonEmptyString(body.signin_url)
				? { signinUrl: nonEmptyString(body.signin_url) as string }
				: {}),
		};
	}
	if (status !== 200) {
		// 503 is the server saying it could not check, which is not a verdict
		// on the account.
		return UNREACHABLE_ACCOUNT;
	}
	const name = nonEmptyString(body.Name) ?? nonEmptyString(body.name);
	if (!name) {
		return { reachable: true, signedIn: false };
	}
	const plan = nonEmptyString(body.Plan) ?? nonEmptyString(body.plan);
	const email = nonEmptyString(body.Email) ?? nonEmptyString(body.email);
	return {
		reachable: true,
		signedIn: true,
		name,
		// The server defaults a blank plan to "free" before it answers; this
		// only covers a payload that omitted the field entirely.
		plan: plan ?? "free",
		...(email ? { email } : {}),
	};
}

/** Read `GET /api/experimental/model-recommendations`. */
export function parseOllamaRecommendations(
	payload: unknown,
): OllamaRecommendation[] {
	const body = (payload ?? {}) as Record<string, unknown>;
	const raw = Array.isArray(body.recommendations) ? body.recommendations : [];
	const parsed: OllamaRecommendation[] = [];
	for (const entry of raw as Array<Record<string, unknown>>) {
		const model = nonEmptyString(entry?.model);
		if (!model) {
			continue;
		}
		const thinking = (entry.thinking ?? {}) as Record<string, unknown>;
		const values = Array.isArray(thinking.values)
			? thinking.values
					.map(thinkingValue)
					.filter((value): value is string => value !== undefined)
			: [];
		parsed.push({
			model,
			...(nonEmptyString(entry.description)
				? { description: nonEmptyString(entry.description) as string }
				: {}),
			// A local recommendation carries `context_length: 0`, which means
			// "the model decides", not a zero-token window.
			...(positiveInt(entry.context_length) !== undefined
				? { contextLength: positiveInt(entry.context_length) as number }
				: {}),
			...(positiveInt(entry.max_output_tokens) !== undefined
				? {
						maxOutputTokens: positiveInt(entry.max_output_tokens) as number,
					}
				: {}),
			...(nonEmptyString(entry.required_plan)
				? { requiredPlan: nonEmptyString(entry.required_plan) as string }
				: {}),
			...(values.length > 0 ? { thinkingValues: values } : {}),
			...(thinkingValue(thinking.default) !== undefined
				? { thinkingDefault: thinkingValue(thinking.default) as string }
				: {}),
			...(positiveInt(entry.vram_bytes) !== undefined
				? { vramBytes: positiveInt(entry.vram_bytes) as number }
				: {}),
		});
	}
	return parsed;
}

/** Read `GET /api/tags`. */
export function parseOllamaCatalog(payload: unknown): OllamaCatalogEntry[] {
	const body = (payload ?? {}) as Record<string, unknown>;
	const raw = Array.isArray(body.models) ? body.models : [];
	const parsed: OllamaCatalogEntry[] = [];
	for (const entry of raw as Array<Record<string, unknown>>) {
		const name = nonEmptyString(entry?.name) ?? nonEmptyString(entry?.model);
		if (!name) {
			continue;
		}
		const remoteHost = nonEmptyString(entry.remote_host);
		const remoteModel = nonEmptyString(entry.remote_model);
		const details = (entry.details ?? {}) as Record<string, unknown>;
		const capabilities = Array.isArray(entry.capabilities)
			? entry.capabilities.filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		parsed.push({
			name,
			cloud: remoteHost !== undefined || remoteModel !== undefined,
			...(remoteHost ? { remoteHost } : {}),
			...(remoteModel ? { remoteModel } : {}),
			...(nonEmptyString(details.family)
				? { family: nonEmptyString(details.family) as string }
				: {}),
			capabilities,
		});
	}
	return parsed;
}

/**
 * The fallback when the catalog could not be read.
 *
 * Deliberately last-resort: it is right about `kimi-k2.6:cloud` and wrong about
 * `glm-5.3-flash-tpl2:latest`, and a `-cloud` in the middle of a name is not a
 * suffix.
 */
export function looksLikeCloudName(modelId: string): boolean {
	return /(?::cloud|-cloud)$/.test(modelId.trim());
}

/** Strip the marker a recommendation's name carries but a local tag does not. */
function recommendationStem(model: string): string {
	return model.trim().replace(/(?::cloud|-cloud)$/, "");
}

/**
 * Find the recommendation that describes a tag.
 *
 * A tag built FROM a cloud model keeps its own name — `glm-5.3-flash-tpl2:latest`
 * is `glm-5.3-flash` underneath — so `remote_model` is tried before the tag's
 * own name. Without that, every re-templated cloud model reads as unlisted.
 */
export function matchOllamaRecommendation(
	recommendations: readonly OllamaRecommendation[],
	model: { readonly name: string; readonly remoteModel?: string },
): OllamaRecommendation | undefined {
	const candidates = [model.remoteModel, model.name].filter(
		(value): value is string => nonEmptyString(value) !== undefined,
	);
	for (const candidate of candidates) {
		const exact = recommendations.find((entry) => entry.model === candidate);
		if (exact) {
			return exact;
		}
	}
	for (const candidate of candidates) {
		const stem = recommendationStem(candidate);
		const loose = recommendations.find(
			(entry) => recommendationStem(entry.model) === stem,
		);
		if (loose) {
			return loose;
		}
	}
	return undefined;
}

async function readJson(
	doFetch: typeof fetch,
	url: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown } | undefined> {
	try {
		const response = await doFetch(url, init);
		const text = await response.text();
		let body: unknown;
		try {
			body = text === "" ? {} : JSON.parse(text);
		} catch {
			body = {};
		}
		return { status: response.status, body };
	} catch {
		return undefined;
	}
}

function apiRoot(baseUrl: string): string {
	return `${baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:v1|api)$/, "")}/api`;
}

/**
 * Read everything the settings panel shows about an Ollama endpoint.
 *
 * Nothing here may fail a caller. Each read stands alone: a server that does
 * not proxy `/api/me` still reports its models, and an account read that says
 * "not signed in" does not suppress the recommendations, which need no auth.
 */
export async function readOllamaAccountStatus(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<OllamaAccountStatus> {
	if (!baseUrl?.trim()) {
		return UNREACHABLE;
	}
	const root = apiRoot(baseUrl);
	const doFetch = fetchImpl ?? fetch;

	const [tags, recommendations, me] = await Promise.all([
		readJson(doFetch, `${root}/tags`, { method: "GET" }),
		readJson(doFetch, `${root}/experimental/model-recommendations`, {
			method: "GET",
		}),
		readJson(doFetch, `${root}/me`, {
			method: "POST",
			headers: { "content-type": "application/json" },
		}),
	]);

	if (!tags || tags.status !== 200) {
		return UNREACHABLE;
	}
	return {
		reachable: true,
		account: me ? parseOllamaWhoami(me.status, me.body) : UNREACHABLE_ACCOUNT,
		recommendations:
			recommendations?.status === 200
				? parseOllamaRecommendations(recommendations.body)
				: [],
		models: parseOllamaCatalog(tags.body),
	};
}

/**
 * The catalog and recommendations for one server, primed once.
 *
 * Keyed by API root rather than by model: both reads describe the server, and
 * doing them per model would put 123 identical requests on the session-start
 * path of a busy machine.
 */
const accountStatusCache = new Map<string, OllamaAccountStatus>();

/** Test seam, and the reset a base-URL change needs. */
export function resetOllamaAccountStatus(): void {
	accountStatusCache.clear();
}

/** What has been primed for this server, if anything. */
export function readOllamaAccountCache(
	baseUrl: string | undefined,
): OllamaAccountStatus | undefined {
	if (!baseUrl?.trim()) {
		return undefined;
	}
	return accountStatusCache.get(apiRoot(baseUrl));
}

/** Prime {@link readOllamaAccountCache} for a server, at most once. */
export async function primeOllamaAccountStatus(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
	logger?: BasicLogger,
): Promise<void> {
	if (!baseUrl?.trim()) {
		return;
	}
	const key = apiRoot(baseUrl);
	if (accountStatusCache.has(key)) {
		return;
	}
	const status = await readOllamaAccountStatus(baseUrl, fetchImpl);
	accountStatusCache.set(key, status);
	if (status.reachable) {
		const cloud = status.models.filter((model) => model.cloud).length;
		logger?.debug?.(
			`[ollama] ${key}: ${status.models.length} models (${cloud} cloud), ${status.recommendations.length} recommendations, account ${
				status.account.signedIn
					? `${status.account.name} on ${status.account.plan}`
					: "not signed in"
			}`,
		);
	}
}

/**
 * Whether a model is served from the cloud.
 *
 * `undefined` when the catalog has not been primed — which is not the same as
 * `false`, and callers that care about the difference must ask for it.
 */
export function readOllamaCloudFlag(
	baseUrl: string | undefined,
	modelId: string | undefined,
): boolean | undefined {
	if (!modelId) {
		return undefined;
	}
	const status = readOllamaAccountCache(baseUrl);
	if (!status?.reachable) {
		return undefined;
	}
	const entry = status.models.find((model) => model.name === modelId);
	return entry?.cloud ?? looksLikeCloudName(modelId);
}

/** The recommendation describing a model on a primed server, if it has one. */
export function readOllamaRecommendation(
	baseUrl: string | undefined,
	modelId: string | undefined,
): OllamaRecommendation | undefined {
	if (!modelId) {
		return undefined;
	}
	const status = readOllamaAccountCache(baseUrl);
	if (!status?.reachable) {
		return undefined;
	}
	const entry = status.models.find((model) => model.name === modelId);
	return matchOllamaRecommendation(status.recommendations, {
		name: modelId,
		...(entry?.remoteModel ? { remoteModel: entry.remoteModel } : {}),
	});
}
