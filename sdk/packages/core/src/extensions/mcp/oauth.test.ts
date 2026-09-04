import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMcpOAuthProviderContext,
	toOAuthClientInformation,
} from "./oauth";
import type { McpServerRegistration } from "./types";

describe("mcp oauth", () => {
	const tempRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			tempRoots.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
		);
		tempRoots.length = 0;
	});

	async function createSettingsFile(
		extra: Record<string, unknown> = {},
	): Promise<string> {
		const tempRoot = await mkdtemp(join(tmpdir(), "core-mcp-oauth-"));
		tempRoots.push(tempRoot);
		const filePath = join(tempRoot, "cline_mcp_settings.json");
		await writeFile(
			filePath,
			JSON.stringify(
				{
					mcpServers: {
						linear: {
							transport: {
								type: "streamableHttp",
								url: "https://mcp.linear.app/mcp",
							},
							...extra,
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		return filePath;
	}

	it("tracks the most recent generated OAuth state", async () => {
		const settingsPath = await createSettingsFile();
		const context = createMcpOAuthProviderContext({
			settingsPath,
			serverName: "linear",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
		});

		expect(context.getLastOAuthState()).toBeUndefined();

		const createState = context.provider.state;
		if (!createState) {
			throw new Error("Expected OAuth provider to expose state generator.");
		}

		const firstState = createState();
		expect(context.getLastOAuthState()).toBe(firstState);

		const secondState = createState();
		expect(secondState).not.toBe(firstState);
		expect(context.getLastOAuthState()).toBe(secondState);
	});

	it("does not write redirect state when creating a provider context", async () => {
		const settingsPath = await createSettingsFile();
		const before = await readFile(settingsPath, "utf8");

		createMcpOAuthProviderContext({
			settingsPath,
			serverName: "linear",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
		});

		await expect(readFile(settingsPath, "utf8")).resolves.toBe(before);
	});

	it("prefers a pre-registered client over one saved by dynamic registration", async () => {
		const settingsPath = await createSettingsFile({
			oauth: { clientInformation: { client_id: "from-dynamic-registration" } },
		});

		const context = createMcpOAuthProviderContext({
			settingsPath,
			serverName: "linear",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
			clientInformation: { client_id: "pre-registered" },
		});

		expect(context.provider.clientInformation()).toEqual({
			client_id: "pre-registered",
		});
	});

	// The SDK skips registration whenever clientInformation() answers, so it
	// never calls saveClientInformation and nothing persists a pre-registered
	// client. If the reset that opens every authorize could clear it, the next
	// attempt would fall back to dynamic registration -- which is exactly what
	// the servers needing pre-registration refuse.
	it("keeps a pre-registered client across the interactive reset", async () => {
		const settingsPath = await createSettingsFile();
		const context = createMcpOAuthProviderContext({
			settingsPath,
			serverName: "linear",
			redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
			clientInformation: { client_id: "pre-registered" },
		});

		await context.resetInteractiveState();

		expect(context.provider.clientInformation()).toEqual({
			client_id: "pre-registered",
		});
	});

	it("omits client_secret for a public pre-registered client", () => {
		const base: McpServerRegistration = {
			name: "figma",
			transport: { type: "streamableHttp", url: "https://mcp.figma.com/mcp" },
		};

		expect(toOAuthClientInformation(base)).toBeUndefined();
		expect(
			toOAuthClientInformation({
				...base,
				oauthClient: { clientId: "public-client" },
			}),
		).toEqual({ client_id: "public-client" });
		expect(
			toOAuthClientInformation({
				...base,
				oauthClient: { clientId: "confidential", clientSecret: "shh" },
			}),
		).toEqual({ client_id: "confidential", client_secret: "shh" });
	});
});
