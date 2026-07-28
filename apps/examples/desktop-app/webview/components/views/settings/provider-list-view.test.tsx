// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider, VoiceInputSelection } from "@/lib/provider-schema";
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
	it("lets the user choose and clear the voice provider and model", async () => {
		const onVoiceInputChange = vi.fn();
		let selection: VoiceInputSelection | undefined = {
			providerId: "elevenlabs",
			modelId: "scribe_v2",
		};
		const render = async () => {
			await act(async () => {
				root.render(
					<ProviderListContent
						onAddProvider={vi.fn()}
						onConfigure={vi.fn()}
						onToggle={vi.fn()}
						onVoiceInputChange={onVoiceInputChange}
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
