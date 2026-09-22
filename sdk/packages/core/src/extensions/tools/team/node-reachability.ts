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
