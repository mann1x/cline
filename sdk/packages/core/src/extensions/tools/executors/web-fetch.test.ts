import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentToolContext } from "@cline/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createWebFetchExecutor,
	decodeEntities,
	htmlToText,
} from "./web-fetch";

const CONTEXT = {} as AgentToolContext;

let server: Server;
let base: string;

const ROUTES: Record<
	string,
	{ type?: string; body: Buffer | string; delayMs?: number }
> = {
	"/latin1": {
		type: "text/html; charset=iso-8859-1",
		body: Buffer.from("<p>Caf\xe9 cr\xe8me</p>", "latin1"),
	},
	"/meta-latin1": {
		type: "text/html",
		body: Buffer.from(
			'<html><head><meta charset="windows-1252"></head><body>na\xefve</body></html>',
			"latin1",
		),
	},
	"/pdf": {
		type: "application/pdf",
		body: Buffer.from("%PDF-1.4\n\x00\x01\x02binary", "latin1"),
	},
	"/page": {
		type: "text/html; charset=utf-8",
		body: "<h1>Title</h1><p>Body text</p>",
	},
	"/slow": { type: "text/plain", body: "late", delayMs: 2_000 },
};

beforeAll(async () => {
	server = createServer((request, response) => {
		const route = ROUTES[request.url ?? ""];
		if (!route) {
			response.writeHead(404).end();
			return;
		}
		const send = () => {
			if (route.type) response.setHeader("content-type", route.type);
			response.end(route.body);
		};
		if (route.delayMs) setTimeout(send, route.delayMs).unref();
		else send();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("decodeEntities", () => {
	it("decodes once: an escaped entity stays an entity", () => {
		// `&amp;lt;` is the text "&lt;", not "<" (readers 28).
		expect(decodeEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
	});

	it("decodes named, decimal and hex references, astral ones included", () => {
		expect(decodeEntities("&eacute; &#233; &#xE9; &#x1F600; &nbsp;")).toBe(
			"é é é 😀 \u00a0",
		);
	});

	it("keeps the case of a name: &Eacute; is not &eacute;", () => {
		expect(decodeEntities("&Eacute;t&eacute; &AMP;")).toBe("Été &");
	});

	it("leaves an unknown name as written", () => {
		expect(decodeEntities("&notanentity; & alone")).toBe(
			"&notanentity; & alone",
		);
	});
});

describe("htmlToText", () => {
	it("does not cut a tag at a > inside a quoted attribute", () => {
		expect(htmlToText('<a title="a > b">link</a> after')).toBe("link after");
	});

	it("keeps a <pre> block's lines and indentation", () => {
		const text = htmlToText(
			"<p>Run:</p><pre>if x:\n    return &lt;y&gt;\n</pre><p>done</p>",
		);
		expect(text).toContain("if x:\n    return <y>");
		expect(text).toContain("done");
	});

	it("shows an escaped tag as text, not as a tag", () => {
		expect(htmlToText("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;");
	});
});

describe("fetch_web_content", () => {
	const fetchPage = createWebFetchExecutor({ timeoutMs: 1_000 });

	it("decodes a page by the charset its header declares", async () => {
		const result = await fetchPage(`${base}/latin1`, "read it", CONTEXT);
		expect(result).toContain("Café crème");
		expect(result).not.toContain("\ufffd");
	});

	it("decodes a page by the charset its meta tag declares", async () => {
		const result = await fetchPage(`${base}/meta-latin1`, "read it", CONTEXT);
		expect(result).toContain("naïve");
	});

	it("does not show a PDF's bytes as text, and says how to read it", async () => {
		const result = await fetchPage(`${base}/pdf`, "summarize", CONTEXT);
		expect(result).toContain("This is not a text page (application/pdf)");
		expect(result).toContain("extract_document");
		expect(result).not.toContain("binary");
	});

	it("hands the request back to the model instead of claiming it was applied", async () => {
		const result = await fetchPage(
			`${base}/page`,
			"List the headings",
			CONTEXT,
		);
		expect(result).toContain("Title");
		expect(result).toContain(
			"--- Your request (nothing has been extracted for you: apply it to the content above) ---\nList the headings",
		);
	});

	it("calls a timeout a timeout", async () => {
		await expect(fetchPage(`${base}/slow`, "x", CONTEXT)).rejects.toThrow(
			"Request timed out after 1000ms",
		);
	});

	it("calls a cancel a cancel, not a timeout", async () => {
		const controller = new AbortController();
		const pending = createWebFetchExecutor({ timeoutMs: 10_000 })(
			`${base}/slow`,
			"x",
			{ signal: controller.signal } as AgentToolContext,
		);
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toThrow("Request was cancelled");
	});
});
