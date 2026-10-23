/**
 * What a session was actually built with, for a host that has to prove it.
 *
 * A session's settings come from several places: what the host passed, a
 * provider profile stored in the data directory, the model catalog and the
 * defaults. A harness that passes a sampler and a context window has had no
 * way to learn whether those are what the session ended up with: a stored
 * profile is merged underneath, and a run can inherit a number from the one
 * before it. This is the answer, as data, before the first request is sent.
 *
 * It is a report and holds nothing live: no functions, and no secrets. A key,
 * a token or a header's value is replaced by the word that it was there.
 */

import type { ReasoningHistoryReport } from "@cline/llms";
import type { ProviderConfig } from "../types/provider-settings";

export interface ResolvedSessionConfig {
	sessionId: string;
	providerId: string;
	modelId: string;
	baseUrl?: string;
	/** The window the session sizes itself against, and sends where a server takes one. */
	contextWindow?: number;
	/** The cap on one reply. */
	maxOutputTokens?: number;
	thinking: {
		enabled?: boolean;
		effort?: string;
		budgetTokens?: number;
	};
	/** The sampler the session sends. Absent: the model's own. */
	sampling?: Record<string, unknown>;
	/**
	 * How much earlier reasoning goes back to the model, by which route, and
	 * what decided it. `auto` (the default, as in the plugin) is measured
	 * before this report where the probe is free (opencoti, and stock
	 * llama-server behind openai-compatible); ollama's probe runs at the first
	 * request, so there `decidedBy` is still `standing-default` here.
	 */
	reasoningHistory: ReasoningHistoryReport;
	/** The provider configuration, with secrets and live objects removed. */
	provider: Record<string, unknown>;
	/** The session's own settings, the same way. */
	session: Record<string, unknown>;
	/** The system prompt as the model will be given it. */
	systemPrompt?: string;
	sources: {
		/**
		 * `merged`: a stored profile for this provider was found and laid under
		 * what the host passed. `ignored`: the host asked for it to be left out.
		 * `absent`: there was none.
		 */
		storedProviderSettings: "merged" | "ignored" | "absent";
		/**
		 * The provider fields whose value came from the stored profile: the host
		 * did not set them and the session has them. Empty when nothing was
		 * inherited, which is what an isolated run should see.
		 */
		inheritedFromStoredProfile: string[];
		dataDir: string;
		providerSettingsPath: string;
		globalSettingsPath: string;
		/** Whether a global settings file exists. Core reads it for more than providers. */
		globalSettingsPresent: boolean;
	};
}

const SECRET_KEY =
	/(api[-_]?key|token|secret|password|authorization|credential|cookie)/i;
const OMITTED_KEYS = new Set([
	"knownModels",
	"extensionContext",
	"logger",
	"telemetry",
	"hooks",
	"extensions",
	"tools",
	"systemPrompt",
	"providerConfig",
	"workspaceMetadata",
]);
const MAX_DEPTH = 6;

/** A copy that can be written as JSON and shown to anyone. */
export function toReportValue(value: unknown, key = "", depth = 0): unknown {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (typeof value === "string") {
		return key && SECRET_KEY.test(key) && value ? "[set]" : value;
	}
	if (typeof value !== "object") {
		return value;
	}
	if (depth >= MAX_DEPTH) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value
			.map((entry) => toReportValue(entry, key, depth + 1))
			.filter((entry) => entry !== undefined);
	}
	// A class instance (a service, a manager) is not a setting.
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (OMITTED_KEYS.has(name)) {
			continue;
		}
		// A header's value is as likely a credential as not.
		const copied =
			key === "headers" && typeof entry === "string" && entry
				? "[set]"
				: toReportValue(entry, name, depth + 1);
		if (copied !== undefined) {
			out[name] = copied;
		}
	}
	return out;
}

const NOT_SETTINGS = new Set([
	"fetch",
	"headers",
	"knownModels",
	"extensionContext",
	"providerId",
	"modelId",
]);

/**
 * The provider fields that differ between the configuration built with the
 * stored profile and the one built without it: what the profile contributed.
 */
export function fieldsInheritedFromStoredProfile(
	withStored: ProviderConfig,
	withoutStored: ProviderConfig,
): string[] {
	const a = withStored as unknown as Record<string, unknown>;
	const b = withoutStored as unknown as Record<string, unknown>;
	const inherited: string[] = [];
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (NOT_SETTINGS.has(key) || typeof a[key] === "function") {
			continue;
		}
		if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) {
			inherited.push(key);
		}
	}
	return inherited.sort();
}
