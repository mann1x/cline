/**
 * Whether a failed agent run means its node could not be reached at all.
 *
 * §9i.2. A node that is off, unplugged or behind a dead tunnel costs a connect
 * timeout on every spawn, and with round-robin that is once a lap for the life
 * of the session. Taking it out of the rotation for a cool-off is only safe if
 * "unreachable" is read narrowly, because the cost of reading it too widely is
 * the opposite failure: a node marked down for a cool-off because one model
 * call happened to fail.
 *
 * So the test is transport-level and nothing else. A server that answered --
 * a 429 from an admission gate, a 400 on a bad field, a context overflow, a
 * model that returned an error -- is a server that is alive, and none of them
 * says anything about the node's reachability. Only failures that mean no HTTP
 * response ever arrived count.
 *
 * `fetch failed` is included because that is all undici gives for a connection
 * that never opened; its `cause` carries the real code, which is checked too
 * when it is there.
 */

/** Node codes for "there was nothing at the other end". */
const UNREACHABLE_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

/**
 * `fetch failed` on its own, which undici throws with the cause attached.
 *
 * Deliberately anchored rather than a substring search over the whole message:
 * a model's own output quoting the phrase, or a tool result carried into an
 * error string, must not put a healthy node into a cool-off.
 */
const UNREACHABLE_MESSAGES = [
	/^fetch failed$/i,
	/^(?:network|connection) (?:error|failure)$/i,
	/^terminated$/i,
];

function codeOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export function isNodeUnreachable(error: unknown, depth = 0): boolean {
	// A cause chain is short by nature; the bound is against a cycle, not
	// against depth.
	if (depth > 4 || typeof error !== "object" || error === null) {
		return false;
	}
	const code = codeOf(error);
	if (code && UNREACHABLE_CODES.has(code)) {
		return true;
	}
	const message = (error as { message?: unknown }).message;
	if (
		typeof message === "string" &&
		UNREACHABLE_MESSAGES.some((pattern) => pattern.test(message.trim()))
	) {
		return true;
	}
	const cause = (error as { cause?: unknown }).cause;
	return cause === undefined ? false : isNodeUnreachable(cause, depth + 1);
}

/**
 * The endpoint answered, and it has no such model.
 *
 * Deliberately separate from {@link isNodeUnreachable}, which must stay
 * transport-level: this server is alive and talking, so by that test it is
 * healthy, and it kept taking placements it could not serve. What makes it
 * worth acting on is that unlike a rate limit or a context overflow -- the
 * other things a live server says no with -- nothing about it is transient.
 * Every agent sent there fails identically, having spent nothing:
 *
 *   {"text":"model 'ornith-27b_tb:iq4_xs-128k' not found",
 *    "finishReason":"error","usage":{"inputTokens":0,"outputTokens":0},
 *    "nodeId":"node-mucvow61"}
 *
 * Measured on pandorum 2026-09-22 against a server holding 193 models and not
 * that one. It cost two agents of a five-agent fan-out, plus a third when the
 * lead retried into the same node, and said nothing on screen but an empty
 * report.
 *
 * Matched on the message because that is all the providers agree on -- ollama
 * returns a 404 carrying this text, the OpenAI-compatible families a 404 or
 * 400 with `model_not_found`. The patterns require the word "model" next to
 * the complaint so that a model's own output quoting "not found" cannot take a
 * healthy node out of rotation.
 */
const MODEL_MISSING_MESSAGES = [
	// `model`, then at most the model's own name, then the complaint. The gap
	// admits an identifier and its quotes and nothing else: a window wide
	// enough for a few words of prose matches "the model's weights ... was not
	// found", which is a sentence about a file.
	/\bmodels?\b\s*["'`]?[\w./:+-]*["'`]?[,:]?\s*(?:was |is )?(?:not found|does ?n[o']t exist|is unavailable)/i,
	/\bunknown model\b/i,
	/\bno such model\b/i,
	/\bmodel_not_found\b/i,
];

export function isModelMissing(text: unknown): boolean {
	return (
		typeof text === "string" &&
		MODEL_MISSING_MESSAGES.some((pattern) => pattern.test(text))
	);
}

/**
 * This attempt spent nothing, so the agent may be placed again.
 *
 * The whole point of re-placing rather than failing: a run that never reached
 * a model has done no work to lose and no side effect to repeat. Both halves
 * are required -- a failure that burned tokens may have edited a file, and
 * running it again on another node would do it twice.
 *
 * Note this reads a *returned* result, not a thrown error. The measured
 * failure did not throw: the sub-agent returned `finishReason: "error"` with
 * the message in `text`, so the catch clause that marks nodes down was never
 * entered, and the node stayed in rotation for the rest of the session.
 */
export function isWastedNodeRun(result: {
	finishReason?: unknown;
	text?: unknown;
	usage?: { inputTokens?: number; outputTokens?: number };
}): boolean {
	return (
		result.finishReason === "error" &&
		(result.usage?.inputTokens ?? 0) === 0 &&
		(result.usage?.outputTokens ?? 0) === 0 &&
		isModelMissing(result.text)
	);
}

/**
 * The node's front door answered for a server that is not there.
 *
 * A 502 or 504 is a proxy or tunnel saying the thing behind it did not reply,
 * which is "unreachable" one hop further in. Measured on pandorum 2026-09-23
 * (qjryk): the route to bs2 went when the WAN address changed, and every
 * agent sent to Node1 came back six seconds later as a zero-token run whose
 * text was `Bad Gateway`. The server had answered, so the transport test above
 * kept the node in rotation, and the queue sent the next agent there: 13 lost
 * in two minutes while Node2 had room.
 *
 * Anchored on the whole text, like the transport messages, so that a model's
 * output mentioning a 502 cannot take a node out.
 */
const GATEWAY_DOWN_MESSAGES = [
	/^(?:(?:error:\s*)?(?:502|504)\s*)?bad gateway$/i,
	/^(?:(?:error:\s*)?(?:502|504)\s*)?gateway time-?out$/i,
	/^no healthy upstream$/i,
];

export function isGatewayDown(text: unknown): boolean {
	return (
		typeof text === "string" &&
		GATEWAY_DOWN_MESSAGES.some((pattern) => pattern.test(text.trim()))
	);
}

/** A run that spent nothing because the node's gateway had nothing behind it. */
export function isGatewayDownRun(result: {
	finishReason?: unknown;
	text?: unknown;
	usage?: { inputTokens?: number; outputTokens?: number };
}): boolean {
	return (
		result.finishReason === "error" &&
		(result.usage?.inputTokens ?? 0) === 0 &&
		(result.usage?.outputTokens ?? 0) === 0 &&
		isGatewayDown(result.text)
	);
}
