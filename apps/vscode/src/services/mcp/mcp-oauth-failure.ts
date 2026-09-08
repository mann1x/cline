/**
 * What went wrong in the OAuth handshake, named.
 *
 * A connection to an OAuth-protected MCP server makes several requests before
 * it makes the one the user asked for: protected-resource metadata,
 * authorization-server metadata, sometimes a dynamic client registration, then
 * a token exchange. When one of those fails the MCP SDK surfaces whatever the
 * server sent, which for a plain-text body is a JSON parse error --
 *
 *   HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F',
 *   "Forbidden" is not valid JSON. Raw body: Forbidden
 *
 * -- naming neither which request failed nor what to do about it. Reported
 * twice on mann1x/cline#63, and both times the first guess about which
 * endpoint answered was a guess. This watches the fetch the transport already
 * uses so the answer is recorded rather than inferred.
 */

/** The registration POST is the only request in the flow carrying redirect_uris in a JSON body. */
const CLIENT_REGISTRATION_BODY_MARKER = '"redirect_uris"'

export interface McpOAuthRequestFailure {
	/** The endpoint that answered, without its query string. */
	url: string
	status: number
	/** Whether this was the dynamic client registration request. */
	registration: boolean
}

export interface WatchedMcpFetch {
	fetch: typeof fetch
	/** The most recent failed request in the OAuth handshake, if any. */
	lastFailure(): McpOAuthRequestFailure | undefined
}

function withoutQuery(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.origin}${parsed.pathname}`
	} catch {
		return url
	}
}

/**
 * Wrap a fetch so failures in the OAuth handshake are remembered.
 *
 * `resourceUrl` is the MCP endpoint itself. Requests to it are the ones the
 * user asked for, and its 401 is the normal opening move of the whole flow --
 * it is how the server says "authenticate first" -- so it is never recorded as
 * a failure. Everything else on the way is handshake.
 */
export function watchMcpOAuthFetch(resourceUrl: string, baseFetch: typeof fetch = fetch): WatchedMcpFetch {
	const resource = withoutQuery(resourceUrl)
	let failure: McpOAuthRequestFailure | undefined

	const watched = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const response = await baseFetch(input as never, init as never)
		const url = withoutQuery(
			typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url,
		)
		if (!response.ok && url !== resource) {
			failure = {
				url,
				status: response.status,
				registration: typeof init?.body === "string" && init.body.includes(CLIENT_REGISTRATION_BODY_MARKER),
			}
		}
		return response
	}) as typeof fetch

	return { fetch: watched, lastFailure: () => failure }
}

/**
 * What to tell the user about a handshake that did not complete.
 *
 * A refused registration is the case worth naming outright: the server will
 * only talk to clients it issued itself, so no credential of the user's was
 * ever sent and checking their credentials -- the obvious first move on a 403
 * -- cannot help.
 *
 * It also names the button rather than the settings file. Measured against
 * Figma's server, the one this was reported on: it advertises a registration
 * endpoint and answers every anonymous registration with a bare `403
 * Forbidden` -- any body, any client name, with or without credentials -- so
 * the client the user creates themselves is not a workaround, it is the only
 * way this server is ever reached. Telling them to hand-edit a JSON file for
 * that is telling them to give up.
 */
export function describeMcpOAuthFailure(serverName: string, failure: McpOAuthRequestFailure): string {
	if (failure.registration) {
		return (
			`MCP server "${serverName}" refused to register Cline as an OAuth client (HTTP ${failure.status} from ${failure.url}). ` +
			"This server only accepts clients it issued itself, so no credentials were sent and this will not start working on its own. " +
			'Register Cline in the provider\'s own developer settings, then use "Use an OAuth client I already have" below to paste the client ID it gave you.'
		)
	}
	return (
		`MCP server "${serverName}" could not complete OAuth: HTTP ${failure.status} from ${failure.url}. ` +
		"Authenticate to try the full sign-in flow, or check that endpoint's requirements."
	)
}
