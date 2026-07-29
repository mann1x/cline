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

	it("prints handled errors without triggering the Next.js error overlay", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		writeDesktopDebugLog({
			scope: "realtime-voice",
			level: "error",
			message: "Realtime voice session failed in the webview",
			timestamp: "2026-07-28T00:00:00.000Z",
			metadata: {
				providerId: "vercel-ai-gateway",
				modelId: "xai/grok-voice-think-fast-1.0",
				failure: "User not found.",
			},
		});

		expect(errorSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"[desktop:realtime-voice] Realtime voice session failed in the webview",
			expect.objectContaining({
				severity: "error",
				failure: "User not found.",
			}),
		);
	});
});
