import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { resolveProviderSettingsPath } from "@cline/shared/storage";
import { getLiveModelsCatalog } from "../..";
import { getProviderAuthHandler } from "../../auth/provider-auth-registry";
import { hashSecret, sdkDebug } from "../../logging/early-logger";
import {
	emptyStoredProviderSettings,
	type ProviderConfig,
	type ProviderSettings,
	ProviderSettingsSchemaTyped as ProviderSettingsSchema,
	type ProviderTokenSource,
	type StoredProviderSettings,
	StoredProviderSettingsSchema,
	type ToProviderConfigOptions,
	toProviderConfig,
	type VoiceInputSettings,
	VoiceInputSettingsSchema,
} from "../../types/provider-settings";
import {
	ensureCustomProvidersLoadedSync,
	registerConfiguredProvidersFromSettings,
} from "../providers/local-provider-registry";
import { migrateLegacyProviderSettings } from "./provider-settings-legacy-migration";

function nowIso(): string {
	return new Date().toISOString();
}

export interface ProviderSettingsManagerOptions {
	filePath?: string;
	dataDir?: string;
}

export interface SaveProviderSettingsOptions {
	setLastUsed?: boolean;
	tokenSource?: ProviderTokenSource;
}

export interface ResolveLastUsedProviderSettingsOptions {
	isClinePassEnabled?: boolean;
}

/**
 * The last parse of the settings file, and what the file looked like then.
 *
 * `read()` is called far more often than the file changes: the extension's
 * webview state post reads it, and that post is debounced at 50ms and fired on
 * every streamed chunk. Measured on a report from a user running 4.100.69,
 * that was 21,556 reads across two sessions -- a `readFileSync`, a
 * `JSON.parse` and a full zod validation each time, synchronously, on the
 * thread that also has to keep the webview fed.
 */
interface ParsedSettingsCache {
	/** From the stat at the time of the parse, not from the parse. */
	mtimeMs: number;
	size: number;
	value: StoredProviderSettings;
}

const CLINE_PROVIDER_ID = "cline";
const CLINE_PASS_PROVIDER_ID = "cline-pass";

function inferLegacyDataDir(filePath: string): string | undefined {
	if (basename(filePath) !== "providers.json") {
		return undefined;
	}
	const settingsDir = dirname(filePath);
	if (basename(settingsDir) !== "settings") {
		return undefined;
	}
	return dirname(settingsDir);
}

export class ProviderSettingsManager {
	private readonly filePath: string;
	private readonly dataDir?: string;
	private cache: ParsedSettingsCache | undefined;

	constructor(options: ProviderSettingsManagerOptions = {}) {
		this.filePath = options.filePath ?? resolveProviderSettingsPath();
		this.dataDir = options.dataDir ?? inferLegacyDataDir(this.filePath);
		if (this.dataDir || !options.filePath) {
			migrateLegacyProviderSettings({
				providerSettingsManager: this,
				dataDir: this.dataDir,
			});
		}
		ensureCustomProvidersLoadedSync(this);
		registerConfiguredProvidersFromSettings(this.read());
		// Harden permissions on any existing file at startup so that
		// pre-existing installations are also protected (best-effort; no-op on Windows).
		if (existsSync(this.filePath)) {
			try {
				chmodSync(this.filePath, 0o600);
			} catch {
				// Ignore — Windows does not support POSIX chmod.
			}
		}
	}

	getFilePath(): string {
		return this.filePath;
	}

