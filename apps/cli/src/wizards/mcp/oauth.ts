import * as p from "@clack/prompts";
import {
	authorizeMcpServerOAuth,
	resolveDefaultMcpSettingsPath,
	signOutMcpServerOAuth,
} from "@cline/core";
import open from "../../utils/open";

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0) {
			return message;
		}
	}
	return String(error);
}

/**
 * Asks the provider for its account chooser, as the plugin's "Use another
 * account" does: without it the browser signs in with its existing session.
 */
const SWITCH_ACCOUNT_PROMPT = "select_account";

export async function authorizeMcpServerOAuthWithBrowser(
	name: string,
	options: { throwOnError?: boolean; switchAccount?: boolean } = {},
): Promise<void> {
	p.log.info("Opening browser for MCP OAuth authorization");
	try {
		const result = await authorizeMcpServerOAuth({
			serverName: name,
			filePath: resolveDefaultMcpSettingsPath(),
			// Stored tokens that still work would otherwise answer for the
			// flow, and the account could never change.
			...(options.switchAccount
				? { reauthorize: true, prompt: SWITCH_ACCOUNT_PROMPT }
				: {}),
			openUrl: async (url) => {
				p.log.message(`Authorization URL: ${url}`);
				await open(url, { wait: false });
			},
			onServerListening: (info) => {
				p.log.message(`Waiting for OAuth callback at ${info.callbackUrl}`);
			},
		});
		p.log.success(result.message);
	} catch (error) {
		if (options.throwOnError === true) {
			throw error instanceof Error ? error : new Error(toErrorMessage(error));
		}
		p.log.error(`OAuth authorization failed: ${toErrorMessage(error)}`);
		p.log.warn(
			`Server "${name}" is still saved. Choose "Authorize OAuth" to retry.`,
		);
	}
}

/** Revokes a server's OAuth tokens where it supports that, and forgets them. */
export async function signOutMcpServerOAuthInteractive(
	name: string,
): Promise<void> {
	const result = await signOutMcpServerOAuth({
		serverName: name,
		filePath: resolveDefaultMcpSettingsPath(),
	});
	if (!result.hadTokens) {
		p.log.info(`Server "${name}" was not signed in.`);
	} else if (result.revoked) {
		p.log.success(`Signed out of "${name}".`);
	} else {
		p.log.success(
			`Signed out of "${name}". The server could not be asked to revoke the sign-in, so it lasts on its side until it expires.`,
		);
	}
}
