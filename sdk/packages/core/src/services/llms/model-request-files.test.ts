import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	isModelRequestCaptureOn,
	setModelRequestCapture,
	withModelRequestCapture,
} from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyModelRequestCapture,
	createModelRequestWriter,
} from "./model-request-files";

const dirs: string[] = [];
afterEach(async () => {
	setModelRequestCapture(undefined);
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "capture-"));
	dirs.push(dir);
	return dir;
}

describe("createModelRequestWriter", () => {
	it("writes one file per request in a folder per conversation, in send order", async () => {
		const dir = await tempDir();
		const write = createModelRequestWriter({ dir });
		const at = "2026-10-16T06:10:34.600Z";
		write({
			at,
			url: "http://x/api/chat",
			method: "POST",
			sessionId: "s1",
			body: { n: 1 },
		});
		write({
			at,
			url: "http://x/api/chat",
			method: "POST",
			sessionId: "s1",
			body: { n: 2 },
		});
		write({ at, url: "http://x/api/chat", method: "POST", body: { n: 3 } });
		await settle();
		const files = (await readdir(path.join(dir, "s1"))).sort();
		expect(files).toHaveLength(2);
		const first = JSON.parse(
			await readFile(path.join(dir, "s1", files[0]), "utf8"),
		);
		expect(first.body).toEqual({ n: 1 });
		expect(await readdir(path.join(dir, "no-session"))).toHaveLength(1);
	});

	it("saves the response beside its request", async () => {
		const dir = await tempDir();
		const respond = createModelRequestWriter({ dir })({
			at: "2026-10-16T06:10:34.600Z",
			url: "http://x/api/chat",
			method: "POST",
			sessionId: "task/agent:1",
			body: {},
		});
		respond?.({
			at: "2026-10-16T06:10:35.000Z",
			status: 200,
			body: "{}\n",
			complete: true,
		});
		await settle();
		const files = (await readdir(path.join(dir, "task_agent_1"))).sort();
		expect(files).toHaveLength(2);
		const [request, response] = files;
		expect(response).toBe(request.replace(/\.json$/, ".response.json"));
		expect(
			JSON.parse(
				await readFile(path.join(dir, "task_agent_1", response), "utf8"),
			),
		).toMatchObject({ status: 200, body: "{}\n", complete: true });
	});

	it("asks for no response when responses are off", async () => {
		const dir = await tempDir();
		const respond = createModelRequestWriter({ dir, responses: false })({
			at: "2026-10-16T06:10:34.600Z",
			url: "http://x/api/chat",
			method: "POST",
			body: {},
		});
		expect(respond).toBeUndefined();
	});
});

describe("applyModelRequestCapture", () => {
	it("records a turn end to end through the capturing fetch", async () => {
		const dir = await tempDir();
		expect(applyModelRequestCapture({ dir })).toBe(dir);
		expect(isModelRequestCaptureOn()).toBe(true);
		const base = (async () =>
			new Response(
				'{"message":{"thinking":"t","content":"c"},"done":true}\n',
			)) as unknown as typeof fetch;
		const response = await withModelRequestCapture(base, "conv")(
			"http://x/api/chat",
			{ method: "POST", body: '{"model":"m","messages":[]}' },
		);
		await response.text();
		await settle();
		const files = (await readdir(path.join(dir, "conv"))).sort();
		expect(files).toHaveLength(2);
		const saved = JSON.parse(
			await readFile(path.join(dir, "conv", files[1]), "utf8"),
		);
		expect(saved.body).toContain('"thinking":"t"');
	});

	it("turns the capture off", () => {
		applyModelRequestCapture(true);
		expect(applyModelRequestCapture(false)).toBeUndefined();
		expect(isModelRequestCaptureOn()).toBe(false);
	});
});