	read(): StoredProviderSettings {
		// One `stat` in place of the `existsSync` that was here anyway, so the
		// hot path costs the same syscall it always did and skips everything
		// after it.
		let mtimeMs: number;
		let size: number;
		try {
			const stats = statSync(this.filePath);
			mtimeMs = stats.mtimeMs;
			size = stats.size;
		} catch {
			this.cache = undefined;
			return emptyStoredProviderSettings();
		}

		// The file is shared with the CLI and the hub, so the cache is keyed on
		// what is on disk rather than on this process having written last. Both
		// fields matter: mtime alone would miss an edit inside the same
		// millisecond, and size alone would miss one that keeps the length.
		const cached = this.cache;
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
			// A copy, because callers mutate what they are given -- readers here
			// go on to assign into `.modes` and to spread `.providers` -- and a
			// cache that handed out its own object would be edited from under
			// itself and then written back as though it had been read.
			return structuredClone(cached.value);
		}

		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const result = StoredProviderSettingsSchema.safeParse(parsed);
			if (result.success) {
				// Both of these stay on the miss path only. Registration derives
				// from the file's content, so repeating it for content that has
				// not changed is the same work with the same outcome -- and the
				// debug line is what made this loop visible in the first place,
				// which it can no longer do if it prints on every state post.
				registerConfiguredProvidersFromSettings(result.data);
				const clineAuth = result.data.providers["cline"]?.settings?.auth;
				sdkDebug(
					`providers.read providers=[${Object.keys(result.data.providers).join(",")}] lastUsed=${result.data.lastUsedProvider ?? "none"} clineAuthPresent=${!!clineAuth?.accessToken} clineAccessTokenHash=${hashSecret(clineAuth?.accessToken)} clineRefreshTokenHash=${hashSecret(clineAuth?.refreshToken)}`,
				);
				this.cache = {
					mtimeMs,
					size,
					value: structuredClone(result.data),
				};
				return result.data;
			}
		} catch {
			// Invalid content falls back to a clean state.
		}

		// Unparseable, or gone between the stat and the read. Nothing is cached
		// for it: the empty state this returns is a fallback and not a reading
		// of the file, and caching it would keep answering with it after the
		// file was fixed.
		this.cache = undefined;
		return emptyStoredProviderSettings();
	}

	write(state: StoredProviderSettings): void {
		const normalized = StoredProviderSettingsSchema.parse(state);
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		// Stage to a pid-unique temp file and rename into place. Concurrent
		// Cline processes (CLI, extension, hub) share this file; a bare
		// writeFileSync lets readers catch a partial file, which read() treats
		// as empty settings — indistinguishable from being logged out.
		const tempPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(tempPath, this.filePath);
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
		// Dropped rather than replaced with `normalized`: the next `read()` is
		// the cheap path anyway, and a rename that lands in the same
		// millisecond as the cached stat is exactly the case the key cannot
		// tell apart. Writes are rare; a stale one here would not be.
		this.cache = undefined;
		// Restrict file to owner-only read/write (best-effort; no-op on Windows).
		try {
			chmodSync(this.filePath, 0o600);
		} catch {
			// Ignore — Windows does not support POSIX chmod.
		}
		registerConfiguredProvidersFromSettings(normalized);
	}

	saveProviderSettings(
		settings: unknown,
		options: SaveProviderSettingsOptions = {},
	): StoredProviderSettings {
		const validatedSettings = ProviderSettingsSchema.parse(settings);
		const previous = this.read();
		const providerId = validatedSettings.provider;
		const shouldSetLastUsed = options.setLastUsed !== false;
		const previousEntry = previous.providers[providerId];
		const tokenSource =
			options.tokenSource ?? previousEntry?.tokenSource ?? "manual";
		const next: StoredProviderSettings = {
			...previous,
			providers: {
				...previous.providers,
				[providerId]: {
					settings: validatedSettings,
					updatedAt: nowIso(),
					tokenSource,
				},
			},
			lastUsedProvider: shouldSetLastUsed
				? providerId
				: previous.lastUsedProvider,
		};
		this.write(next);
		const prevClineAuth = previous.providers["cline"]?.settings?.auth;
		const nextClineAuth =
			validatedSettings.provider === "cline"
				? validatedSettings.auth
				: next.providers["cline"]?.settings?.auth;
		const authDropped =
			!!prevClineAuth?.accessToken && !nextClineAuth?.accessToken;
		sdkDebug(
			`providers.save providerId=${providerId} tokenSource=${tokenSource} clineAuthWasPresent=${!!prevClineAuth?.accessToken} clineAuthIsPresent=${!!nextClineAuth?.accessToken} authDropped=${authDropped}`,
		);
		return next;
	}

	private resolveProviderSettings(
		state: StoredProviderSettings,
		providerId: string,
	): ProviderSettings | undefined {
		const directSettings = state.providers[providerId]?.settings;
		const authHandler = getProviderAuthHandler(providerId);
		const storageProviderId = authHandler?.storageProviderId;
		if (!storageProviderId || storageProviderId === providerId) {
			return directSettings;
		}

		const authSettings = state.providers[storageProviderId]?.settings;
		if (!authSettings) {
			return directSettings;
		}

		return ProviderSettingsSchema.parse({
			...(authSettings.auth ? { auth: authSettings.auth } : {}),
			...(authSettings.apiKey ? { apiKey: authSettings.apiKey } : {}),
			...(authSettings.baseUrl ? { baseUrl: authSettings.baseUrl } : {}),
			...(directSettings ?? {}),
			provider: providerId,
		});
	}

	getProviderSettings(providerId: string): ProviderSettings | undefined {
		const state = this.read();
		return this.resolveProviderSettings(state, providerId);
	}

	getVoiceInputSettings(): VoiceInputSettings | undefined {
		return this.read().modes.voiceInput;
	}

	setVoiceInputSettings(
		settings: VoiceInputSettings | undefined,
	): StoredProviderSettings {
		const state = this.read();
		if (settings) {
			state.modes.voiceInput = VoiceInputSettingsSchema.parse(settings);
		} else {
			delete state.modes.voiceInput;
		}
		this.write(state);
		return state;
	}

	private resolveLastUsedProviderId(
		state: StoredProviderSettings,
		options: ResolveLastUsedProviderSettingsOptions,
	): string | undefined {
		const providerId = state.lastUsedProvider;
		if (
			providerId === CLINE_PASS_PROVIDER_ID &&
			options.isClinePassEnabled === false
		) {
			return CLINE_PROVIDER_ID;
		}

		return providerId;
	}

	getLastUsedProviderSettings(
		options: ResolveLastUsedProviderSettingsOptions = {},
	): ProviderSettings | undefined {
		const state = this.read();
		const providerId = this.resolveLastUsedProviderId(state, options);
		if (!providerId) {
			return undefined;
		}
		return this.resolveProviderSettings(state, providerId);
	}

	getProviderConfig(
		providerId: string,
		options?: ToProviderConfigOptions,
	): ProviderConfig | undefined {
		const settings = this.getProviderSettings(providerId);
		if (!settings) {
			return undefined;
		}
		return toProviderConfig(settings, options);
	}

	getLastUsedProviderConfig(
		options: ToProviderConfigOptions &
			ResolveLastUsedProviderSettingsOptions = {},
	): ProviderConfig | undefined {
		const settings = this.getLastUsedProviderSettings(options);
		if (!settings) {
			return undefined;
		}
		return toProviderConfig(settings, options);
	}

	async refreshCatalog(): Promise<void> {
		try {
			await getLiveModelsCatalog({});
		} catch {
			// Ignore errors
		}
	}
}
