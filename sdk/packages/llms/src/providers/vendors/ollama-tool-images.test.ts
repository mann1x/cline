import { describe, expect, it } from "vitest";
import {
	mergeOllamaToolImages,
	OLLAMA_SPLIT_IMAGE_PLACEHOLDER,
	rewriteOllamaChatBody,
} from "./ollama-tool-images";

/**
 * The cost of leaving the split in place is not the extra message. Chat
 * templates replay the assistant's own reasoning only from the last user turn
 * onward, so a synthetic user message after every screenshot deletes the
 * model's entire thinking history from the prompt — measured at 105,000
 * characters on one live request — and the model stops thinking a turn later.
 */
function toolMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "tool",
		tool_call_id: "call_1",
		tool_name: "browser",
		content: `{"result":"${OLLAMA_SPLIT_IMAGE_PLACEHOLDER}"}`,
		...overrides,
	};
}

describe("mergeOllamaToolImages", () => {
	it("folds the synthetic image message onto the tool message it follows", () => {
		const { messages, merged } = mergeOllamaToolImages([
			{ role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
			toolMessage(),
			{ role: "user", content: "", images: ["AAAA"] },
		]);

		expect(merged).toBe(1);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			role: "tool",
			tool_call_id: "call_1",
			images: ["AAAA"],
		});
	});

	it("stops the tool result pointing at a message that no longer exists", () => {
		const { messages } = mergeOllamaToolImages([
			toolMessage(),
			{ role: "user", content: "", images: ["AAAA"] },
		]);

		expect(messages[0]).toMatchObject({
			content: expect.not.stringContaining(OLLAMA_SPLIT_IMAGE_PLACEHOLDER),
		});
		expect(messages[0]).toMatchObject({
			content: expect.stringContaining("attached to this tool result"),
		});
	});

	it("leaves a real user turn alone even when it carries an image", () => {
		// A screenshot the user pasted with something to say about it is a turn,
		// and moving it would change what the model was asked.
		const input = [
			toolMessage(),
			{ role: "user", content: "does this look right?", images: ["AAAA"] },
		];

		const { messages, merged } = mergeOllamaToolImages(input);

		expect(merged).toBe(0);
		expect(messages).toEqual(input);
	});

	it("leaves an image message that follows no tool message where it is", () => {
		// Dropping an image is worse than one redundant message, so anything
		// this does not recognise passes through.
		const input = [
			{ role: "assistant", content: "here" },
			{ role: "user", content: "", images: ["AAAA"] },
		];

		const { messages, merged } = mergeOllamaToolImages(input);

		expect(merged).toBe(0);
		expect(messages).toEqual(input);
	});

	it("keeps images the tool message already had", () => {
		const { messages } = mergeOllamaToolImages([
			toolMessage({ images: ["FIRST"] }),
			{ role: "user", content: "", images: ["SECOND"] },
		]);

		expect(messages[0]).toMatchObject({ images: ["FIRST", "SECOND"] });
	});
});

describe("rewriteOllamaChatBody", () => {
	it("reads the model while it has the body parsed", () => {
		const rewritten = rewriteOllamaChatBody(
			JSON.stringify({
				model: "gemma4:vision",
				messages: [
					toolMessage(),
					{ role: "user", content: "", images: ["AAAA"] },
				],
			}),
		);

		expect(rewritten?.model).toBe("gemma4:vision");
		expect(rewritten?.merged).toBe(1);
		expect(JSON.parse(rewritten?.body ?? "{}").messages).toHaveLength(1);
	});

	it("returns the body untouched when there is nothing to fold", () => {
		const body = JSON.stringify({
			model: "gemma4",
			messages: [{ role: "user", content: "hello" }],
		});

		const rewritten = rewriteOllamaChatBody(body);

		expect(rewritten?.merged).toBe(0);
		expect(rewritten?.body).toBe(body);
	});

	it("has no opinion about a body it cannot read", () => {
		expect(rewriteOllamaChatBody("not json")).toBeUndefined();
		expect(rewriteOllamaChatBody(undefined)).toBeUndefined();
		expect(
			rewriteOllamaChatBody(JSON.stringify({ prompt: "x" })),
		).toBeUndefined();
	});
});

// Under `text` a result carrying an image is a `content` output, and the
// converter writes its text parts as `JSON.stringify` of the parts: the escapes
// the format exists to remove, on exactly the results that have images.
describe("rewriteOllamaChatBody under a text tool result format", () => {
	const rendered = '/abs/shot.png\n→ Successfully read image "shot"';
	const body = JSON.stringify({
		model: "m",
		messages: [
			{ role: "user", content: "look" },
			{
				role: "tool",
				tool_call_id: "c1",
				tool_name: "read_files",
				content: JSON.stringify([{ type: "text", text: rendered }]),
				images: ["aGk="],
			},
			{
				role: "tool",
				tool_call_id: "c2",
				tool_name: "run_commands",
				content: JSON.stringify([{ type: "text", text: "printed by a tool" }]),
			},
		],
	});

	it("gives an image-carrying tool message its text back", () => {
		const out = rewriteOllamaChatBody(body, { toolResultText: true });
		const messages = JSON.parse(out?.body ?? "{}").messages;
		expect(out?.joined).toBe(1);
		expect(messages[1].content).toBe(rendered);
		expect(messages[1].images).toEqual(["aGk="]);
		// No images: not a `content` output, so what the tool returned.
		expect(messages[2].content).toBe(
			JSON.stringify([{ type: "text", text: "printed by a tool" }]),
		);
	});

	it("sends a json session's body exactly as it was", () => {
		expect(rewriteOllamaChatBody(body)?.body).toBe(body);
		expect(rewriteOllamaChatBody(body, { toolResultText: false })?.body).toBe(
			body,
		);
	});
});
