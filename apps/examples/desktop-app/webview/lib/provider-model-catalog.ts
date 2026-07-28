"use client";

import { desktopClient } from "@/lib/desktop-client";
import type {
	Provider,
	ProviderCatalogResponse,
	ProviderModel,
	ProviderModelsResponse,
	VoiceInputSelection,
	VoiceOutputSelection,
} from "@/lib/provider-schema";

export type ProviderModelCatalog = {
	providers: Provider[];
	enabledProviderIds: string[];
	providerModels: Record<string, string[]>;
	providerReasoningModels: Record<string, string[]>;
	voiceInput: TranscriptionModelTarget | null;
	voiceOutput: SpeechGenerationModelTarget | null;
};

export type TranscriptionModelTarget = {
	providerId: string;
	providerName: string;
	modelId: string;
	modelName: string;
	supportsStreaming: boolean;
};

export type SpeechGenerationModelTarget = {
	providerId: string;
	providerName: string;
	modelId: string;
	modelName: string;
	voice?: string;
};

export function isDedicatedTranscriptionModel(model: ProviderModel): boolean {
	return (
		model.inputModalities?.length === 1 &&
		model.inputModalities[0] === "audio" &&
		model.outputModalities?.length === 1 &&
		model.outputModalities[0] === "text"
	);
}

export function supportsAudio(model: ProviderModel): boolean {
	return (
		model.inputModalities?.includes("audio") === true ||
		model.outputModalities?.includes("audio") === true
	);
}

export function isSpeechGenerationModel(model: ProviderModel): boolean {
	return (
		model.inputModalities?.length === 1 &&
		model.inputModalities[0] === "text" &&
		model.outputModalities?.length === 1 &&
		model.outputModalities[0] === "audio"
	);
}

export function selectTranscriptionModel(
	providers: Provider[],
	selection: VoiceInputSelection | undefined,
): TranscriptionModelTarget | null {
	if (!selection) return null;
	const provider = providers.find(
		(candidate) => candidate.enabled && candidate.id === selection.providerId,
	);
	const model = provider?.modelList?.find(
		(candidate) =>
			candidate.id === selection.modelId &&
			isDedicatedTranscriptionModel(candidate),
	);
	return provider && model
		? {
				providerId: provider.id,
				providerName: provider.name,
				modelId: model.id,
				modelName: model.name,
				supportsStreaming: model.supportsStreamingTranscription === true,
			}
		: null;
}

export function selectSpeechGenerationModel(
	providers: Provider[],
	selection: VoiceOutputSelection | undefined,
): SpeechGenerationModelTarget | null {
	if (!selection) return null;
	const provider = providers.find(
		(candidate) => candidate.enabled && candidate.id === selection.providerId,
	);
	const model = provider?.modelList?.find(
		(candidate) =>
			candidate.id === selection.modelId && isSpeechGenerationModel(candidate),
	);
	return provider && model
		? {
				providerId: provider.id,
				providerName: provider.name,
				modelId: model.id,
				modelName: model.name,
				voice: selection.voice,
			}
		: null;
}

export function isChatModel(model: ProviderModel): boolean {
	return (
		(model.inputModalities === undefined ||
			model.inputModalities.includes("text")) &&
		(model.outputModalities === undefined ||
			model.outputModalities.includes("text"))
	);
}

function toModelIds(models: ProviderModel[] | undefined): string[] {
	return (models ?? []).filter(isChatModel).map((model) => model.id);
}

function toReasoningModelIds(models: ProviderModel[] | undefined): string[] {
	return (models ?? [])
		.filter((model) => isChatModel(model) && model.supportsReasoning)
		.map((model) => model.id);
}

export function buildProviderModelCatalog(
	providers: Provider[],
	voiceInput?: VoiceInputSelection,
	voiceOutput?: VoiceOutputSelection,
): ProviderModelCatalog {
	return {
		providers,
		enabledProviderIds: providers
			.filter(
				(provider) =>
					provider.enabled && toModelIds(provider.modelList).length > 0,
			)
			.map((provider) => provider.id),
		providerModels: Object.fromEntries(
			providers.map((provider) => [
				provider.id,
				toModelIds(provider.modelList),
			]),
		),
		providerReasoningModels: Object.fromEntries(
			providers.map((provider) => [
				provider.id,
				toReasoningModelIds(provider.modelList),
			]),
		),
		voiceInput: selectTranscriptionModel(providers, voiceInput),
		voiceOutput: selectSpeechGenerationModel(providers, voiceOutput),
	};
}

// The provider catalog payload is large (hundreds of KB) and several
// components request it at startup (composer, onboarding, credentials sync).
// Deduplicate concurrent requests and keep the response briefly so the app
// boot issues a single round-trip instead of one per consumer.
const PROVIDER_CATALOG_CACHE_TTL_MS = 5_000;
export const VOICE_INPUT_SETTINGS_CHANGED_EVENT =
	"cline:voice-input-settings-changed";
export const VOICE_OUTPUT_SETTINGS_CHANGED_EVENT =
	"cline:voice-output-settings-changed";

let providerCatalogCache: {
	fetchedAt: number;
	promise: Promise<ProviderCatalogResponse>;
} | null = null;

export function fetchProviderCatalog(options?: {
	fresh?: boolean;
}): Promise<ProviderCatalogResponse> {
	const now = Date.now();
	if (
		!options?.fresh &&
		providerCatalogCache &&
		now - providerCatalogCache.fetchedAt < PROVIDER_CATALOG_CACHE_TTL_MS
	) {
		return providerCatalogCache.promise;
	}
	const promise = desktopClient
		.invoke<ProviderCatalogResponse>("list_provider_catalog")
		.catch((error) => {
			// Never cache failures.
			if (providerCatalogCache?.promise === promise) {
				providerCatalogCache = null;
			}
			throw error;
		});
	providerCatalogCache = { fetchedAt: now, promise };
	return promise;
}

export function invalidateProviderCatalogCache(): void {
	providerCatalogCache = null;
}

export function notifyVoiceInputSettingsChanged(): void {
	invalidateProviderCatalogCache();
	if (typeof window !== "undefined") {
		window.dispatchEvent(new Event(VOICE_INPUT_SETTINGS_CHANGED_EVENT));
	}
}

export function notifyVoiceOutputSettingsChanged(): void {
	invalidateProviderCatalogCache();
	if (typeof window !== "undefined") {
		window.dispatchEvent(new Event(VOICE_OUTPUT_SETTINGS_CHANGED_EVENT));
	}
}

export async function loadProviderModelCatalog(): Promise<ProviderModelCatalog> {
	const payload = await fetchProviderCatalog();
	return buildProviderModelCatalog(
		payload.providers ?? [],
		payload.voiceInput,
		payload.voiceOutput,
	);
}

export async function loadProviderModels(
	providerId: string,
): Promise<ProviderModel[]> {
	const payload = await desktopClient.invoke<ProviderModelsResponse>(
		"list_provider_models",
		{
			provider: providerId,
		},
	);
	return payload.models ?? [];
}
