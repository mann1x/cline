import { describe, expect, it } from "vitest";
import { buildInitialUserContent } from "./user-input-builder";

const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("buildInitialUserContent", () => {
	it("carries a data URL through as image data", async () => {
		const content = await buildInitialUserContent("look at this", [
			`data:image/png;base64,${PNG_B64}`,
		]);

		expect(content).toContainEqual({
			type: "image",
			mediaType: "image/png",
			data: PNG_B64,
		});
	});

	it("accepts a bare base64 payload", async () => {
		const content = await buildInitialUserContent("look at this", [PNG_B64]);

		expect(content).toContainEqual({
			type: "image",
			mediaType: "image/png",
			data: PNG_B64,
		});
	});

	// The fallback accepted any string at all, so a value that was never image
	// data became image data with an `image/png` label on it and went to the
	// model as a picture. Measured before the guard: this path came out as a
	// 26-character `image` part. Nothing failed, because nothing here could.
	it.each([
		["a filesystem path", "/home/user/screenshot.png"],
		["a URL", "https://example.com/a.png"],
		["prose", "here is the screenshot"],
	])("drops %s rather than calling it an image", async (_label, value) => {
		const content = await buildInitialUserContent("look at this", [value]);

		expect(content).toBe("look at this");
	});
});
