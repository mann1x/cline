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

// The pre-registered client has to reach the *runtime* connection, not just the
// interactive authorize. The SDK skips registration whenever clientInformation()
// answers, so it never calls saveClientInformation and nothing persists the
// client -- if connect builds its provider context without it, every reconnect
// and every token refresh falls back to dynamic registration, which is the one
// thing a server like Figma or Slack refuses.
describe("mcp client pre-registered OAuth client", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		transportState.authProviders.length = 0;
		await Promise.all(
			tempRoots.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
		);
		tempRoots.length = 0;
	});

	async function settingsFile(): Promise<string> {
		const tempRoot = await mkdtemp(join(tmpdir(), "core-mcp-client-oauth-"));
		tempRoots.push(tempRoot);
		const filePath = join(tempRoot, "cline_mcp_settings.json");
		await writeFile(filePath, JSON.stringify({ mcpServers: {} }), "utf8");
		return filePath;
	}

	function registration(
		oauthClient?: McpServerRegistration["oauthClient"],
	): McpServerRegistration {
		return {
			name: "figma",
			transport: {
				type: "streamableHttp",
				url: "https://mcp.figma.example/mcp",
			},
			...(oauthClient ? { oauthClient } : {}),
		};
	}

	it("hands the configured client to the connecting transport", async () => {
		const settingsPath = await settingsFile();
		const factory = createDefaultMcpServerClientFactory({ settingsPath });

		const client = await factory(
			registration({ clientId: "pre-registered", clientSecret: "shh" }),
		);
		await client.connect();

		expect(transportState.authProviders).toHaveLength(1);
		expect(transportState.authProviders[0]?.clientInformation()).toEqual({
			client_id: "pre-registered",
			client_secret: "shh",
		});
	});

	it("leaves the client undiscovered when none is configured", async () => {
		const settingsPath = await settingsFile();
		const factory = createDefaultMcpServerClientFactory({ settingsPath });

		const client = await factory(registration());
		await client.connect();

		expect(transportState.authProviders).toHaveLength(1);
		expect(
			transportState.authProviders[0]?.clientInformation(),
		).toBeUndefined();
	});
});
