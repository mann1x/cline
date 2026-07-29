// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	Provider,
	RealtimeVoiceModeSettings,
	VoiceInputModeSettings,
	VoiceOutputModeSettings,
} from "@/lib/provider-schema";
import {
	ProviderDetailContent,
	ProviderListContent,
} from "./provider-list-view";

const providers: Provider[] = [
	{
		id: "elevenlabs",
		name: "ElevenLabs",
		models: 1,
		color: "#000000",
		letter: "EL",
		enabled: true,
		modelList: [
			{
				id: "scribe_v2",
				name: "Scribe v2",
				inputModalities: ["audio"],
				outputModalities: ["text"],
			},
			{
				id: "eleven_turbo_v2_5",
				name: "Eleven Turbo v2.5",
				inputModalities: ["text"],
				outputModalities: ["audio"],
			},
		],
	},
	{
		id: "groq",
		name: "Groq",
		models: 3,
		color: "#000000",
		letter: "GR",
		enabled: true,
		modelList: [
			{
				id: "whisper-large-v3",
				name: "Whisper Large v3",
				inputModalities: ["audio"],
				outputModalities: ["text"],
			},
			{
				id: "whisper-large-v3-turbo",
				name: "Whisper Large v3 Turbo",
				inputModalities: ["audio"],
				outputModalities: ["text"],
			},
			{
				id: "llama-chat",
				name: "Llama Chat",
				inputModalities: ["text"],
				outputModalities: ["text"],
			},
		],
	},
	{
		id: "gemini",
		name: "Google Gemini",
		models: 1,
		color: "#000000",
		letter: "GG",
		enabled: true,
		modelList: [
			{
				id: "gemini-3.5-live-translate-preview",
				name: "Gemini 3.5 Live Translate Preview",
				inputModalities: ["audio"],
				outputModalities: ["audio", "text"],
			},
		],
	},
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

describe("ProviderListContent voice input settings", () => {
	it("opens and focuses provider search with Cmd+F or Ctrl+F", async () => {
		await act(async () => {
			root.render(
				<ProviderListContent
					onAddProvider={vi.fn()}
					onConfigure={vi.fn()}
					onRealtimeVoiceChange={vi.fn()}
					onToggle={vi.fn()}
					onVoiceInputChange={vi.fn()}
					onVoiceOutputChange={vi.fn()}
					providers={providers}
				/>,
			);
		});

		const cmdFind = new KeyboardEvent("keydown", {
			key: "f",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => window.dispatchEvent(cmdFind));
		const searchInput = container.querySelector<HTMLInputElement>(
			'[aria-label="Search model providers"]',
		);
		expect(cmdFind.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(searchInput);

		searchInput?.blur();
		const ctrlFind = new KeyboardEvent("keydown", {
			key: "F",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => window.dispatchEvent(ctrlFind));
		expect(ctrlFind.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(searchInput);
	});

	it("lets the user choose and clear the voice provider and model", async () => {
		const onVoiceInputChange = vi.fn();
		let selection: VoiceInputModeSettings | undefined = {
			providerId: "elevenlabs",
			modelId: "scribe_v2",
		};
		const render = async () => {
			await act(async () => {
				root.render(
					<ProviderListContent
						onAddProvider={vi.fn()}
						onConfigure={vi.fn()}
						onRealtimeVoiceChange={vi.fn()}
						onToggle={vi.fn()}
						onVoiceInputChange={onVoiceInputChange}
						onVoiceOutputChange={vi.fn()}
						providers={providers}
						voiceInput={selection}
					/>,
				);
			});
		};

		await render();
		const providerSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Voice input provider"]',
		);
		const modelSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Voice input model"]',
		);
		expect(providerSelect?.value).toBe("elevenlabs");
		expect(modelSelect?.value).toBe("scribe_v2");

		await act(async () => {
			if (!providerSelect) return;
			providerSelect.value = "groq";
			providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onVoiceInputChange).toHaveBeenLastCalledWith({
			providerId: "groq",
			modelId: "whisper-large-v3",
		});

		selection = {
			providerId: "groq",
			modelId: "whisper-large-v3",
		};
		await render();
		const groqModelSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Voice input model"]',
		);
		await act(async () => {
			if (!groqModelSelect) return;
			groqModelSelect.value = "whisper-large-v3-turbo";
			groqModelSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onVoiceInputChange).toHaveBeenLastCalledWith({
			providerId: "groq",
			modelId: "whisper-large-v3-turbo",
		});

		const groqProviderSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Voice input provider"]',
		);
		await act(async () => {
			if (!groqProviderSelect) return;
			groqProviderSelect.value = "";
			groqProviderSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onVoiceInputChange).toHaveBeenLastCalledWith(undefined);
	});

	it("lets the user configure a text-to-audio model and provider voice", async () => {
		const onVoiceOutputChange = vi.fn();
		let selection: VoiceOutputModeSettings | undefined;
		const render = async () => {
			await act(async () => {
				root.render(
					<ProviderListContent
						onAddProvider={vi.fn()}
						onConfigure={vi.fn()}
						onRealtimeVoiceChange={vi.fn()}
						onToggle={vi.fn()}
						onVoiceInputChange={vi.fn()}
						onVoiceOutputChange={onVoiceOutputChange}
						providers={providers}
						voiceOutput={selection}
					/>,
				);
			});
		};

		await render();
		const providerSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Voice output provider"]',
		);
		await act(async () => {
			if (!providerSelect) return;
			providerSelect.value = "elevenlabs";
			providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onVoiceOutputChange).toHaveBeenLastCalledWith({
			providerId: "elevenlabs",
			modelId: "eleven_turbo_v2_5",
		});

		selection = {
			providerId: "elevenlabs",
			modelId: "eleven_turbo_v2_5",
		};
		await render();
		const voiceInput = container.querySelector<HTMLInputElement>(
			'[aria-label="Voice output voice"]',
		);
		await act(async () => {
			if (!voiceInput) return;
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setValue?.call(voiceInput, "voice-123");
			voiceInput.dispatchEvent(new Event("input", { bubbles: true }));
			voiceInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(onVoiceOutputChange).toHaveBeenLastCalledWith({
			providerId: "elevenlabs",
			modelId: "eleven_turbo_v2_5",
			voice: "voice-123",
		});
	});

	it("lets the user configure a realtime audio model without hard-coding a voice", async () => {
		const onRealtimeVoiceChange = vi.fn();
		let selection: RealtimeVoiceModeSettings | undefined;
		const render = async () => {
			await act(async () => {
				root.render(
					<ProviderListContent
						onAddProvider={vi.fn()}
						onConfigure={vi.fn()}
						onRealtimeVoiceChange={onRealtimeVoiceChange}
						onToggle={vi.fn()}
						onVoiceInputChange={vi.fn()}
						onVoiceOutputChange={vi.fn()}
						providers={providers}
						realtimeVoice={selection}
					/>,
				);
			});
		};

		await render();
		const providerSelect = container.querySelector<HTMLSelectElement>(
			'[aria-label="Realtime voice provider"]',
		);
		await act(async () => {
			if (!providerSelect) return;
			providerSelect.value = "gemini";
			providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onRealtimeVoiceChange).toHaveBeenLastCalledWith({
			providerId: "gemini",
			modelId: "gemini-3.5-live-translate-preview",
		});

		selection = {
			providerId: "gemini",
			modelId: "gemini-3.5-live-translate-preview",
		};
		await render();
		expect(
			container.querySelector<HTMLSelectElement>(
				'[aria-label="Realtime voice model"]',
			)?.value,
		).toBe("gemini-3.5-live-translate-preview");
		expect(
			container.querySelector<HTMLInputElement>(
				'[aria-label="Realtime voice name"]',
			)?.placeholder,
		).toBe("Provider default");
	});
});

describe("ProviderDetailContent model capabilities", () => {
	it("shows image, audio, and reasoning icons beside supported models", async () => {
		const provider: Provider = {
			id: "capability-provider",
			name: "Capability Provider",
			models: 3,
			color: "#000000",
			letter: "CP",
			enabled: true,
			modelList: [
				{
					id: "audio-input",
					name: "Audio Input",
					inputModalities: ["audio"],
					outputModalities: ["text"],
				},
				{
					id: "audio-output",
					name: "Audio Output",
					inputModalities: ["text"],
					outputModalities: ["audio"],
				},
				{
					id: "reasoning-vision",
					name: "Reasoning Vision",
					supportsReasoning: true,
					supportsVision: true,
				},
			],
		};

		await act(async () => {
			root.render(
				<ProviderDetailContent
					onBack={vi.fn()}
					onUpdate={vi.fn()}
					provider={provider}
				/>,
			);
		});

		expect(
			container.querySelectorAll(
				'[role="img"][aria-label="Audio support"] .lucide-mic',
			),
		).toHaveLength(2);
		expect(
			container.querySelector(
				'[role="img"][aria-label="Image support"] .lucide-image',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[role="img"][aria-label="Reasoning support"] .lucide-brain',
			),
		).not.toBeNull();
	});
});
