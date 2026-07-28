// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/chat-schema";
import { ChatMessages } from "./chat-messages";

const {
	audioPauseMock,
	audioPlayMock,
	invokeMock,
	loadProviderModelCatalogMock,
	writeDesktopDebugLogMock,
} = vi.hoisted(() => ({
	audioPauseMock: vi.fn(),
	audioPlayMock: vi.fn(async () => undefined),
	invokeMock: vi.fn(),
	loadProviderModelCatalogMock: vi.fn(),
	writeDesktopDebugLogMock: vi.fn(),
}));

vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke: invokeMock },
	writeDesktopDebugLog: writeDesktopDebugLogMock,
}));

vi.mock("@/lib/provider-model-catalog", () => ({
	loadProviderModelCatalog: loadProviderModelCatalogMock,
	MODE_SETTINGS_CHANGED_EVENT: "cline:test-mode-settings-changed",
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	class MockAudio {
		constructor(public src: string) {}

		addEventListener() {}
		pause = audioPauseMock;
		play = audioPlayMock;
		removeAttribute() {}
	}
	vi.stubGlobal("Audio", MockAudio);
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: vi.fn(() => "blob:assistant-speech"),
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: vi.fn(),
	});
	audioPauseMock.mockClear();
	audioPlayMock.mockClear();
	invokeMock.mockReset().mockResolvedValue({
		audioBase64: "aGVsbG8=",
		mediaType: "audio/mpeg",
	});
	loadProviderModelCatalogMock.mockReset().mockResolvedValue({
		modes: {
			voiceInput: null,
			voiceOutput: {
				providerId: "elevenlabs",
				providerName: "ElevenLabs",
				modelId: "elevenlabs-v2.5-turbo",
				modelName: "ElevenLabs v2.5 Turbo",
				voice: "voice-1",
			},
		},
	});
	writeDesktopDebugLogMock.mockClear();
	HTMLElement.prototype.scrollTo = vi.fn();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderMessages(
	messages: ChatMessage[],
	overrides: Partial<Parameters<typeof ChatMessages>[0]> = {},
) {
	await act(async () => {
		root.render(
			<ChatMessages
				chatTransportState="connected"
				error={null}
				messages={messages}
				onAnswerAskQuestion={vi.fn()}
				onApproveToolApproval={vi.fn()}
				onRejectToolApproval={vi.fn()}
				pendingAskQuestions={[]}
				pendingToolApprovals={[]}
				sessionId="session-1"
				status="completed"
				{...overrides}
			/>,
		);
		await Promise.resolve();
	});
}

describe("ChatMessages tool disclosures", () => {
	it("renders a detail-less tool summary as static text", async () => {
		await renderMessages([
			{
				id: "tool-static",
				sessionId: "session-1",
				role: "tool",
				content: "not-json",
				createdAt: 1,
				meta: { toolName: "search" },
			},
		]);

		const summary = [...container.querySelectorAll("span")].find((element) =>
			element.textContent?.includes("Explored"),
		);
		expect(summary).toBeDefined();
		expect(summary?.closest("button")).toBeNull();
	});

	it("exposes and toggles expandable tool details", async () => {
		await renderMessages([
			{
				id: "tool-expandable",
				sessionId: "session-1",
				role: "tool",
				content: JSON.stringify({
					toolName: "search",
					input: { queries: ["workspace selector"] },
					result: {},
				}),
				createdAt: 1,
			},
		]);

		const trigger = [...container.querySelectorAll("button")].find((element) =>
			element.textContent?.includes("Explored 1 search"),
		);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		const panelId = trigger?.getAttribute("aria-controls");
		expect(panelId).toBeTruthy();

		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById(panelId ?? "")?.textContent).toContain(
			"workspace selector",
		);
	});

	it("groups consecutive tool calls and combines matching activity totals", async () => {
		const tools: ChatMessage[] = [
			{
				id: "read",
				sessionId: "session-1",
				role: "tool",
				content: JSON.stringify({
					toolName: "read_files",
					input: { paths: ["one.ts", "two.ts"] },
					result: {},
				}),
				createdAt: 1,
			},
			...["one.ts", "two.ts", "three.ts", "four.ts"].map(
				(path, index): ChatMessage => ({
					id: `edit-${index}`,
					sessionId: "session-1",
					role: "tool",
					content: JSON.stringify({
						toolName: "editor",
						input: { path, old_text: "before", new_text: "after" },
						result: {},
					}),
					createdAt: index + 2,
				}),
			),
		];

		await renderMessages(tools);

		expect(container.textContent).toContain("Read 2 files. Edited 4 files");
		expect(container.textContent?.match(/Read 2 files/g)).toHaveLength(1);
	});

	it("preserves interleaved tool activity order", async () => {
		const read = (
			id: string,
			path: string,
			createdAt: number,
		): ChatMessage => ({
			id,
			sessionId: "session-1",
			role: "tool",
			content: JSON.stringify({
				toolName: "read_files",
				input: { paths: [path] },
				result: {},
			}),
			createdAt,
		});

		await renderMessages([
			read("read-before", "before.ts", 1),
			{
				id: "edit",
				sessionId: "session-1",
				role: "tool",
				content: JSON.stringify({
					toolName: "editor",
					input: {
						path: "change.ts",
						old_text: "before",
						new_text: "after",
					},
					result: {},
				}),
				createdAt: 2,
			},
			read("read-after", "after.ts", 3),
		]);

		expect(container.textContent).toContain(
			"Read 1 file. Edited 1 file. Read 1 file",
		);
	});

	it("starts a new tool group after non-tool content", async () => {
		const tool = (id: string, createdAt: number): ChatMessage => ({
			id,
			sessionId: "session-1",
			role: "tool",
			content: JSON.stringify({
				toolName: "read_files",
				input: { paths: [`${id}.ts`] },
				result: {},
			}),
			createdAt,
		});

		await renderMessages([
			tool("first", 1),
			{
				id: "assistant",
				sessionId: "session-1",
				role: "assistant",
				content: "Between tools",
				createdAt: 2,
			},
			tool("second", 3),
		]);

		expect(container.textContent?.match(/Read 1 file/g)).toHaveLength(2);
	});

	it("normalizes payload-backed configured subagent names", async () => {
		await renderMessages([
			{
				id: "commands",
				sessionId: "session-1",
				role: "tool",
				content: JSON.stringify({
					toolName: "run_commands",
					input: { commands: ["bun test", "bun run typecheck"] },
					result: {},
				}),
				createdAt: 1,
			},
			...[2, 3, 4].map(
				(createdAt): ChatMessage => ({
					id: `configured-subagent-${createdAt}`,
					sessionId: "session-1",
					role: "tool",
					content: JSON.stringify({
						toolName: "subagent_subagent",
						input: { prompt: "Investigate" },
						result: { text: "Done" },
					}),
					createdAt,
				}),
			),
		]);

		expect(container.textContent).toContain(
			"Ran 2 commands. spawn_agent. spawn_agent. spawn_agent",
		);
		expect(container.textContent).not.toContain("subagent_subagent");
	});

	it("does not render assistant actions without text content", async () => {
		await renderMessages([
			{
				id: "reasoning-only",
				sessionId: "session-1",
				role: "assistant",
				content: "",
				reasoning: "Internal reasoning",
				createdAt: 1,
			},
		]);

		expect(
			container.querySelector('button[aria-label="Copy assistant message"]'),
		).toBeNull();
	});
});

