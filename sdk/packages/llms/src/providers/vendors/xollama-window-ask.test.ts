import { afterEach, describe, expect, it } from "vitest";
import {
	clearPolykvGrantedWindow,
	getPolykvWindowGrant,
	recordPolykvGrantedWindow,
} from "./polykv";
import { windowAsk } from "./xollama";

const session = "window-ask-test";

afterEach(() => clearPolykvGrantedWindow(session));

// ol-88: the size was changed to 128,000 after a booked window had been
// granted at 256,000. The grant won over the setting, the conversation kept
// asking for 256,000 and the bar showed it, while compaction worked to 128k.
describe("windowAsk with a booked grant", () => {
	it("asks for a size set since the grant was asked for", () => {
		recordPolykvGrantedWindow(session, 256_000, { asked: 256_000 });
		const ask = windowAsk(session, {}, {
			requestedWindow: 128_000,
			contextFloor: 32_000,
		} as never);
		expect(ask).toEqual({ num_ctx: 128_000, num_ctx_min: 32_000 });
		expect(getPolykvWindowGrant(session)).toBeUndefined();
	});

	it("keeps a grant negotiated down from the size still set", () => {
		recordPolykvGrantedWindow(session, 200_000, { asked: 256_000 });
		const ask = windowAsk(session, {}, { requestedWindow: 256_000 } as never);
		expect(ask).toEqual({ num_ctx: 200_000, num_ctx_min: 200_000 });
	});
});
