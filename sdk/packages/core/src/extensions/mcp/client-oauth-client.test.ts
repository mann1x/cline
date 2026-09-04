import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
	authProviders: [] as (OAuthClientProvider | undefined)[],
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(_url: URL, options: { authProvider?: OAuthClientProvider }) {
			transportState.authProviders.push(options?.authProvider);
		}
		async close(): Promise<void> {}
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		async connect(): Promise<void> {}
		async close(): Promise<void> {}
	},
}));

import { createDefaultMcpServerClientFactory } from "./client";
import type { McpServerRegistration } from "./types";

// A pre-registered client has to reach the *runtime* connection, not only the
// interactive authorize. The SDK skips registration whenever clientInformation()
// answers, so it never calls saveClientInformation and nothing persists the
// client. If connect built its provider context without it, the reconnect that
// refreshes a token would fall back to dynamic client registration -- the one
// thing a server like Figma or Slack refuses.
describe("mcp client pre-registered OAuth client", () => {
	const tempRoots: string[] = [];
	const url = "https://mcp.figma.example/mcp";

	afterEach(async () => {
		transportState.authProviders.length = 0;
		await Promise.all(
			tempRoots.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
		);
		tempRoots.length = 0;
	});

	// The state a server is in after a successful authorize: tokens, plus the
	// client they were issued to. tokens() only answers when the persisted client
	// matches the configured one, so both have to be present for a reconnect to
	// attach a provider at all.
	async function settingsFile(options: {
		oauthClient?: McpServerRegistration["oauthClient"];
		clientInformation?: Record<string, unknown>;
	}): Promise<string> {
		const tempRoot = await mkdtemp(join(tmpdir(), "core-mcp-client-oauth-"));
		tempRoots.push(tempRoot);
		const filePath = join(tempRoot, "cline_mcp_settings.json");
		await writeFile(
			filePath,
			JSON.stringify({
				mcpServers: {
					figma: {
						transport: { type: "streamableHttp", url },
						...(options.oauthClient
							? { oauthClient: options.oauthClient }
							: {}),
						...(options.clientInformation
							? {
									oauth: {
										clientInformation: options.clientInformation,
										tokens: {
											access_token: "seeded",
											token_type: "Bearer",
										},
									},
								}
							: {}),
					},
				},
			}),
			"utf8",
		);
		return filePath;
	}

	function registration(
		oauthClient?: McpServerRegistration["oauthClient"],
	): McpServerRegistration {
		return {
			name: "figma",
			transport: { type: "streamableHttp", url },
			...(oauthClient ? { oauthClient } : {}),
		};
	}

	async function connect(settingsPath: string, reg: McpServerRegistration) {
		const factory = createDefaultMcpServerClientFactory({ settingsPath });
		const client = await factory(reg);
		await client.connect();
	}

	it("hands the configured client to a reconnecting transport", async () => {
		const oauthClient = { clientId: "pre-registered", clientSecret: "shh" };
		const settingsPath = await settingsFile({
			oauthClient,
			clientInformation: {
				client_id: "pre-registered",
				client_secret: "shh",
			},
		});

		await connect(settingsPath, registration(oauthClient));

		expect(transportState.authProviders[0]).toBeDefined();
		expect(transportState.authProviders[0]?.clientInformation()).toEqual({
			client_id: "pre-registered",
			client_secret: "shh",
		});
	});

	it("still reconnects on a client saved by dynamic registration", async () => {
		const settingsPath = await settingsFile({
			clientInformation: { client_id: "from-dynamic-registration" },
		});

		await connect(settingsPath, registration());

		expect(transportState.authProviders[0]).toBeDefined();
		expect(transportState.authProviders[0]?.clientInformation()).toEqual({
			client_id: "from-dynamic-registration",
		});
	});

	// Guards the gate the two above rely on: a first connection with nothing
	// stored must not attach a provider, so it cannot start an interactive flow
	// on its own.
	it("attaches no provider at all when nothing is stored", async () => {
		const oauthClient = { clientId: "pre-registered" };
		const settingsPath = await settingsFile({ oauthClient });

		await connect(settingsPath, registration(oauthClient));

		expect(transportState.authProviders).toEqual([undefined]);
	});
});
