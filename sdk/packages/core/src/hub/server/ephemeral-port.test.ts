import { describe, expect, it } from "vitest";
import { resolveEphemeralPort } from "./hub-websocket-server";

/**
 * Measured on this host: `net.ipv4.ip_local_port_range` is `1024 65535`, so an
 * ephemeral bind can land on a port from the WHATWG blocked list. `fetch()`
 * refuses those outright — the failure surfaced as a full core run dying on
 * `Error: bad port` in the hub shutdown test, and passing on every rerun.
 */
describe("resolveEphemeralPort", () => {
	it("returns the first port the OS offers when it is usable", async () => {
		expect(await resolveEphemeralPort("127.0.0.1", async () => 41234)).toBe(41234);
	});

	it("asks again when the OS hands back a port fetch will not connect to", async () => {
		const offered = [6667, 10080, 2049, 45001];
		let index = 0;
		const port = await resolveEphemeralPort("127.0.0.1", async () => offered[index++]);
		expect(port).toBe(45001);
		expect(index).toBe(4);
	});

	// Giving up and starting on an awkward port beats refusing to start.
	it("gives up rather than looping forever if every port is blocked", async () => {
		let calls = 0;
		const port = await resolveEphemeralPort("127.0.0.1", async () => {
			calls += 1;
			return 6667;
		});
		expect(port).toBe(6667);
		expect(calls).toBeLessThanOrEqual(16);
	});

	it("really does get a bindable port from the OS", async () => {
		const port = await resolveEphemeralPort("127.0.0.1");
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThan(65536);
	});
});
