/**
 * A port of a remote terminal, opened on this machine.
 *
 * `remote_read fetch` hands a page's text to the model, but the local browser
 * tool needs an address it can open: GLM had to copy a page to the user's
 * machine and serve it there to test it (session 1795889478074_yraiv). This
 * listens on 127.0.0.1 and relays each request to Open WebUI's per-port proxy
 * (`/api/v1/machines/<id>/proxy/<port>/<path>`), adding the API key on the way.
 *
 * Open WebUI changes HTML from a machine port for its own in-chat preview: it
 * injects a script that rewrites links to its proxy prefix, and it rewrites
 * redirects to that prefix. Both are undone here, so the page sees itself at
 * the local address and its own URLs resolve against it. WebSockets do not
 * pass: Open WebUI has no WebSocket route for machine ports.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface PortForwardTarget {
	machineId: string;
	port: number;
	/** Read on every request: the address or key can change while a forward is open. */
	getConnection: () => { openWebUiUrl?: string; apiKey?: string };
}

export interface PortForward {
	/** `http://127.0.0.1:<local port>/` */
	url: string;
	close: () => Promise<void>;
}

/** Closed after this long without a request. */
const IDLE_CLOSE_MS = 60 * 60 * 1000;

/** The prefix Open WebUI's rewrites point at, for one machine port. */
export function proxyPrefix(machineId: string, port: number): string {
	return `/api/v1/machines/${encodeURIComponent(machineId)}/proxy/${port}/`;
}

/** Open WebUI's in-chat preview script, which the page does not need here. */
export function withoutPreviewScript(html: string): string {
	return html.replace(
		/<script>(?:(?!<\/script>)[\s\S])*terminal-browser-state(?:(?!<\/script>)[\s\S])*<\/script>/,
		"",
	);
}

/** A path as the remote server should see it, from a local request path. */
export function upstreamPath(localPath: string, prefix: string): string {
	// The injected script (when a page cached it) and rewritten redirects
	// point at the proxy prefix; plain links point at the root.
	const path = localPath.startsWith(prefix)
		? `/${localPath.slice(prefix.length)}`
		: localPath;
	return path.replace(/^\/+/, "");
}

const DROPPED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"authorization",
	"content-length",
	"transfer-encoding",
	"keep-alive",
	"upgrade",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"set-cookie",
]);

export async function openPortForward(
	target: PortForwardTarget,
	fetchImpl: typeof fetch = fetch,
): Promise<PortForward> {
	const prefix = proxyPrefix(target.machineId, target.port);
	let idle: ReturnType<typeof setTimeout> | undefined;
	let server: Server;
	const close = () =>
		new Promise<void>((resolve) => {
			if (idle) clearTimeout(idle);
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	const touch = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => void close(), IDLE_CLOSE_MS);
		idle.unref?.();
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		touch();
		const { openWebUiUrl, apiKey } = target.getConnection();
		const base = (openWebUiUrl ?? "").trim().replace(/\/+$/, "");
		if (!base || !apiKey) {
			response
				.writeHead(503, { "Content-Type": "text/plain" })
				.end("Remote terminals are not configured in Cerebriline.");
			return;
		}
		const local = new URL(request.url ?? "/", "http://127.0.0.1");
		const url = `${base}${prefix}${upstreamPath(local.pathname, prefix)}${local.search}`;
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) {
			if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
			headers.set(name, Array.isArray(value) ? value.join(", ") : value);
		}
		headers.set("Authorization", `Bearer ${apiKey}`);
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		let upstream: Response;
		try {
			upstream = await fetchImpl(url, {
				method: request.method,
				headers,
				redirect: "manual",
				...(hasBody
					? {
							body: Readable.toWeb(request) as unknown as RequestInit["body"],
							duplex: "half",
						}
					: {}),
			} as RequestInit);
		} catch (error) {
			response
				.writeHead(502, { "Content-Type": "text/plain" })
				.end(
					`Open WebUI could not be reached: ${error instanceof Error ? error.message : String(error)}`,
				);
			return;
		}
		const out: Record<string, string | string[]> = {};
		upstream.headers.forEach((value, name) => {
			if (DROPPED_RESPONSE_HEADERS.has(name)) return;
			out[name] =
				name === "location" && value.startsWith(prefix)
					? `/${value.slice(prefix.length)}`
					: value;
		});
		const cookies = upstream.headers.getSetCookie?.() ?? [];
		if (cookies.length > 0) out["set-cookie"] = cookies;
		const type = upstream.headers.get("content-type") ?? "";
		if (type.includes("text/html")) {
			const html = withoutPreviewScript(await upstream.text());
			response.writeHead(upstream.status, out).end(html);
			return;
		}
		response.writeHead(upstream.status, out);
		if (!upstream.body || request.method === "HEAD") {
			response.end();
			return;
		}
		Readable.fromWeb(upstream.body as never).pipe(response);
	};

	server = createServer((request, response) => {
		handle(request, response).catch((error) => {
			if (!response.headersSent)
				response.writeHead(500, { "Content-Type": "text/plain" });
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	// A forward never keeps a process (the CLI) alive by itself.
	server.unref();
	touch();
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/`, close };
}
