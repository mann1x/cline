import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMcpServerOAuthStatuses } from "./config-loader";
import { authorizeMcpServerOAuth } from "./oauth";

/**
 * These drive the real authorization flow end to end against a local OAuth
 * server, because the two things they pin down are only visible on the wire:
 * that a pre-registered confidential client is actually authenticated at the
 * token endpoint, and that a server which refuses dynamic client registration
 * is reported as refusing registration rather than as rejecting credentials it
 * never received.
 */
describe("mcp oauth authorization flow", () => {
	const tempRoots: string[] = [];
	const servers: Server[] = [];

	afterEach(async () => {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
		);
		servers.length = 0;
		await Promise.all(
			tempRoots.map((directory) =>
				rm(directory, { recursive: true, force: true }),
			),
		);
		tempRoots.length = 0;
	});

	const CLIENT_ID = "preregistered-client";
	const CLIENT_SECRET = "s3cr3t-value";

	async function startAuthServer(options: {
		allowRegistration: boolean;
	}): Promise<{ origin: string; tokenAuthMethods: string[] }> {
		const codes = new Map<string, string>();
		const tokens = new Set<string>();
		const tokenAuthMethods: string[] = [];
		let origin = "";

		const server = createServer(async (request, response) => {
			const url = new URL(request.url ?? "/", origin);
			const json = (status: number, body: unknown, headers = {}) => {
				response.writeHead(status, {
					"content-type": "application/json",
					...headers,
				});
				response.end(JSON.stringify(body));
			};
			const readBody = async (): Promise<string> => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) {
					chunks.push(chunk as Buffer);
				}
				return Buffer.concat(chunks).toString("utf8");
			};

			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				return json(200, {
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
				});
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return json(200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					// No "none": this server will not accept a public client.
					token_endpoint_auth_methods_supported: [
						"client_secret_basic",
						"client_secret_post",
					],
				});
			}
			if (url.pathname === "/register") {
				await readBody();
				if (!options.allowRegistration) {
					// Deliberately not JSON: the shape that used to surface as an
					// unparseable OAuth error.
					response.writeHead(403, { "content-type": "text/plain" });
					return response.end("Forbidden");
				}
				return json(201, {
					client_id: CLIENT_ID,
					client_secret: CLIENT_SECRET,
				});
			}
			if (url.pathname === "/authorize") {
				const parameters = url.searchParams;
				const code = randomBytes(8).toString("hex");
				codes.set(code, parameters.get("code_challenge") ?? "");
				const state = parameters.get("state");
				response.writeHead(302, {
					location: `${parameters.get("redirect_uri")}?code=${code}${
						state ? `&state=${encodeURIComponent(state)}` : ""
					}`,
				});
				return response.end();
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(await readBody());
				const authorization = request.headers.authorization;
				let clientId: string | undefined;
				let clientSecret: string | undefined;
				if (authorization?.startsWith("Basic ")) {
					const [id, secret] = Buffer.from(authorization.slice(6), "base64")
						.toString("utf8")
						.split(":");
					clientId = decodeURIComponent(id ?? "");
					clientSecret = decodeURIComponent(secret ?? "");
					tokenAuthMethods.push("client_secret_basic");
				} else if (form.get("client_secret")) {
					clientId = form.get("client_id") ?? undefined;
					clientSecret = form.get("client_secret") ?? undefined;
					tokenAuthMethods.push("client_secret_post");
				} else {
					tokenAuthMethods.push("none");
					return json(401, { error: "invalid_client" });
				}
				if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
					return json(401, { error: "invalid_client" });
				}
				const challenge = codes.get(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				if (
					challenge === undefined ||
					createHash("sha256").update(verifier).digest("base64url") !==
						challenge
				) {
					return json(400, { error: "invalid_grant" });
				}
				const accessToken = randomBytes(8).toString("hex");
				tokens.add(accessToken);
				return json(200, {
					access_token: accessToken,
					token_type: "Bearer",
					expires_in: 3600,
				});
			}
			if (url.pathname === "/mcp") {
				const header = request.headers.authorization;
				const token = header?.startsWith("Bearer ")
					? header.slice(7)
					: undefined;
				if (!token || !tokens.has(token)) {
					return json(
						401,
						{ error: "unauthorized" },
						{
							"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
						},
					);
				}
				const message = JSON.parse((await readBody()) || "{}");
				if (message.method === "initialize") {
					return json(200, {
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "test-oauth-mcp", version: "1.0.0" },
						},
					});
				}
				if (message.method === "tools/list") {
					return json(200, {
						jsonrpc: "2.0",
						id: message.id,
						result: { tools: [] },
					});
				}
				if (String(message.method ?? "").startsWith("notifications/")) {
					response.writeHead(202);
					return response.end();
				}
				return json(200, {
					jsonrpc: "2.0",
					id: message.id ?? null,
					result: {},
				});
			}
			return json(404, { error: "not_found" });
		});

		servers.push(server);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = server.address();
		if (typeof address === "string" || address === null) {
			throw new Error("Expected the auth server to bind a TCP port.");
		}
		origin = `http://127.0.0.1:${address.port}`;
		return { origin, tokenAuthMethods };
	}

	async function createSettingsFile(
		origin: string,
		oauthClient?: { clientId: string; clientSecret?: string },
	): Promise<string> {
		const tempRoot = await mkdtemp(join(tmpdir(), "core-mcp-oauth-flow-"));
		tempRoots.push(tempRoot);
		const filePath = join(tempRoot, "cline_mcp_settings.json");
		await writeFile(
			filePath,
			JSON.stringify({
				mcpServers: {
					probe: {
						transport: { type: "streamableHttp", url: `${origin}/mcp` },
						...(oauthClient ? { oauthClient } : {}),
					},
				},
			}),
			"utf8",
		);
		return filePath;
	}

	// Stands in for the browser: follow the authorization redirect back to the
	// loopback callback. Not awaited, so the caller can start waiting first.
	const followAuthorization = (authorizationUrl: string): void => {
		setTimeout(async () => {
			const response = await fetch(authorizationUrl, { redirect: "manual" });
			const location = response.headers.get("location");
			if (location) {
				await fetch(location);
			}
		}, 10);
	};

	it("authenticates a pre-registered confidential client without registering", async () => {
		const { origin, tokenAuthMethods } = await startAuthServer({
			allowRegistration: false,
		});
		const settingsPath = await createSettingsFile(origin, {
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
		});

		const result = await authorizeMcpServerOAuth({
			serverName: "probe",
			filePath: settingsPath,
			openUrl: followAuthorization,
			callbackHost: "127.0.0.1",
			callbackPorts: [14561, 14562, 14563],
			timeoutMs: 15_000,
		});

		expect(result.authorized).toBe(true);
		// Registration is refused by this server, so reaching the token endpoint
		// at all proves the configured client was used instead.
		expect(tokenAuthMethods).toEqual(["client_secret_basic"]);
		expect(
			listMcpServerOAuthStatuses({ filePath: settingsPath })[0],
		).toMatchObject({ lastError: undefined });
	}, 30_000);

	it("reports a refused registration as refused registration", async () => {
		const { origin } = await startAuthServer({ allowRegistration: false });
		const settingsPath = await createSettingsFile(origin);

		await expect(
			authorizeMcpServerOAuth({
				serverName: "probe",
				filePath: settingsPath,
				openUrl: followAuthorization,
				callbackHost: "127.0.0.1",
				callbackPorts: [14561, 14562, 14563],
				timeoutMs: 15_000,
			}),
		).rejects.toThrow(/refused dynamic client registration \(HTTP 403/);

		const [status] = listMcpServerOAuthStatuses({ filePath: settingsPath });
		expect(status.lastError).toContain("oauthClient");
		// The unparseable body must not be what the user is shown.
		expect(status.lastError).not.toContain("Invalid OAuth error response");
	}, 30_000);
});