describe("ChatMessages copy actions", () => {
	it("copies displayed user text without the internal user_input envelope", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});

		await renderMessages([
			{
				id: "wrapped-user",
				sessionId: "session-1",
				role: "user",
				content: '<user_input mode="act">\nPlease fix the tests\n</user_input>',
				createdAt: 1,
			},
		]);

		const copy = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Copy user message"]',
		);
		await act(async () => copy?.click());

		expect(writeText).toHaveBeenCalledWith("Please fix the tests");
	});
});

describe("ChatMessages voice output actions", () => {
	it("synthesizes and plays the selected assistant message on click", async () => {
		await renderMessages([
			{
				id: "assistant-to-speak",
				sessionId: "session-1",
				role: "assistant",
				content: "This is the assistant response.",
				createdAt: 1,
			},
		]);

		const speak = await vi.waitFor(() => {
			const button = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Speak assistant message"]',
			);
			expect(button?.disabled).toBe(false);
			return button as HTMLButtonElement;
		});
		expect(invokeMock).not.toHaveBeenCalled();

		await act(async () => {
			speak.click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(invokeMock).toHaveBeenCalledWith("synthesize_speech", {
			text: "This is the assistant response.",
		});
		expect(audioPlayMock).toHaveBeenCalledOnce();
		expect(
			container.querySelector(
				'button[aria-label="Stop speaking assistant message"]',
			),
		).not.toBeNull();

		await act(async () => {
			container
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Stop speaking assistant message"]',
				)
				?.click();
		});
		expect(audioPauseMock).toHaveBeenCalledOnce();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:assistant-speech");
		expect(
			container.querySelector('button[aria-label="Speak assistant message"]'),
		).not.toBeNull();
	});

	it("cancels a pending synthesis response from the same action", async () => {
		let resolveSynthesis:
			| ((value: { audioBase64: string; mediaType: string }) => void)
			| undefined;
		invokeMock.mockReturnValue(
			new Promise<{ audioBase64: string; mediaType: string }>((resolve) => {
				resolveSynthesis = resolve;
			}),
		);
		await renderMessages([
			{
				id: "assistant-pending-speech",
				sessionId: "session-1",
				role: "assistant",
				content: "Cancel this request.",
				createdAt: 1,
			},
		]);

		const speak = await vi.waitFor(() => {
			const button = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Speak assistant message"]',
			);
			expect(button?.disabled).toBe(false);
			return button as HTMLButtonElement;
		});
		await act(async () => speak.click());

		const cancel = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Cancel speech generation"]',
		);
		expect(cancel?.disabled).toBe(false);
		await act(async () => cancel?.click());
		await act(async () => {
			resolveSynthesis?.({
				audioBase64: "aGVsbG8=",
				mediaType: "audio/mpeg",
			});
			await Promise.resolve();
		});

		expect(audioPlayMock).not.toHaveBeenCalled();
		expect(
			container.querySelector('button[aria-label="Speak assistant message"]'),
		).not.toBeNull();
	});

	it("opens model settings when voice output is not configured", async () => {
		loadProviderModelCatalogMock.mockResolvedValue({
			modes: { voiceInput: null, voiceOutput: null },
		});
		const onOpenVoiceOutputSettings = vi.fn();
		await renderMessages(
			[
				{
					id: "assistant-without-voice-output",
					sessionId: "session-1",
					role: "assistant",
					content: "Configure speech first.",
					createdAt: 1,
				},
			],
			{ onOpenVoiceOutputSettings },
		);

		const configure = await vi.waitFor(() => {
			const button = container.querySelector<HTMLButtonElement>(
				'button[aria-label="Configure voice output"]',
			);
			expect(button?.disabled).toBe(false);
			return button as HTMLButtonElement;
		});
		await act(async () => configure.click());

		expect(onOpenVoiceOutputSettings).toHaveBeenCalledOnce();
		expect(invokeMock).not.toHaveBeenCalled();
	});
});

