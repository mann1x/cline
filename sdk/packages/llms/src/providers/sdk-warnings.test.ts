import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { BasicLogger } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	installAiSdkWarningLogger,
	resetAiSdkWarningLogger,
	suppressedWarningCount,
} from "./sdk-warnings";

interface Logged {
	message: string;
	severity?: string;
}

function capture(): { logged: Logged[]; logger: BasicLogger } {
	const logged: Logged[] = [];
	return {
		logged,
		logger: {
			log: (message: string, options?: { severity?: string }) => {
				logged.push({
					message,
					...(options?.severity ? { severity: options.severity } : {}),
				});
			},
			debug: () => {},
		},
	};
}

describe("the ollama responses-converter warnings", () => {
	afterEach(() => {
		resetAiSdkWarningLogger();
	});

	it("is a warning about a conversion the provider never sends", () => {
		// The invariant the whole filter rests on, asserted against the installed
		// package rather than believed. `prepareRequest` calls
		// `convertToOllamaResponsesMessages` and keeps only its `warnings` --
		// destructuring the messages away -- then builds the body from
		// `convertToOllamaChatMessages`, which does carry `thinking`. So every
		// warning that converter emits is about a request that is never sent.
		//
		// If a version bump makes the responses converter live, this fails, and
		// the filter has to be revisited rather than silently hiding a real
		// limitation.
		const require_ = createRequire(import.meta.url);
		const dist = readFileSync(
			require_.resolve("ollama-ai-provider-v2"),
			"utf8",
		);
		expect(dist).toContain(
			"const { warnings: messageWarnings } = convertToOllamaResponsesMessages({",
		);
		expect(dist).toContain("messages: convertToOllamaChatMessages({");
		expect(dist).toContain(
			'"reasoning parts in assistant messages are not supported for Ollama responses"',
		);
	});

	it("drops them and keeps everything else", () => {
		const { logged, logger } = capture();
		installAiSdkWarningLogger({ logger });

		(globalThis as { AI_SDK_LOG_WARNINGS?: unknown })
			.AI_SDK_LOG_WARNINGS as never;
		const log = (globalThis as { AI_SDK_LOG_WARNINGS?: (o: unknown) => void })
			.AI_SDK_LOG_WARNINGS;
		log?.({
			provider: "ollama.responses",
			model: "v7-coder",
			warnings: [
				{
					type: "other",
					message:
						"reasoning parts in assistant messages are not supported for Ollama responses",
				},
				{
					type: "other",
					message:
						'Unsupported assistant part type "file" for Ollama responses',
				},
				{ type: "unsupported-setting", setting: "topK" },
			],
		});

		expect(suppressedWarningCount()).toBe(2);
		// The real one survives, and is attributed.
		expect(logged.some((entry) => entry.message.includes("topK"))).toBe(true);
		expect(
			logged.some((entry) =>
				entry.message.includes("not supported for Ollama responses"),
			),
		).toBe(false);
	});

	it("says once that it is hiding them, rather than hiding them silently", () => {
		const { logged, logger } = capture();
		installAiSdkWarningLogger({ logger });
		const log = (globalThis as { AI_SDK_LOG_WARNINGS?: (o: unknown) => void })
			.AI_SDK_LOG_WARNINGS;
		const payload = {
			provider: "ollama.responses",
			model: "v7-coder",
			warnings: [
				{
					type: "other",
					message:
						"reasoning parts in assistant messages are not supported for Ollama responses",
				},
			],
		};
		log?.(payload);
		log?.(payload);
		log?.(payload);

		const notices = logged.filter((entry) =>
			entry.message.includes("unused responses converter"),
		);
		expect(notices).toHaveLength(1);
		expect(suppressedWarningCount()).toBe(3);
	});

	it("leaves a warning from any other provider alone", () => {
		// Keyed on the vendor's own name for the converter, not on the words
		// "reasoning" or "not supported": another provider that genuinely cannot
		// take reasoning has to keep saying so.
		const { logged, logger } = capture();
		installAiSdkWarningLogger({ logger });
		const log = (globalThis as { AI_SDK_LOG_WARNINGS?: (o: unknown) => void })
			.AI_SDK_LOG_WARNINGS;
		log?.({
			provider: "openai.chat",
			model: "gpt-5",
			warnings: [
				{
					type: "other",
					message: "reasoning parts in assistant messages are not supported",
				},
			],
		});

		expect(suppressedWarningCount()).toBe(0);
		expect(
			logged.some((entry) => entry.message.includes("reasoning parts")),
		).toBe(true);
	});

	it("installs once, and can be uninstalled", () => {
		const { logger } = capture();
		installAiSdkWarningLogger({ logger });
		const first = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown })
			.AI_SDK_LOG_WARNINGS;
		installAiSdkWarningLogger({ logger });
		expect(
			(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS,
		).toBe(first);
		resetAiSdkWarningLogger();
		expect(
			(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS,
		).toBeUndefined();
	});
});
