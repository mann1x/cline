import { describe, expect, it } from "vitest";
import { isGatewayDown, isNodeUnreachable } from "./node-reachability";

/**
 * §9i.2. A node that is off, unplugged or behind a dead tunnel costs a connect
 * timeout on every spawn, and with round-robin that is once a lap for the life
 * of the session. Taking it out of the rotation is only safe if "unreachable"
 * is read narrowly: the opposite failure is a healthy node cooling off because
 * one model call happened to fail.
 */
describe("telling a dead node from a node that answered", () => {
	it("reads a refused connection as unreachable", () => {
		expect(
			isNodeUnreachable(
				Object.assign(new Error("connect ECONNREFUSED 192.168.178.9:11434"), {
					code: "ECONNREFUSED",
				}),
			),
		).toBe(true);
	});

	it("reads an unknown host as unreachable", () => {
		expect(
			isNodeUnreachable(
				Object.assign(new Error("getaddrinfo ENOTFOUND bs2"), {
					code: "ENOTFOUND",
				}),
			),
		).toBe(true);
	});

	// All undici gives for a connection that never opened; the code is on the
	// cause.
	it("follows the cause chain undici hides the code in", () => {
		const error = Object.assign(new Error("fetch failed"), {
			cause: Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			}),
		});

		expect(isNodeUnreachable(error)).toBe(true);
	});

	it("takes a bare fetch failure at its word", () => {
		expect(isNodeUnreachable(new Error("fetch failed"))).toBe(true);
	});

	// Everything below answered, so it says nothing about reachability. Each
	// of these is a normal operating condition on a healthy node, and every
	// one of them would otherwise take a working endpoint out of the rotation.
	it.each([
		["an admission refusal", "Rate limit exceeded, retry after 2s"],
		[
			"a bad field",
			"Field 'repeat_last_n': Value must be between 0 <= value <= 2147483647",
		],
		[
			"a context overflow",
			"input (70000 tokens) is larger than the max context size (65536 tokens)",
		],
		["a model error", "the model produced no output"],
		["an abort", "The spawn was cancelled while waiting."],
	])("does not mark a node down for %s", (_label, message) => {
		expect(isNodeUnreachable(new Error(message))).toBe(false);
	});

	// A model quoting the phrase, or a tool result carried into an error
	// string, must not put a healthy node into a cool-off -- which is why the
	// message patterns are anchored rather than searched for.
	it("is not fooled by an error that merely contains the words", () => {
		expect(
			isNodeUnreachable(
				new Error(
					"The agent reported: fetch failed in the page it was testing",
				),
			),
		).toBe(false);
	});

	it("says nothing about a non-error", () => {
		expect(isNodeUnreachable(undefined)).toBe(false);
		expect(isNodeUnreachable("fetch failed")).toBe(false);
		expect(isNodeUnreachable(null)).toBe(false);
	});

	// A cause chain that points at itself must not hang the spawn it is
	// failing.
	it("survives a cause that points back at itself", () => {
		const error: { message: string; cause?: unknown } = { message: "boom" };
		error.cause = error;

		expect(isNodeUnreachable(error)).toBe(false);
	});
});

describe("isGatewayDown", () => {
	it("reads a proxy's 502 and 504 as nothing behind it", () => {
		for (const text of [
			"Bad Gateway",
			"502 Bad Gateway",
			"Error: 502 Bad Gateway",
			"Gateway Timeout",
			"504 Gateway Time-out",
			"no healthy upstream",
		]) {
			expect(isGatewayDown(text)).toBe(true);
		}
	});

	it("does not read a model's prose about a gateway as one", () => {
		expect(
			isGatewayDown("The server returned a 502 Bad Gateway, so I retried"),
		).toBe(false);
		expect(isGatewayDown("Service Unavailable")).toBe(false);
	});
});
