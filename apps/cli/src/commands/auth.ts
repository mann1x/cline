import { createInterface } from "node:readline";
import {
	BUILT_IN_PROVIDER,
	createOAuthClientCallbacks,
	ensureCustomProvidersLoaded,
	getProviderAuthHandler,
	loginAndSaveProviderOAuthCredentials,
	type ProviderSettings,
	type ProviderSettingsManager,
	saveProviderOAuthCredentials,
} from "@cline/core";
import { Command } from "commander";
import React from "react";
import { disableOpenTuiGraphicsProbe } from "../tui/opentui-env";
import open from "../utils/open";
import {
	getPersistedProviderApiKey,
	isOAuthProvider,
	normalizeAuthProviderId,
	normalizeProviderId,
	type OAuthCredentials,
	toProviderApiKey,
} from "../utils/provider-auth";
import { listLocalProviders } from "../utils/provider-catalog";
import { identifyTelemetryAccount } from "../utils/telemetry";

export {
	getPersistedProviderApiKey,
	isOAuthProvider,
	normalizeAuthProviderId,
	normalizeProviderId,
	toProviderApiKey,
};
export type { OAuthCredentials };

const c = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
};

type AuthIo = {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
};

type AuthQuickSetupInput = {
	provider: string;
	apikey: string;
	modelid: string;
	baseurl?: string;
	azureApiVersion?: string;
};

type AuthCommandInput = {
	providerSettingsManager: ProviderSettingsManager;
	io: AuthIo;
	explicitProvider?: string;
	apikey?: string;
	modelid?: string;
	baseurl?: string;
	azureApiVersion?: string;
};

type ParsedAuthCommandArgs = {
	explicitProvider?: string;
	apikey?: string;
	modelid?: string;
	baseurl?: string;
	azureApiVersion?: string;
	parseError?: string;
};

/**
 * Create the `auth` subcommand for Commander.
 *
 * In the auth context, `-p` means `--provider` and `-m` means `--modelid`,
 * which intentionally shadows the global `-p` (--plan) and `-m` (--model)
 * short flags. Commander scopes options per-command, so there is no conflict.
 */
export function createAuthCommand(): Command {
	const cmd = new Command("auth")
		.description("Authenticate with an LLM provider")
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {} })
		.argument("[provider]", "provider id (positional shorthand for -p)")
		.option("-p, --provider <id>", "provider id")
		.option("-k, --apikey <key>", "API key")
		.option("-m, --modelid <id>", "model id")
		.option("-b, --baseurl <url>", "base URL")
		.option("--azure-api-version <version>", "Azure API version");
	return cmd;
}

export function parseAuthCommandArgs(args: string[]): ParsedAuthCommandArgs {
	const cmd = createAuthCommand();
	try {
		cmd.parse(args, { from: "user" });
	} catch {
		// Commander throws on --help / --version / unknown flags via exitOverride
		return { parseError: `unknown auth option in: ${args.join(" ")}` };
	}
	const opts = cmd.opts<{
		provider?: string;
		apikey?: string;
		modelid?: string;
		baseurl?: string;
		azureApiVersion?: string;
	}>();
	const positionalProvider = cmd.args[0];
	return {
		explicitProvider: opts.provider ?? positionalProvider,
		apikey: opts.apikey,
		modelid: opts.modelid,
		baseurl: opts.baseurl,
		azureApiVersion: opts.azureApiVersion,
	};
}

async function loadProviderCatalog(
	providerSettingsManager: ProviderSettingsManager,
): Promise<
	Array<{ id: string; name: string; configFields: readonly string[] }>
