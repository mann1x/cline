import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	authorizeMcpServerOAuth,
	createMcpOAuthProviderContext,
	signOutMcpServerOAuth,
	withAuthorizationPrompt,
} from "./oauth";

// A server signed in with the wrong account must be replaceable: its tokens
// still work, so without these the only way out was to wait for them to expire.

const SERVER_URL = "https://mcp.example.test/mcp";
const AUTH_SERVER = "https://auth.example.test";

describe("mcp oauth: changing the signed-in account", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
		);
		tempRoots.length = 0;
	});

	async function settingsWith(oauth: Record<string, unknown>): Promise<string> {
		const tempRoot = await mkdtemp(join(tmpdir(), "core-mcp-oauth-account-"));
		tempRoots.push(tempRoot);
		const filePath = join(tempRoot, "cline_mcp_settings.json");
		await writeFile(
			filePath,
			JSON.stringify({
				mcpServers: {
					docs: {
						transport: { type: "streamableHttp", url: SERVER_URL },
						oauth,
					},
				},
			}),
			"utf8",
		);
		return filePath;
	}

	async function oauthState(
		filePath: string,
	): Promise<Record<string, unknown>> {
		const settings = JSON.parse(await readFile(filePath, "utf8"));
		return settings.mcpServers.docs.oauth ?? {};
	}

	const signedIn = {
		clientInformation: { client_id: "registered-client" },
		tokens: {
			access_token: "account-a-access",
			refresh_token: "account-a-refresh",
			token_type: "bearer",
		},
		discoveryState: {
			authorizationServerUrl: AUTH_SERVER,
			authorizationServerMetadata: {
				issuer: AUTH_SERVER,
				authorization_endpoint: `${AUTH_SERVER}/authorize`,
				token_endpoint: `${AUTH_SERVER}/token`,
				revocation_endpoint: `${AUTH_SERVER}/revoke`,
				response_types_supported: ["code"],
			},
		},
		lastAuthenticatedAt: 1,
	};

	/**
	 * An MCP server that accepts account A's access token and answers 401
	 * otherwise, with the discovery documents an OAuth client needs.
	 */
	function fakeServer() {
		const calls: string[] = [];
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			calls.push(`${init?.method ?? "GET"} ${url}`);
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (url.includes("/.well-known/oauth-protected-resource")) {
				return json({
					resource: SERVER_URL,
					authorization_servers: [AUTH_SERVER],
				});
			}
			if (url.includes("/.well-known/oauth-authorization-server")) {
				return json(signedIn.discoveryState.authorizationServerMetadata);
			}
			if (url.startsWith(SERVER_URL)) {
				const auth = new Headers(init?.headers).get("authorization");
				if (auth !== "Bearer account-a-access") {
					return new Response(null, {
						status: 401,
						headers: {
							"www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
						},
					});
				}
				const message = JSON.parse(String(init?.body ?? "{}"));
				if (message.id === undefined) {
					return new Response(null, { status: 202 });
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: message.params.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "docs", version: "1" },
							}
						: { tools: [] };
				return json({ jsonrpc: "2.0", id: message.id, result });
			}
			return new Response("not found", { status: 404 });
		};
		return { fetch, calls };
	}

	function callbackPort(): number {
		return 20000 + Math.floor(Math.random() * 20000);
	}

	it("answers 'already authorized' from working tokens without opening a browser", async () => {
		const filePath = await settingsWith(signedIn);
		const opened: string[] = [];
		const result = await authorizeMcpServerOAuth({
			serverName: "docs",
			filePath,
			fetch: fakeServer().fetch,
			openUrl: (url) => {
				opened.push(url);
			},
			callbackPorts: [callbackPort()],
		});
		expect(result.message).toContain("already authorized");
		expect(opened).toEqual([]);
	});

	it("opens the sign-in with an account chooser when asked to reauthorize", async () => {
		const filePath = await settingsWith(signedIn);
		const controller = new AbortController();
		const opened: string[] = [];
		const run = authorizeMcpServerOAuth({
			serverName: "docs",
			filePath,
			fetch: fakeServer().fetch,
			openUrl: (url) => {
				opened.push(url);
				controller.abort();
			},
			callbackPorts: [callbackPort()],
			reauthorize: true,
			prompt: "select_account",
			signal: controller.signal,
		});
		await expect(run).rejects.toThrow(/cancelled/);
		expect(opened).toHaveLength(1);
		const url = new URL(opened[0] as string);
		expect(url.origin + url.pathname).toBe(`${AUTH_SERVER}/authorize`);
		expect(url.searchParams.get("prompt")).toBe("select_account");
		expect(url.searchParams.get("client_id")).toBe("registered-client");
		const state = await oauthState(filePath);
		expect(state.tokens).toBeUndefined();
		expect(state.clientInformation).toEqual({ client_id: "registered-client" });
	});

	it("forgets tokens and keeps the client when the interactive state is reset with forgetTokens", async () => {
		const filePath = await settingsWith(signedIn);
		const context = createMcpOAuthProviderContext({
			settingsPath: filePath,
			serverName: "docs",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
		});
		await context.resetInteractiveState({ forgetTokens: true });
		const state = await oauthState(filePath);
		expect(state.tokens).toBeUndefined();
		expect(state.lastAuthenticatedAt).toBeUndefined();
		expect(state.clientInformation).toEqual({ client_id: "registered-client" });
	});

	it("keeps tokens on a plain reset", async () => {
		const filePath = await settingsWith(signedIn);
		const context = createMcpOAuthProviderContext({
			settingsPath: filePath,
			serverName: "docs",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
		});
		await context.resetInteractiveState();
		expect((await oauthState(filePath)).tokens).toEqual(signedIn.tokens);
	});

	it("signs out: revokes the refresh token, then the access token, and forgets both", async () => {
		const filePath = await settingsWith(signedIn);
		const revocations: Array<{
			token: string | null;
			hint: string | null;
			clientId: string | null;
		}> = [];
		const result = await signOutMcpServerOAuth({
			serverName: "docs",
			filePath,
			fetch: async (input, init) => {
				expect(input.toString()).toBe(`${AUTH_SERVER}/revoke`);
				const body = new URLSearchParams(String(init?.body));
				revocations.push({
					token: body.get("token"),
					hint: body.get("token_type_hint"),
					clientId: body.get("client_id"),
				});
				return new Response(null, { status: 200 });
			},
		});
		expect(result).toEqual({
			serverName: "docs",
			hadTokens: true,
			revoked: true,
		});
		expect(revocations).toEqual([
			{
				token: "account-a-refresh",
				hint: "refresh_token",
				clientId: "registered-client",
			},
			{
				token: "account-a-access",
				hint: "access_token",
				clientId: "registered-client",
			},
		]);
		const state = await oauthState(filePath);
		expect(state.tokens).toBeUndefined();
		expect(state.lastAuthenticatedAt).toBeUndefined();
		expect(state.authorizationRequired).toBe(true);
		expect(state.clientInformation).toEqual({ client_id: "registered-client" });
	});

	it("forgets the tokens when revocation cannot be reached", async () => {
		const filePath = await settingsWith(signedIn);
		const result = await signOutMcpServerOAuth({
			serverName: "docs",
			filePath,
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(result.revoked).toBe(false);
		expect((await oauthState(filePath)).tokens).toBeUndefined();
	});

	it("forgets the tokens when the server advertises no revocation endpoint", async () => {
		const filePath = await settingsWith({
			...signedIn,
			discoveryState: undefined,
		});
		let called = false;
		const result = await signOutMcpServerOAuth({
			serverName: "docs",
			filePath,
			fetch: async () => {
				called = true;
				return new Response(null, { status: 200 });
			},
		});
		expect(called).toBe(false);
		expect(result).toEqual({
			serverName: "docs",
			hadTokens: true,
			revoked: false,
		});
		expect((await oauthState(filePath)).tokens).toBeUndefined();
	});

	it("adds or replaces the prompt on an authorization URL, and leaves it alone without one", () => {
		const url = `${AUTH_SERVER}/authorize?client_id=c&prompt=consent`;
		expect(
			new URL(withAuthorizationPrompt(url, "select_account")).searchParams.get(
				"prompt",
			),
		).toBe("select_account");
		expect(withAuthorizationPrompt(url)).toBe(url);
		expect(withAuthorizationPrompt(url, "  ")).toBe(url);
	});
});
