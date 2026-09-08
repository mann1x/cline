import { describe, expect, it } from "vitest";
import { checkPage } from "./page-check";

/** A page that draws one frame and keeps asking for the next. */
const WORKING = `<html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
let ticks = 0;
function loop(){ ctx.fillRect(0, 0, ticks, 10); ticks += 1; requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script></body></html>`;

describe("checkPage", () => {
	it("passes a page that loads and keeps drawing", () => {
		const result = checkPage("game.html", WORKING, { frames: 5 });

		expect(result.ok).toBe(true);
		expect(result.framesRun).toBe(5);
	});

	// The failure this check was built for: the file parses in no engine, so
	// nothing runs and a browser console has nothing to print.
	it("fails a page whose script does not parse", () => {
		const broken = WORKING.replace(
			"requestAnimationFrame(loop);\n</script>",
			"requestAnimationFrame(loop};\n</script>",
		);

		const result = checkPage("game.html", broken, { frames: 5 });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("SyntaxError");
		expect(result.framesRun).toBe(0);
	});

	it("fails a page that throws while loading", () => {
		const result = checkPage(
			"game.html",
			"<script>missingFunction();</script>",
			{ frames: 5 },
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("ReferenceError");
	});

	// A page can load cleanly and still be broken from the third frame on,
	// which is the class of bug that reading the console once never catches.
	it("fails a page that throws in a later frame", () => {
		const page = `<script>
let n = 0;
function loop(){ n += 1; if (n === 3) { gone(); } requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script>`;

		const result = checkPage("game.html", page, { frames: 10 });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("frame 2");
		expect(result.error).toContain("ReferenceError");
	});

	// "It's not working" is usually this, not a thrown error: the page loads,
	// prints nothing, and never runs.
	it("fails a page that never schedules a frame", () => {
		const result = checkPage("game.html", "<script>const x = 1;</script>", {
			frames: 5,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("no animation frame");
	});

	it("starts a page that waits to be told to", () => {
		const page = `<script>
function startGame(){ requestAnimationFrame(function loop(){ requestAnimationFrame(loop); }); }
</script>`;

		const result = checkPage("game.html", page, { frames: 3 });

		expect(result.ok).toBe(true);
		expect(result.started).toBe(true);
	});

	// Two different failures that used to share one message. A file truncated
	// above its script is destroyed; a file whose script was never closed lost
	// its trailing tags in an edit, and the fix is not the same.
	it("tells a missing script apart from an unclosed one", () => {
		expect(checkPage("page.html", "<html><body>hi</body></html>").error).toBe(
			"no script blocks",
		);
		expect(checkPage("page.html", "<script>const x = 1;").error).toContain(
			"unclosed <script>",
		);
	});

	it("checks a plain script file without asking it for frames", () => {
		expect(checkPage("app.js", "const x = 1;").ok).toBe(true);
		expect(checkPage("app.js", "const x = ;").ok).toBe(false);
	});

	it("swallows the drawing a page does rather than failing on it", () => {
		const page = `<script>
const ctx = document.createElement("canvas").getContext("2d");
ctx.fillStyle = "#fff";
const w = ctx.measureText("score").width * ctx.globalAlpha;
ctx.createLinearGradient(0, 0, 1, 1).addColorStop(0, "#000");
new AudioContext().createOscillator().frequency.setValueAtTime(440, 0);
requestAnimationFrame(function loop(){ ctx.fillRect(0, 0, w, 1); requestAnimationFrame(loop); });
</script>`;

		expect(checkPage("game.html", page, { frames: 3 }).ok).toBe(true);
	});
});