> {
	await ensureCustomProvidersLoaded(providerSettingsManager);
	const catalog = await listLocalProviders(providerSettingsManager);
	return catalog.providers
		.map((provider) => ({
			id: provider.id.trim(),
			name: provider.name.trim() || provider.id.trim(),
			// What this provider actually takes, as the registry declares it.
			// The two checks below used to be a hardcoded list of provider ids,
			// which is a second opinion about a question the registry already
			// answers -- and it was wrong about Ollama, the provider most likely
			// of all of them to be on a host other than the default.
			configFields: (provider.configFields ?? []).map((field) => field.path),
		}))
		.filter((provider) => provider.id.length > 0)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Exported for tests: these rules are the whole reason `auth` refuses. */
export async function ensureQuickSetupInputValid(
	input: AuthQuickSetupInput,
	providerSettingsManager: ProviderSettingsManager,
): Promise<string | undefined> {
	const normalizedProvider = normalizeProviderId(input.provider);
	const providerCatalog = await loadProviderCatalog(providerSettingsManager);
	const provider = providerCatalog.find(
		(candidate) => candidate.id === normalizedProvider,
	);
	if (!provider) {
		return `invalid provider "${input.provider}"`;
	}
	// A key is asked for only by a provider that has one. Ollama and the other
	// local servers do not, and requiring one there means the setup that works
	// is the one where the user invents a word.
	if (provider.configFields.includes("apiKey") && !input.apikey.trim()) {
		return "auth quick setup requires --apikey <key>";
	}
	if (!input.modelid.trim()) {
		return "auth quick setup requires --modelid <id>";
	}
	if (input.baseurl?.trim() && !provider.configFields.includes("baseUrl")) {
		return `base URL is not supported for provider "${normalizedProvider}"`;
	}
	if (
		input.azureApiVersion?.trim() &&
		normalizedProvider !== BUILT_IN_PROVIDER.OPENAI_COMPATIBLE
	) {
		return "Azure API version is only supported for OpenAI-compatible providers";
	}
	return undefined;
}

function saveQuickAuthProviderSettings(input: {
	providerSettingsManager: ProviderSettingsManager;
	providerId: string;
	apikey: string;
	modelid: string;
	baseurl?: string;
	azureApiVersion?: string;
}): void {
	const existing = input.providerSettingsManager.getProviderSettings(
		input.providerId,
	);
	const nextSettings: ProviderSettings = {
		...(existing ?? {
			provider: input.providerId as ProviderSettings["provider"],
		}),
		provider: input.providerId as ProviderSettings["provider"],
		apiKey: input.apikey,
		model: input.modelid,
	};
	if (input.baseurl?.trim()) {
		nextSettings.baseUrl = input.baseurl.trim();
	}
	if (input.azureApiVersion?.trim()) {
		nextSettings.azure = {
			...(nextSettings.azure ?? {}),
			apiVersion: input.azureApiVersion.trim(),
		};
	}
	input.providerSettingsManager.saveProviderSettings(nextSettings);
}

async function askForInputInTerminal(question: string): Promise<string> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("OAuth login requires an interactive terminal session");
	}

	return new Promise<string>((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${question} `, (value) => {
			rl.close();
			resolve(value);
		});
	});
}

function createOAuthCallbacks(io: AuthIo): {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: {
		message: string;
		defaultValue?: string;
	}) => Promise<string>;
} {
	return createOAuthClientCallbacks({
		onPrompt: ({ message, defaultValue }) =>
			askForInputInTerminal(message).then((value) => {
				const trimmed = value.trim();
				return trimmed || defaultValue || "";
			}),
		onOutput: (message) => {
			io.writeln(`${c.dim}[auth] ${message}${c.reset}`);
		},
		openUrl: (url) => open(url, { wait: false }).then(() => undefined),
		onOpenUrlError: ({ error }) => {
			io.writeln(
				`${c.dim}[auth] Could not open browser automatically; open the URL above manually.${c.reset}`,
			);
			io.writeln(
				`${c.dim}[auth] Browser open failed: ${error instanceof Error ? error.message : String(error)}${c.reset}`,
			);
		},
	});
}

export function saveOAuthProviderSettings(
	providerSettingsManager: ProviderSettingsManager,
	providerId: string,
	existing: ProviderSettings | undefined,
	credentials: OAuthCredentials,
): ProviderSettings {
	return saveProviderOAuthCredentials({
		manager: providerSettingsManager,
		providerId,
		settings: existing,
		credentials,
	});
}

export async function ensureOAuthProviderApiKey(input: {
	providerId: string;
	currentApiKey?: string;
	existingSettings?: ProviderSettings;
	providerSettingsManager: ProviderSettingsManager;
	io: AuthIo;
}): Promise<{
	apiKey?: string;
	selectedProviderSettings?: ProviderSettings;
}> {
	if (input.currentApiKey || !isOAuthProvider(input.providerId)) {
		return {
			apiKey: input.currentApiKey,
			selectedProviderSettings: input.existingSettings,
		};
	}
	const selectedProviderSettings = await loginAndSaveProviderOAuthCredentials(
		input.providerSettingsManager,
		input.providerId,
		{ callbacks: createOAuthCallbacks(input.io) },
	);
	const handler = getProviderAuthHandler(input.providerId);
	return {
		apiKey: handler?.getApiKey(selectedProviderSettings),
		selectedProviderSettings,
	};
}

async function runQuickAuthSetup(input: AuthCommandInput): Promise<number> {
	const providerId = normalizeProviderId((input.explicitProvider ?? "").trim());
	const apikey = input.apikey?.trim() ?? "";
	const modelid = input.modelid?.trim() ?? "";
	const baseurl = input.baseurl?.trim();
	const azureApiVersion = input.azureApiVersion?.trim();
	const validationError = await ensureQuickSetupInputValid(
		{
			provider: providerId,
			apikey,
			modelid,
			baseurl,
			azureApiVersion,
		},
		input.providerSettingsManager,
	);
	if (validationError) {
		input.io.writeErr(validationError);
		return 1;
	}
	saveQuickAuthProviderSettings({
		providerSettingsManager: input.providerSettingsManager,
		providerId,
		apikey,
		modelid,
		baseurl,
		azureApiVersion,
	});
	input.io.writeln(
		`${c.green}Provider configured:${c.reset} ${c.cyan}${providerId}${c.reset} (${modelid})`,
	);
	return 0;
}

export async function loadAuthTuiRuntime() {
	disableOpenTuiGraphicsProbe();
	const { createCliRenderer } = await import("@opentui/core");
	const { createRoot } = await import("@opentui/react");
	const { OnboardingView } = await import("../tui/views/onboarding");
	return { createCliRenderer, createRoot, OnboardingView };
}

async function runInteractiveAuthTui(input: AuthCommandInput): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		input.io.writeErr(
			"interactive auth setup requires a TTY (use --provider/--apikey/--modelid for non-interactive setup)",
		);
		return 1;
	}
	const { createCliRenderer, createRoot, OnboardingView } =
		await loadAuthTuiRuntime();
	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		autoFocus: false,
		enableMouseMovement: true,
	});

	return await new Promise<number>((resolve, reject) => {
		let root: ReturnType<typeof createRoot>;
		try {
			root = createRoot(renderer);
		} catch (error) {
			renderer.destroy();
			reject(error);
			return;
		}
		let settled = false;
		let unmounted = false;
		const unmountRoot = () => {
			if (unmounted) {
				return;
			}
			unmounted = true;
			root.unmount();
		};
		const settle = (code: number) => {
			if (settled) {
				return;
			}
			settled = true;
			unmountRoot();
			renderer.destroy();
			resolve(code);
		};
		renderer.on("destroy", () => {
			unmountRoot();
			if (!settled) {
				settled = true;
				resolve(1);
			}
		});
		try {
			root.render(
				React.createElement(OnboardingView, {
					providerSettingsManager: input.providerSettingsManager,
					onComplete: () => settle(0),
					onExit: () => settle(1),
				}),
			);
		} catch (error) {
			unmountRoot();
			renderer.destroy();
			reject(error);
		}
	});
}

export async function runAuthCommand(input: AuthCommandInput): Promise<number> {
	const hasQuickSetupFlags =
		typeof input.apikey === "string" ||
		typeof input.modelid === "string" ||
		typeof input.baseurl === "string" ||
		typeof input.azureApiVersion === "string";

	if (hasQuickSetupFlags) {
		if (!input.explicitProvider?.trim()) {
			input.io.writeErr(
				"auth quick setup requires --provider <id> when using --apikey/--modelid/--baseurl/--azure-api-version",
			);
			return 1;
		}
		return runQuickAuthSetup(input);
	}

	if (input.explicitProvider?.trim()) {
		const providerId = normalizeAuthProviderId(input.explicitProvider);
		if (isOAuthProvider(providerId)) {
			return runAuthProviderCommand(
				input.providerSettingsManager,
				providerId,
				input.io,
			);
		}
		input.io.writeErr(
			`provider "${providerId}" requires API key setup (use subcommand: auth --provider ${providerId} --apikey <key> --modelid <id>)`,
		);
		return 1;
	}

	return runInteractiveAuthTui(input);
}

export async function runAuthProviderCommand(
	providerSettingsManager: ProviderSettingsManager,
	providerId: string,
	io: AuthIo,
): Promise<number> {
	if (!isOAuthProvider(providerId)) {
		io.writeErr(
			`provider "${providerId}" does not support OAuth login (supported: cline, openai-codex, oca)`,
		);
		return 1;
	}
	try {
		const settings = await loginAndSaveProviderOAuthCredentials(
			providerSettingsManager,
			providerId,
			{ callbacks: createOAuthCallbacks(io) },
		);
		identifyTelemetryAccount({
			id: settings.auth?.accountId,
			provider: providerId,
		});
		io.writeln(
			`${c.green}You are now logged in to ${c.cyan}${providerId}${c.reset}`,
		);
		return 0;
	} catch (error) {
		io.writeErr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