describe("ChatMessages errors", () => {
	it("caps persisted error messages in a scrollable block", async () => {
		await renderMessages([
			{
				id: "error-1",
				sessionId: "session-1",
				role: "error",
				content: "Invalid prompt\n".repeat(100),
				createdAt: 1,
			},
		]);

		const alert = container.querySelector<HTMLElement>('[role="alert"]');
		expect(alert?.className).toContain("max-h-44");
		expect(alert?.className).toContain("overflow-y-auto");
	});

	it("caps transient error banners in a scrollable block", async () => {
		await renderMessages([], {
			error: "Request failed\n".repeat(100),
		});

		const alert = container.querySelector<HTMLElement>('[role="alert"]');
		expect(alert?.className).toContain("max-h-44");
		expect(alert?.className).toContain("overflow-y-auto");
	});
});

describe("ChatMessages image attachments", () => {
	it("renders persisted image blocks in the user message", async () => {
		await renderMessages([
			{
				id: "user-image",
				sessionId: "session-1",
				role: "user",
				content: "Describe this",
				images: [
					{ id: "user-image-1", mediaType: "image/png", data: "aGVsbG8=" },
				],
				createdAt: 1,
			},
		]);

		const image = container.querySelector<HTMLImageElement>(
			'img[alt="Attachment 1"]',
		);
		expect(image?.src).toBe("data:image/png;base64,aGVsbG8=");
		expect(image?.className).toContain("max-h-[225px]");
		expect(image?.className).toContain("max-w-[225px]");
		expect(container.textContent).toContain("Describe this");
	});

	it("renders an image-only assistant response", async () => {
		await renderMessages([
			{
				id: "assistant-image",
				sessionId: "session-1",
				role: "assistant",
				content: "",
				images: [
					{
						id: "generated-image-1",
						mediaType: "image/webp",
						data: "aGVsbG8=",
					},
				],
				createdAt: 1,
			},
		]);

		expect(
			container.querySelector<HTMLImageElement>('img[alt="Generated result 1"]')
				?.src,
		).toBe("data:image/webp;base64,aGVsbG8=");
	});

	it("shows one generated image at a time and navigates the result set", async () => {
		await renderMessages([
			{
				id: "assistant-images",
				sessionId: "session-1",
				role: "assistant",
				content: "",
				images: [
					{
						id: "generated-image-1",
						mediaType: "image/png",
						data: "Zmlyc3Q=",
					},
					{
						id: "generated-image-2",
						mediaType: "image/png",
						data: "c2Vjb25k",
					},
				],
				createdAt: 1,
			},
		]);

		expect(
			container.querySelector<HTMLImageElement>('img[alt="Generated result 1"]')
				?.src,
		).toBe("data:image/png;base64,Zmlyc3Q=");
		expect(container.querySelector('img[alt="Generated result 2"]')).toBeNull();
		expect(container.textContent).toContain("1 / 2");

		const previous = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Previous generated image"]',
		);
		const next = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Next generated image"]',
		);
		expect(previous?.disabled).toBe(true);
		await act(async () => next?.click());

		expect(
			container.querySelector<HTMLImageElement>('img[alt="Generated result 2"]')
				?.src,
		).toBe("data:image/png;base64,c2Vjb25k");
		expect(container.textContent).toContain("2 / 2");
		expect(next?.disabled).toBe(true);

		await act(async () => previous?.click());
		expect(
			container.querySelector<HTMLImageElement>('img[alt="Generated result 1"]')
				?.src,
		).toBe("data:image/png;base64,Zmlyc3Q=");
	});

	it("expands an attachment within the conversation and closes it", async () => {
		await renderMessages([
			{
				id: "user-image",
				sessionId: "session-1",
				role: "user",
				content: "Describe this",
				images: [
					{ id: "user-image-1", mediaType: "image/png", data: "aGVsbG8=" },
				],
				createdAt: 1,
			},
		]);

		const expand = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Expand attachment 1"]',
		);
		await act(async () => expand?.click());

		expect(
			container.querySelector(
				'[role="dialog"][aria-label="Expanded attachment"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector<HTMLImageElement>(
				'img[alt="Expanded attachment"]',
			)?.src,
		).toBe("data:image/png;base64,aGVsbG8=");

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});
});

