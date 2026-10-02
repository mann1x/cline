import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createCliMediaTools,
	mediaRequested,
	readCliMediaConfig,
} from "./media-tools";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("the CLI's media configuration", () => {
	it("offers nothing unless asked", async () => {
		expect(mediaRequested({})).toBe(false);
		expect(
			await createCliMediaTools({
				args: {},
				cwd: "/work",
				provider: { providerId: "ollama" },
			}),
		).toEqual([]);
	});

	it("--media-provider alone is every section on the session's provider", async () => {
		expect(await readCliMediaConfig({ mediaProvider: true }, "/work")).toEqual({
			image: { useProvider: true },
			transcription: { useProvider: true },
			speech: { useProvider: true },
			video: { useProvider: true },
		});
		vi.stubEnv("CLINE_MEDIA_PROVIDER", "1");
		expect(mediaRequested({})).toBe(true);
	});

	it("a file says which sections are on, and the flag ticks their box", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-media-"));
		await writeFile(
			join(dir, "media.json"),
			JSON.stringify({
				baseUrl: "http://media:1",
				image: { model: "klein", edit: false },
			}),
		);
		expect(
			await readCliMediaConfig(
				{ mediaConfig: "media.json", mediaProvider: true },
				dir,
			),
		).toEqual({
			image: {
				useProvider: true,
				baseUrl: "http://media:1",
				model: "klein",
				edit: false,
			},
		});
		await expect(
			readCliMediaConfig({ mediaConfig: "missing.json" }, dir),
		).rejects.toThrow(/--media-config: could not read/);
	});

	it("builds the tools the provider serves, and logs each decision", async () => {
		// An opencoti with an image engine and nothing else.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).endsWith("/props")
					? Response.json({
							build_info: "opencoti-0.10.5-b103",
							features: ["images_generate_v1"],
						})
					: new Response("not found", { status: 404 }),
			),
		);
		const log: string[] = [];
		const tools = await createCliMediaTools({
			args: { mediaProvider: true },
			cwd: "/work",
			provider: {
				providerId: "opencoti",
				baseUrl: "http://lead:8080/v1",
				modelId: "qwen",
			},
			log: (line) => log.push(line),
		});
		expect(tools.map((tool) => tool.name)).toEqual(["generate_image"]);
		expect(log[0]).toMatch(
			/^\[media\] generate_image uses the session's provider \(opencoti\)/,
		);
		expect(log).toHaveLength(5);
	});
});
