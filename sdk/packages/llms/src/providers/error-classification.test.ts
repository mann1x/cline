import {
	APICallError,
	NoOutputGeneratedError,
	RetryError,
	TypeValidationError,
} from "ai";
import { describe, expect, it } from "vitest";
import { classifyProviderError } from "./error-classification";

describe("classifyProviderError", () => {
	describe("context_window_exceeded", () => {
		it("classifies the gateway-forwarded Alibaba Qwen rejection (captured shape)", () => {
			// Same payload format.test.ts verifies extractErrorMessage against.
			expect(
				classifyProviderError({
					code: "error",
					message: "Stream error occurred",
					name: "AI_TypeValidationError",
					cause: {
						name: "ZodError",
						message:
							'[\n  {\n    "code": "invalid_union",\n    "path": [],\n    "message": "Invalid input"\n  }\n]',
					},
					value: {
						error_type: "validation_error",
						error_message: JSON.stringify({
							error: {
								message:
									"This model's maximum context length is 40960 tokens. However, you requested 100 output tokens and your prompt contains at least 40861 input tokens.",
								code: 400,
							},
						}),
					},
				}),
			).toBe("context_window_exceeded");
		});

		it("classifies an AI SDK APICallError-shaped 400 with context detail in responseBody", () => {
			const error = Object.assign(new Error("Bad Request"), {
				name: "AI_APICallError",
				statusCode: 400,
				responseBody: JSON.stringify({
					error: {
						message:
							"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
						type: "invalid_request_error",
						code: "context_length_exceeded",
					},
				}),
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});

		it("classifies by explicit context_length_exceeded code alone", () => {
			expect(
				classifyProviderError({
					error: { code: "context_length_exceeded" },
				}),
			).toBe("context_window_exceeded");
		});

		it("classifies Anthropic prompt-too-long rejections", () => {
			expect(
				classifyProviderError({
					status: 400,
					error: {
						type: "invalid_request_error",
						message: "prompt is too long: 213462 tokens > 200000 maximum",
					},
				}),
			).toBe("context_window_exceeded");
		});

		it("classifies Bedrock input-too-long validation errors", () => {
			const error = Object.assign(new Error("Bad Request"), {
				name: "AI_APICallError",
				statusCode: 400,
				responseBody: JSON.stringify({
					message: "Input is too long for requested model.",
				}),
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});

		it("classifies Cerebras reduce-the-length rejections", () => {
			expect(
				classifyProviderError({
					statusCode: 400,
					message: "Please reduce the length of the messages or completion.",
				}),
			).toBe("context_window_exceeded");
		});

		it("classifies OpenRouter errors JSON-encoded into the message string", () => {
			expect(
				classifyProviderError(
					new Error(
						'Provider returned error: {"error":{"message":"This endpoint\'s maximum context length is 65536 tokens.","code":400}}',
					),
				),
			).toBe("context_window_exceeded");
		});

		it("classifies an already-flattened message string", () => {
			expect(
				classifyProviderError(
					"input length and max_tokens exceed context limit: 199999 + 8192 > 200000",
				),
			).toBe("context_window_exceeded");
		});
	});

	describe("auth", () => {
		it("classifies a structural 401 payload", () => {
			expect(
				classifyProviderError({
					statusCode: 401,
					message: "invalid x-api-key",
				}),
			).toBe("auth");
		});

		it("classifies a structural 403 payload", () => {
			expect(classifyProviderError({ status: 403, message: "Forbidden" })).toBe(
				"auth",
			);
		});

		it("classifies a typed APICallError 401 (Mistral invalid-key shape)", () => {
			expect(
				classifyProviderError(
					new APICallError({
						message: "Invalid API Key",
						url: "https://api.mistral.ai/v1/chat/completions",
						requestBodyValues: {},
						statusCode: 401,
						responseBody: JSON.stringify({ detail: "Invalid API Key" }),
					}),
				),
			).toBe("auth");
		});

		it("treats the typed statusCode as authoritative: 401 wins over context wording", () => {
			expect(
				classifyProviderError(
					new APICallError({
						message: "Unauthorized",
						url: "https://api.example.com/v1/chat/completions",
						requestBodyValues: {},
						statusCode: 401,
						responseBody: JSON.stringify({
							error: { message: "context length exceeded" },
						}),
					}),
				),
			).toBe("auth");
		});

		it("unwraps a RetryError whose final attempt was a 401", () => {
			const last = new APICallError({
				message: "Unauthorized",
				url: "https://api.example.com/v1/chat/completions",
				requestBodyValues: {},
				statusCode: 401,
				responseBody: JSON.stringify({ detail: "Invalid API Key" }),
			});
			expect(
				classifyProviderError(
					new RetryError({
						message: "Failed after 2 attempts",
						reason: "errorNotRetryable",
						errors: [last],
					}),
				),
			).toBe("auth");
		});
	});

	describe("unknown", () => {
		// These two used to assert `unknown`. The veto they exist for -- a quota
		// message that says "tokens exceeded" must never be read as the context
		// window overflowing -- is unchanged; what changed is that the right
		// answer has a name now, so a caller can wait instead of giving up.
		it("vetoes token-per-minute rate limits despite token wording", () => {
			expect(
				classifyProviderError({
					status: 429,
					error: {
						type: "rate_limit_error",
						message:
							"Number of request tokens has exceeded your per-minute rate limit.",
					},
				}),
			).toBe("rate_limited");
		});

		it("vetoes rate-limit wording even without a status", () => {
			expect(
				classifyProviderError(
					new Error("Rate limit reached for gpt-4o on tokens per min (TPM)"),
				),
			).toBe("rate_limited");
		});

		it("vetoes context wording on a non-invalid-request status", () => {
			expect(
				classifyProviderError({
					statusCode: 500,
					message: "internal error computing context length",
				}),
			).toBe("unknown");
		});

		it("leaves auth wording without an HTTP status unclassified", () => {
			// Status-only policy: provider bodies can quote "unauthorized"
			// without the request having been an auth failure.
			expect(
				classifyProviderError(new Error("Unauthorized: check your key")),
			).toBe("unknown");
		});

		it("leaves generic stream failures unclassified", () => {
			expect(
				classifyProviderError(new Error("fetch failed: other side closed")),
			).toBe("unknown");
		});

		it("handles null, primitives, and empty objects", () => {
			expect(classifyProviderError(null)).toBe("unknown");
			expect(classifyProviderError(undefined)).toBe("unknown");
			expect(classifyProviderError(42)).toBe("unknown");
			expect(classifyProviderError({})).toBe("unknown");
		});

		it("survives self-referential error objects", () => {
			const cyclic: Record<string, unknown> = { message: "boom" };
			cyclic.cause = cyclic;
			expect(classifyProviderError(cyclic)).toBe("unknown");
		});
	});

	describe("typed AI SDK error instances", () => {
		const overflowApiCallError = () =>
			new APICallError({
				message: "Bad Request",
				url: "https://api.anthropic.com/v1/messages",
				requestBodyValues: {},
				statusCode: 400,
				responseBody: JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "prompt is too long: 213462 tokens > 200000 maximum",
					},
				}),
			});

		it("classifies an APICallError 400 with a prompt-too-long body", () => {
			expect(classifyProviderError(overflowApiCallError())).toBe(
				"context_window_exceeded",
			);
		});

		it("treats the typed statusCode as authoritative: 429 vetoes token wording", () => {
			const error = new APICallError({
				message: "Too Many Requests",
				url: "https://api.anthropic.com/v1/messages",
				requestBodyValues: {},
				statusCode: 429,
				responseBody: JSON.stringify({
					error: {
						message: "Request tokens exceed your available quota.",
					},
				}),
			});
			expect(classifyProviderError(error)).toBe("unknown");
		});

		it("treats the typed statusCode as authoritative: 500 vetoes context wording", () => {
			const error = new APICallError({
				message: "Internal Server Error",
				url: "https://api.openai.com/v1/chat/completions",
				requestBodyValues: {},
				statusCode: 500,
				responseBody: JSON.stringify({
					error: {
						message: "internal error computing maximum context length",
					},
				}),
			});
			expect(classifyProviderError(error)).toBe("unknown");
		});

		it("treats the typed statusCode as authoritative: an explicit overflow code cannot override it", () => {
			const withStatus = (statusCode: number) =>
				new APICallError({
					message: "Request failed",
					url: "https://api.openai.com/v1/chat/completions",
					requestBodyValues: {},
					statusCode,
					responseBody: JSON.stringify({
						error: {
							message: "This model's maximum context length is 128000 tokens.",
							code: "context_length_exceeded",
						},
					}),
				});
			expect(classifyProviderError(withStatus(429))).toBe("unknown");
			expect(classifyProviderError(withStatus(500))).toBe("unknown");
			// The gate must not swallow genuine overflow rejections.
			expect(classifyProviderError(withStatus(400))).toBe(
				"context_window_exceeded",
			);
		});

		it("unwraps a RetryError to its last attempt's error", () => {
			const error = new RetryError({
				message: "Failed after 3 attempts.",
				reason: "maxRetriesExceeded",
				errors: [new Error("fetch failed"), overflowApiCallError()],
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});

		it("classifies an untyped final RetryError attempt without earlier attempts vetoing it", () => {
			// Attempt 1 was a retryable 429; the final attempt is a plain
			// (untyped) overflow rejection. The earlier rate limit must not
			// veto the final attempt's verdict.
			const error = new RetryError({
				message: "Failed after 2 attempts.",
				reason: "errorNotRetryable",
				errors: [
					new APICallError({
						message: "Too Many Requests",
						url: "https://api.anthropic.com/v1/messages",
						requestBodyValues: {},
						statusCode: 429,
						responseBody: JSON.stringify({
							error: {
								type: "rate_limit_error",
								message: "Rate limit reached.",
							},
						}),
					}),
					{
						status: 400,
						error: {
							type: "invalid_request_error",
							message: "prompt is too long: 213462 tokens > 200000 maximum",
						},
					},
				],
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});

		it("does not let earlier RetryError attempts fake an overflow for an untyped final attempt", () => {
			const error = new RetryError({
				message: "Failed after 2 attempts.",
				reason: "errorNotRetryable",
				errors: [
					{
						status: 400,
						error: {
							message: "prompt is too long: 213462 tokens > 200000 maximum",
						},
					},
					new Error("fetch failed: other side closed"),
				],
			});
			expect(classifyProviderError(error)).toBe("unknown");
		});

		it("classifies a TypeValidationError by the gateway payload in value", () => {
			// A real instance of the ENG-2394 failure: the Vercel gateway streams
			// the upstream rejection as the value that failed schema validation.
			const error = new TypeValidationError({
				value: {
					error_type: "validation_error",
					error_message: JSON.stringify({
						error: {
							message:
								"This model's maximum context length is 40960 tokens. However, you requested 100 output tokens and your prompt contains at least 40861 input tokens.",
							code: 400,
						},
					}),
				},
				cause: Object.assign(
					new Error(
						'[\n  {\n    "code": "invalid_union",\n    "path": [],\n    "message": "Invalid input"\n  }\n]',
					),
					{ name: "ZodError" },
				),
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});

		it("recurses through a generic AISDKError wrapper's cause", () => {
			const error = new NoOutputGeneratedError({
				message: "No output generated.",
				cause: overflowApiCallError(),
			});
			expect(classifyProviderError(error)).toBe("context_window_exceeded");
		});
	});
});

describe("image input refusals", () => {
	// Measured: a tester ran DeepSeek on Ollama Cloud, the browser tool attached
	// a screenshot, and the session ended on this error.
	it.each([
		"this model does not support image input",
		"The model doesn't support images",
		"vision input is not supported for this model",
		"model is not multimodal",
		"no support for image content",
	])("classifies %j as recoverable", (message) => {
		expect(classifyProviderError(new Error(message))).toBe(
			"image_input_unsupported",
		);
	});

	// The patterns must never swallow a generic failure — dropping images from
	// the transcript and retrying would be the wrong move for any of these.
	it.each([
		"Bad request",
		"invalid image format: expected png",
		"rate limit exceeded",
		"the image was too large",
	])("leaves %j alone", (message) => {
		expect(classifyProviderError(new Error(message))).not.toBe(
			"image_input_unsupported",
		);
	});
});

describe("tool calls the provider could not parse", () => {
	// The first of these is verbatim from the transaction that died on it, at
	// 3,449s of a 7,200s budget with the file already carried past its syntax
	// error: Go's encoding/xml, inside Ollama's Qwen tool-call parser.
	it.each([
		"XML syntax error on line 12: element <parameter> closed by </function>",
		"failed to parse tool call arguments",
		"could not parse the function call",
		"invalid tool_call in response",
		"malformed function arguments",
		// llama.cpp's streaming parser, verbatim from a swarm worker it ended
		// (the "Previous" dump runs on for kilobytes of the call's arguments).
		"Invalid diff: now finding less tool calls!\n  Previous (1):\n    - name: 'editor', args: '{\"new_text\":\"    dIt(c,x){this.it.forEach(it=>{",
	])("classifies %j as recoverable", (message) => {
		expect(classifyProviderError(new Error(message))).toBe(
			"tool_call_unparsable",
		);
	});

	// Asking a model to resend a call it never made spends a turn and, worse,
	// spends it while the real failure goes unreported. Each of these is a
	// complaint about the request or the transport rather than about something
	// the model emitted.
	it.each([
		"Bad request",
		"XML syntax error on line 3: unexpected EOF",
		"failed to parse response body",
		"invalid JSON in request",
		"rate limit exceeded",
		// Same parser, a content diff rather than a tool call: nothing was
		// asked of a tool, so there is no call to ask for again.
		"Invalid diff: 'abc' not found at start of 'xyz'",
	])("leaves %j alone", (message) => {
		expect(classifyProviderError(new Error(message))).not.toBe(
			"tool_call_unparsable",
		);
	});
});

describe("opencoti's own refusals", () => {
	// Verbatim from the engine (`server-context.cpp:9184-9190`,
	// `server-common.cpp:49`). None of the existing patterns match "max context
	// size", so this classified as `unknown`, `isRecoverableOverflowTurn` never
	// fired, and overflow-recovery compaction never ran on this provider at all:
	// a run that outgrew its window died instead of compacting.
	it("reads an overflow as an overflow", () => {
		expect(
			classifyProviderError({
				statusCode: 400,
				responseBody: JSON.stringify({
					error: {
						code: 400,
						type: "exceed_context_size_error",
						message:
							"input (13000 tokens) is larger than the max context size (8192 tokens). skipping",
					},
				}),
			}),
		).toBe("context_window_exceeded");
	});

	it("reads the other overflow message too", () => {
		expect(
			classifyProviderError({
				statusCode: 400,
				responseBody: JSON.stringify({
					error: {
						code: 400,
						type: "exceed_context_size_error",
						message:
							"request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it",
					},
				}),
			}),
		).toBe("context_window_exceeded");
	});

	// The admission gate is `enforced` by default, so this is a normal operating
	// condition on any busy server -- and as `unknown` it was indistinguishable
	// from a bug, so the subagent died instead of waiting the stated interval.
	it("reads an admission refusal as rate limiting, not as a mystery", () => {
		expect(
			classifyProviderError({
				statusCode: 429,
				responseBody: JSON.stringify({
					error: {
						code: 429,
						type: "rate_limit_error",
						message: "pool saturated",
					},
				}),
			}),
		).toBe("rate_limited");
	});

	// c7 is the published release and its body disagrees with its own status
	// line: the refusal is a 429 carrying a body that says 503. Classifying on
	// the body would mis-read every refusal on the binary people actually run.
	it("trusts the status over a c7 body that says 503", () => {
		expect(
			classifyProviderError({
				statusCode: 429,
				responseBody: JSON.stringify({
					error: {
						code: 503,
						type: "unavailable_error",
						message: "pool saturated; retry later",
					},
				}),
			}),
		).toBe("rate_limited");
	});

	// A fork whose child prefix does not match the parent token-exact. Not
	// retryable and not the turn's fault: the pool is wrong and must be rebuilt.
	it("tells a broken pool contract from a broken request", () => {
		expect(
			classifyProviderError({
				statusCode: 400,
				responseBody: JSON.stringify({
					error: {
						code: 400,
						type: "invalid_request_error",
						message:
							"contiguous-prefix contract violation at 12859: child does not match parent",
					},
				}),
			}),
		).toBe("pool_contract_violation");
	});

	// Every rejection the engine's fork handler can send, transcribed from it.
	// Only two of the six name the contract; the other four describe the same
	// broken relationship in their own words, and all six mean "re-create the
	// pool", not "fail the turn". The one measured live on the c7 binary from a
	// suffix-shaped fork was `child prefix shorter than branch_pos` -- which the
	// first version of this pattern did not match.
	it.each([
		["branch_pos exceeds parent prefix_len"],
		[
			"hybrid/recurrent fork must extend at branch_pos == parent prefix_len (bug-2203)",
		],
		["session context shorter than branch_pos"],
		[
			"contiguous-prefix contract violation: session tokens [0, branch_pos) do not match the parent — re-root or full-prefill",
		],
		["child prefix shorter than branch_pos"],
		[
			"contiguous-prefix contract violation: tokens [0, branch_pos) do not match the parent — re-root or full-prefill",
		],
	])("recognises the engine's own wording: %s", (message) => {
		expect(
			classifyProviderError({
				statusCode: 400,
				responseBody: JSON.stringify({
					error: { code: 400, type: "invalid_request_error", message },
				}),
			}),
		).toBe("pool_contract_violation");
	});
});
