import type {
	LanguageModelV4CallOptions,
	LanguageModelV4Message,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	rewritePromptToolImages,
	splitToolImagesMiddleware,
} from "./split-tool-images";

const PLACEHOLDER = "(see following user message for image)";
const OMITTED_PLACEHOLDER = "[media omitted: invalid or exceeds size limit]";

function toolMessage(
	value: Extract<
		Extract<LanguageModelV4Message, { role: "tool" }>["content"][number],
		{ type: "tool-result" }
	>["output"],
): LanguageModelV4Message {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "read_files",
				output: value,
			},
		],
	};
}

describe("rewritePromptToolImages", () => {
	it("leaves prompts without media-bearing tool results unchanged", () => {
		const prompt: LanguageModelV4Message[] = [
			{ role: "system", content: "you are a helpful assistant" },
			{ role: "user", content: [{ type: "text", text: "what is 2+2?" }] },
			toolMessage({ type: "text", value: "4" }),
			toolMessage({
				type: "content",
				value: [{ type: "text", text: "still no media" }],
			}),
		];

		const result = rewritePromptToolImages(prompt);

		expect(result.mutated).toBe(false);
		expect(result.prompt).toEqual(prompt);
	});

	it("moves image data into a typed synthetic user message", () => {
		const prompt = [
			toolMessage({
				type: "content",
				value: [
					{ type: "text", text: "Successfully read image" },
					{
						type: "file",
						data: { type: "data", data: "QkFTRTY0SU1BR0VCWVRFUw==" },
						mediaType: "image/jpeg",
					},
				],
			}),
		];

		const result = rewritePromptToolImages(prompt);

		expect(result.mutated).toBe(true);
		expect(result.prompt).toHaveLength(2);
		const [tool, syntheticUser] = result.prompt;
		expect(tool).toEqual(
			toolMessage({
				type: "content",
				value: [
					{ type: "text", text: "Successfully read image" },
					{ type: "text", text: PLACEHOLDER },
				],
			}),
		);
		expect(syntheticUser).toEqual({
			role: "user",
			content: [
				{
					type: "file",
					data: {
						type: "data",
						data: "QkFTRTY0SU1BR0VCWVRFUw==",
					},
					mediaType: "image/jpeg",
				},
			],
		});
	});

	it("preserves file metadata when moving non-image file data", () => {
		const prompt = [
			toolMessage({
				type: "content",
				value: [
					{
						type: "file",
						data: { type: "data", data: "QkFTRTY0UERGQllURVM=" },
						mediaType: "application/pdf",
						filename: "spec.pdf",
						providerOptions: { openai: { detail: "high" } },
					},
				],
			}),
		];

		const result = rewritePromptToolImages(prompt);

		expect(result.prompt[1]).toEqual({
			role: "user",
			content: [
				{
					type: "file",
					data: { type: "data", data: "QkFTRTY0UERGQllURVM=" },
					mediaType: "application/pdf",
					filename: "spec.pdf",
					providerOptions: { openai: { detail: "high" } },
				},
			],
		});
	});

	it("moves a remote URL and applies the aggregate media budget", () => {
		const prompt = [
			toolMessage({
				type: "content",
				value: [
					{
						type: "file",
						data: {
							type: "url",
							url: new URL("https://example.com/a.png"),
						},
						mediaType: "image/png",
					},
					{
						type: "file",
						data: {
							type: "url",
							url: new URL("https://example.com/b.png"),
						},
						mediaType: "image/png",
					},
				],
			}),
		];

		const result = rewritePromptToolImages(prompt);

		expect(result.mutated).toBe(true);
		expect(result.prompt).toHaveLength(2);
		expect(result.prompt[1]).toEqual({
			role: "user",
			content: [
				{
					type: "file",
					data: {
						type: "url",
						url: new URL("https://example.com/a.png"),
					},
					mediaType: "image/png",
				},
			],
		});
		expect(JSON.stringify(result.prompt[0])).toContain(OMITTED_PLACEHOLDER);
		expect(JSON.stringify(result.prompt[0])).not.toContain("b.png");
	});

	it("omits malformed data URLs and oversized inline files", () => {
		const malformed = [
			toolMessage({
				type: "content",
				value: [
					{
						type: "file",
						data: {
							type: "url",
							url: new URL("data:image/png;base64,not-base64"),
						},
						mediaType: "image/png",
					},
				],
			}),
		];
		const oversized = [
			toolMessage({
				type: "content",
				value: [
					{
						type: "file",
						data: { type: "data", data: "A".repeat(6 * 1024 * 1024) },
						mediaType: "application/pdf",
					},
				],
			}),
		];

		for (const prompt of [malformed, oversized]) {
			const result = rewritePromptToolImages(prompt);
			expect(result.mutated).toBe(true);
			expect(result.prompt).toHaveLength(1);
			expect(JSON.stringify(result.prompt[0])).toContain(OMITTED_PLACEHOLDER);
		}
	});

	it("leaves provider file references in the tool result", () => {
		const prompt = [
			toolMessage({
				type: "content",
				value: [
					{
						type: "file",
						data: {
							type: "reference",
							reference: { openai: "file_123" },
						},
						mediaType: "image/png",
					},
				],
			}),
		];

		const result = rewritePromptToolImages(prompt);

		expect(result.mutated).toBe(false);
		expect(result.prompt).toEqual(prompt);
	});
});

describe("splitToolImagesMiddleware", () => {
	it("uses the AI SDK 7 V4 middleware contract", async () => {
		const params: LanguageModelV4CallOptions = {
			prompt: [
				toolMessage({
					type: "content",
					value: [
						{
							type: "file",
							data: { type: "data", data: "QkFTRTY0SU1BR0VCWVRFUw==" },
							mediaType: "image/jpeg",
						},
					],
				}),
			],
		};

		const transformed = await splitToolImagesMiddleware.transformParams?.({
			type: "stream",
			params,
			model: {
				specificationVersion: "v4",
				provider: "test",
				modelId: "test",
				supportedUrls: {},
				doGenerate: async () => {
					throw new Error("unused");
				},
				doStream: async () => {
					throw new Error("unused");
				},
			},
		});

		expect(splitToolImagesMiddleware.specificationVersion).toBe("v4");
		expect(transformed?.prompt).toHaveLength(2);
	});
});
