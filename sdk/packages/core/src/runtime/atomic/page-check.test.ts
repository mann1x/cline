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
	// Each of these runs in a browser, and each was failed here: the stub had
	// no window listeners, ran an interval loop as nothing, and executed every
	// <script> block as JavaScript. A false failure sends the model to fix code
	// that works.
	describe("pages a browser runs", () => {
		const LOOP =
			"let ticks = 0; function loop(){ ticks += 1; requestAnimationFrame(loop); }";

		it("starts a page from window.onload", () => {
			const page = `<script>${LOOP} window.onload = () => loop();</script>`;
			expect(checkPage("game.html", page, { frames: 3 }).ok).toBe(true);
		});

		it("starts a page from a load listener on window", () => {
			const page = `<script>${LOOP} window.addEventListener("load", () => loop());</script>`;
			expect(checkPage("game.html", page, { frames: 3 }).ok).toBe(true);
		});

		it("starts a page from DOMContentLoaded", () => {
			const page = `<script>${LOOP} document.addEventListener("DOMContentLoaded", loop);</script>`;
			expect(checkPage("game.html", page, { frames: 3 }).ok).toBe(true);
		});

		it("runs a game loop driven by setInterval", () => {
			const page = `<script>let ticks = 0; setInterval(() => { ticks += 1; }, 16);</script>`;
			const result = checkPage("game.html", page, { frames: 4 });
			expect(result.ok).toBe(true);
			expect(result.framesRun).toBe(4);
		});

		it("leaves a JSON data block alone", () => {
			const page = `<script type="application/json" id="level">{"rows": 3}</script>${WORKING}`;
			expect(checkPage("game.html", page, { frames: 2 }).ok).toBe(true);
		});

		it("still fails a page that throws while starting from onload", () => {
			const page = `<script>window.onload = () => { startLevel(); };</script>`;
			const result = checkPage("game.html", page);
			expect(result.ok).toBe(false);
			expect(result.unchecked).toBeUndefined();
			expect(result.error).toContain("load: ReferenceError");
		});

		it("still fails a page whose interval throws", () => {
			const page = `<script>setInterval(() => { player.x += 1; }, 16);</script>`;
			const result = checkPage("game.html", page);
			expect(result.ok).toBe(false);
			expect(result.error).toContain("frame 0: ReferenceError");
		});
	});

	// Not run is not failed: neither verdict may be claimed about it.
	describe("module scripts", () => {
		it("says a module page was not checked rather than that it failed", () => {
			const page = `<script type="module">import { start } from "./game.js"; start();</script>`;
			const result = checkPage("game.html", page);
			expect(result.ok).toBe(false);
			expect(result.unchecked).toBe(true);
			expect(result.error).toContain("cannot run");
		});

		it("says the same of an ES module script file", () => {
			const result = checkPage(
				"game.js",
				'import { a } from "./a.js";\nexport const b = a;\n',
			);
			expect(result.unchecked).toBe(true);
		});
	});
});

// automaticum audit 2026-11-08, B7 and B8: each case is the audit's repro.
describe("checkPage audit 2026-11-08", () => {
	const page = (js: string, attributes = "") =>
		`<html><body><canvas id="c"></canvas>\n<script${attributes}>\n${js}\n</script></body></html>`;
	const loop = "function loop(){requestAnimationFrame(loop);}";

	it("fails a game that catches its error and logs it every frame (P4)", () => {
		const result = checkPage(
			"g.html",
			page(
				`function loop(){ try { undefinedFn(); } catch (e) { console.error(e); } requestAnimationFrame(loop); }\nrequestAnimationFrame(loop);`,
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/console\.error in frame 0: ReferenceError/);
	});

	it("reaches past the first second of frames (P5)", () => {
		const result = checkPage(
			"g.html",
			page(
				`let n = 0;\nfunction loop(){ n += 1; if (n === 31) player.move(); requestAnimationFrame(loop); }\nrequestAnimationFrame(loop);`,
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/frame 30: ReferenceError: player/);
	});

	it("does not count one setTimeout as a running page (P6)", () => {
		const result = checkPage("g.html", page("setTimeout(() => {}, 100);"));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/one setTimeout ran/);
	});

	it("passes a page whose loop is a recurring setTimeout", () => {
		const result = checkPage(
			"g.html",
			page("function tick(){ setTimeout(tick, 16); }\ntick();"),
		);
		expect(result.ok).toBe(true);
		expect(result.timeoutsRun).toBeGreaterThan(1);
	});

	it("fails a module script that does not parse instead of leaving it unchecked (P9)", () => {
		const result = checkPage(
			"g.html",
			page(`function never(){ return a +; }\n${loop}loop();`, ' type="module"'),
		);
		expect(result.unchecked).toBeUndefined();
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/SyntaxError.*line 3, column 29/);
	});

	it("starts a game that waits for a key (P10)", () => {
		const result = checkPage(
			"g.html",
			page(
				`${loop}document.addEventListener('keydown', () => loop(), { once: true });`,
			),
		);
		expect(result.ok).toBe(true);
		expect(result.started).toBe(true);
	});

	it("fires load listeners registered on an element", () => {
		const result = checkPage(
			"g.html",
			page(
				`${loop}document.getElementById("c").addEventListener("click", () => loop());`,
			),
		);
		expect(result.ok).toBe(true);
	});

	it("bounds a frame that never returns instead of hanging", () => {
		const started = Date.now();
		const result = checkPage(
			"g.html",
			page("function loop(){ while (true) {} }\nrequestAnimationFrame(loop);"),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/timed out/i);
		expect(Date.now() - started).toBeLessThan(60_000);
	}, 70_000);
});
