// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDesktopDebugLog } from "./desktop-client";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("writeDesktopDebugLog", () => {
	it("prints valid sidecar diagnostics to the webview console", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

		writeDesktopDebugLog({
			scope: "voice-input",
			level: "debug",
			message: "Starting audio transcription",
			timestamp: "2026-07-28T00:00:00.000Z",
			metadata: {
				providerId: "vercel-ai-gateway",
				modelId: "openai/whisper-1",
				endpoint: "https://ai-gateway.vercel.sh/v1/ai/transcription-model",
			},
		});

		expect(debugSpy).toHaveBeenCalledWith(
			"[desktop:voice-input] Starting audio transcription",
			expect.objectContaining({
				providerId: "vercel-ai-gateway",
				modelId: "openai/whisper-1",
				endpoint: "https://ai-gateway.vercel.sh/v1/ai/transcription-model",
			}),
		);
	});

	it("ignores malformed debug events", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

		writeDesktopDebugLog({
			scope: "voice-input",
			level: "verbose",
			message: "invalid",
		});

		expect(debugSpy).not.toHaveBeenCalled();
	});
});
