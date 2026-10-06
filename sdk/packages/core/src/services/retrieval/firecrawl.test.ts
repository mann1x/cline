import { describe, expect, it } from "vitest";
import {
	crawlSite,
	htmlToMarkdown,
	mapSite,
	ScrapeError,
	scrapePage,
	searchWeb,
} from "./firecrawl";

const endpoint = { baseUrl: "http://scrape.test/v2/", apiKey: "k" };

function answering(
	answers: (url: string, init: RequestInit | undefined) => Response,
) {
	const seen: {
		url: string;
		headers: Record<string, string>;
		body?: unknown;
	}[] = [];
	const send = (async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(input),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return answers(String(input), init);
	}) as typeof fetch;
	return { send, seen };
}

describe("the scraping endpoint", () => {
	it("keeps code blocks, with their language, whatever wraps them", async () => {
		const markdown = await htmlToMarkdown(
			'<h2>Setup<a class="headerlink" href="#setup">¶</a></h2><div class="highlight-gdscript notranslate"><div class="highlight"><pre><span class="k">func</span> <span class="nf">_ready</span>():\n    <span class="nb">print</span>(<span class="s">"hi"</span>)\n</pre></div></div><pre><code class="language-python">x = 1\n</code></pre><table><tr><th>a</th></tr><tr><td>1</td></tr></table>',
		);
		expect(markdown).toContain(
			'```gdscript\nfunc _ready():\n    print("hi")\n```',
		);
		expect(markdown).toContain("```python\nx = 1\n```");
		expect(markdown).toContain("## Setup\n");
		expect(markdown).not.toContain("¶");
		expect(markdown).toMatch(/\|\s*a\s*\|\n\|\s*-+\s*\|\n\|\s*1\s*\|/);
	});

	it("asks for HTML with the key, and gives the page as markdown with its hash", async () => {
		const { send, seen } = answering(() =>
			Response.json({
				success: true,
				data: {
					html: "<h1>Tilemaps</h1><p>A grid.</p>",
					links: ["https://example.com/b", 3],
					metadata: {
						sourceURL: "https://example.com/a",
						title: " Tilemaps ",
						language: "en",
						statusCode: 200,
					},
				},
			}),
		);
		const page = await scrapePage(endpoint, "https://example.com/a", {
			fetch: send,
			links: true,
		});
		expect(seen[0]).toMatchObject({
			url: "http://scrape.test/v2/scrape",
			headers: { Authorization: "Bearer k" },
			body: {
				url: "https://example.com/a",
				formats: ["html", "links"],
				onlyMainContent: true,
			},
		});
		expect(page).toMatchObject({
			url: "https://example.com/a",
			title: "Tilemaps",
			language: "en",
			markdown: "# Tilemaps\n\nA grid.",
			links: ["https://example.com/b"],
		});
		expect(page.sha256).toHaveLength(64);
	});

	it("says what went wrong in words the user can act on", async () => {
		const failing = (status: number, body: string) =>
			scrapePage(endpoint, "https://example.com/a", {
				fetch: answering(() => new Response(body, { status })).send,
			});
		await expect(failing(401, '{"error":"no key"}')).rejects.toThrow(
			"refused the key",
		);
		await expect(
			failing(502, "<html><h1>502 Bad Gateway</h1></html>"),
		).rejects.toThrow("is not running");
		await expect(
			failing(500, '{"success":false,"error":"boom"}'),
		).rejects.toThrow("HTTP 500: boom");
		await expect(
			scrapePage(endpoint, "https://example.com/a", {
				fetch: answering(() =>
					Response.json({
						success: true,
						data: { html: "<p>x</p>", metadata: { statusCode: 404 } },
					}),
				).send,
			}),
		).rejects.toBeInstanceOf(ScrapeError);
	});

	it("reads a crawl to its end by skipping what it has, not by the job's own next link", async () => {
		const pages = ["a", "b", "c"].map((name) => ({
			html: `<p>page ${name}</p>`,
			metadata: {
				sourceURL: `https://example.com/${name}`,
				statusCode: name === "c" ? 500 : 200,
			},
		}));
		let polls = 0;
		const { send, seen } = answering((url) => {
			if (url.endsWith("/v2/crawl"))
				return Response.json({ success: true, id: "j 1" });
			polls++;
			const skip = Number(new URL(url).searchParams.get("skip"));
			return Response.json({
				success: true,
				status: polls < 2 ? "scraping" : "completed",
				completed: 3,
				total: 3,
				next: "http://unreachable/v2/crawl/j1?skip=2",
				data: pages.slice(skip, skip + 2),
			});
		});
		const progress: number[] = [];
		const result = await crawlSite(endpoint, "https://example.com/a", {
			limit: 10,
			depth: 2,
			includePaths: ["^/docs"],
			fetch: send,
			onProgress: (done) => progress.push(done),
		});
		expect(seen[0].body).toMatchObject({
			limit: 10,
			maxDiscoveryDepth: 2,
			includePaths: ["^/docs"],
			scrapeOptions: { formats: ["html"] },
		});
		expect(seen.slice(1).map((request) => request.url)).toEqual([
			"http://scrape.test/v2/crawl/j%201?skip=0",
			"http://scrape.test/v2/crawl/j%201?skip=2",
			"http://scrape.test/v2/crawl/j%201?skip=3",
		]);
		expect(result.pages.map((page) => page.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
		expect(result.failed).toEqual([
			{ url: "https://example.com/c", reason: "the site answered HTTP 500" },
		]);
		expect(progress.at(-1)).toBe(3);
	});

	it("maps a site and searches the web, in either shape an endpoint answers", async () => {
		expect(
			await mapSite(endpoint, "https://example.com", {
				fetch: answering(() =>
					Response.json({
						success: true,
						links: ["https://example.com/a", { url: "https://example.com/b" }],
					}),
				).send,
			}),
		).toEqual(["https://example.com/a", "https://example.com/b"]);
		const hit = {
			url: "https://example.com/a",
			title: "A",
			description: "About a.",
		};
		for (const data of [[hit], { web: [hit, { title: "no url" }] }]) {
			expect(
				await searchWeb(endpoint, "q", {
					fetch: answering(() => Response.json({ success: true, data })).send,
				}),
			).toEqual([hit]);
		}
	});
});