describe("ChatMessages thinking indicator", () => {
	const userMessage: ChatMessage = {
		id: "user-1",
		sessionId: "session-1",
		role: "user",
		content: "Hello",
		createdAt: 1,
	};

	it("shows while starting", async () => {
		await renderMessages([userMessage], { status: "starting" });
		expect(container.textContent).toContain("Thinking...");
	});

	it("keeps showing while running until the first assistant output arrives", async () => {
		await renderMessages([userMessage], { status: "running" });
		expect(container.textContent).toContain("Thinking...");
	});

	it("ignores trailing status messages when deciding to show", async () => {
		await renderMessages(
			[
				userMessage,
				{
					id: "status-1",
					sessionId: "session-1",
					role: "status",
					content: "Session started: session-1",
					createdAt: 2,
				},
			],
			{ status: "running" },
		);

		expect(container.textContent).toContain("Thinking...");
	});

	it("hides once assistant output is streaming", async () => {
		await renderMessages(
			[
				userMessage,
				{
					id: "assistant-1",
					sessionId: "session-1",
					role: "assistant",
					content: "Working on it",
					createdAt: 2,
				},
			],
			{ status: "running", streamingMessageId: "assistant-1" },
		);

		expect(container.textContent).not.toContain("Thinking...");
	});

	it("hides while a tool runs", async () => {
		await renderMessages(
			[
				userMessage,
				{
					id: "tool-1",
					sessionId: "session-1",
					role: "tool",
					content: "not-json",
					createdAt: 2,
					meta: { toolName: "search" },
				},
			],
			{ status: "running" },
		);

		expect(container.textContent).not.toContain("Thinking...");
	});

	it("hides while a tool approval is pending", async () => {
		await renderMessages([userMessage], {
			status: "running",
			pendingToolApprovals: [
				{
					requestId: "req-1",
					sessionId: "session-1",
					createdAt: new Date(1).toISOString(),
					toolCallId: "call-1",
					toolName: "execute_command",
				},
			],
		});

		expect(container.textContent).not.toContain("Thinking...");
	});
});
