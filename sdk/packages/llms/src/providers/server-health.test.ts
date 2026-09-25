import { describe, expect, it } from "vitest";
import {
	probeServerHealth,
	SERVER_HEALTH_MAX_INTERVAL_MS,
	serverHealthBackoffMs,
	serverRoot,
	waitForServerHealth,
} from "./server-health";

const answering = (status: number) =>
	(async () => new Response("", { status })) as unknown as typeof fetch;

describe("server health", () => {
	it("probes the root, not the API prefix", () => {
		expect(serverRoot("http://192.168.178.2:8241/v1")).toBe(
			"http://192.168.178.2:8241",
		);
		expect(serverRoot("http://host:11434/api/")).toBe("http://host:11434");
		expect(serverRoot(undefined)).toBeUndefined();
		expect(serverRoot("not a url")).toBeUndefined();
	});

	it("reads 503 (a restarted server still loading) as not back", async () => {
		expect(await probeServerHealth("http://h", { fetch: answering(503) })).toBe(
			false,
		);
		expect(await probeServerHealth("http://h", { fetch: answering(200) })).toBe(
			true,
		);
	});

	it("reads a server without /health (a 404) as answering", async () => {
		expect(await probeServerHealth("http://h", { fetch: answering(404) })).toBe(
			true,
		);
	});

	it("reads a refused connection as not back", async () => {
		const refused = (async () => {
			throw Object.assign(new Error("fetch failed"), {
				cause: { code: "ECONNREFUSED" },
			});
		}) as unknown as typeof fetch;
		expect(await probeServerHealth("http://h", { fetch: refused })).toBe(false);
	});

	it("backs off exponentially up to 30 s between probes, with no deadline", async () => {
		const waits: number[] = [];
		let probes = 0;
		const back = await waitForServerHealth("http://h", {
			probe: async () => ++probes > 12,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		expect(back).toBe(true);
		expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
		expect(Math.max(...waits)).toBe(SERVER_HEALTH_MAX_INTERVAL_MS);
		expect(waits).toHaveLength(12);
		expect(serverHealthBackoffMs(100)).toBe(SERVER_HEALTH_MAX_INTERVAL_MS);
	});

	it("stops waiting the moment the signal aborts", async () => {
		const controller = new AbortController();
		let probes = 0;
		const back = await waitForServerHealth("http://h", {
			signal: controller.signal,
			probe: async () => {
				probes += 1;
				if (probes === 3) {
					controller.abort();
				}
				return false;
			},
			sleep: async () => {},
		});
		expect(back).toBe(false);
		expect(probes).toBe(3);
	});
});
