import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	describeDelimiterBalance,
	findScriptSyntaxError,
	scanDelimiters,
} from "./delimiter-balance";
import { createEditorExecutor } from "./executors/editor";
import { createReadReceipts } from "./executors/read-receipts";

describe("scanDelimiters", () => {
	it("says nothing about balanced code", () => {
		expect(scanDelimiters("function f(a){ return [a, {b: 1}] }")).toEqual([]);
	});

	it("names the opener a crossed closer belongs to", () => {
		// `{` opened at column 14 is closed by `)`.
		const [finding] = scanDelimiters("function f(){ if (a) { b(); ) }");
		expect(finding).toMatchObject({
			kind: "mismatch",
			opener: "{",
			openColumn: 22,
			found: ")",
			column: 29,
		});
	});

	it("reports a closer with nothing open", () => {
		expect(scanDelimiters("a();)")).toEqual([
			{ kind: "unmatched-close", line: 1, column: 5, found: ")" },
		]);
	});

	it("records what was still open around a crossing, innermost first", () => {
		const [finding] = scanDelimiters(
			"class A {\n  m(){ this.each(d=>{ if(d){ go(); ) } }) }\n}\n",
		);
		expect(finding?.enclosing).toEqual([
			{ opener: "{", line: 2, column: 21 },
			{ opener: "(", line: 2, column: 17 },
			{ opener: "{", line: 2, column: 6 },
			{ opener: "{", line: 1, column: 9 },
		]);
	});

	it("reports an opener that is never closed", () => {
		const [finding] = scanDelimiters("function f(){\n  if (a) {\n}\n");
		expect(finding).toMatchObject({
			kind: "unclosed",
			opener: "{",
			openLine: 1,
			openColumn: 13,
		});
	});

	it("ignores brackets inside strings, comments and regexes", () => {
		const source = [
			'const a = "}}}"',
			"const b = '((('",
			"// ]]] not code",
			"/* {{{ still not code */",
			"const c = /[{(]/.test(x)",
		].join("\n");
		expect(scanDelimiters(source)).toEqual([]);
	});

	it("follows a template literal back out of its substitution", () => {
		// The tail after `}` is prose, not code: a lone quote or brace there
		// must not flip the scanner into a string. This is the case that made
		// the scanner disagree with `node --check` on a real file.
		const source = [
			"const s = `count ${n} isn't ${m} done`",
			"function f(){ return 1 }",
		].join("\n");
		expect(scanDelimiters(source)).toEqual([]);
	});

	it("handles nested substitutions and braces inside them", () => {
		expect(scanDelimiters("const s = `${ {a: `${b}`}.a }`")).toEqual([]);
	});

	it("counts lines and columns from an origin", () => {
		const [finding] = scanDelimiters("a(]", { line: 30, column: 5 });
		expect(finding).toMatchObject({ line: 30, column: 7, found: "]" });
	});
});

describe("describeDelimiterBalance", () => {
	it("returns nothing for a language it does not understand", () => {
		expect(describeDelimiterBalance("notes.md", "# heading ) ) )")).toBeNull();
	});

	it("returns nothing for JSX, which it cannot parse", () => {
		// A false report sends a model to edit a line that was correct, so
		// .tsx is excluded outright rather than guessed at.
		expect(
			describeDelimiterBalance(
				"View.tsx",
				"const V = () => <div a={1}>{x}</div>",
			),
		).toBeNull();
	});

	it("returns nothing when a file balances", () => {
		expect(
			describeDelimiterBalance(
				"app.ts",
				"export function f(){ return {a: [1]} }",
			),
		).toBeNull();
	});

	it("reports the crossing in a .ts file", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) }",
		);
		expect(report).toContain("Delimiter scan");
		// The line the edit goes on leads; the crossing that found it follows.
		expect(report).toContain("line 1: ");
		expect(report).toContain(
			"the `)` at column 29 that follows …` (a) { b(); ` comes while the `{` at column 22 that follows …`f(){ if (a) ` is still open, both on line 1",
		);
	});

	it("names every line that does not balance, not just the first", () => {
		// Measured: a real file had five separately broken lines, each a
		// minified one-liner ending `}})` where it should end `});`. Reporting
		// two of them sent the model round the loop — edit, reload, read, edit —
		// once per line, and it fixed a line the report had not named.
		const source = [
			"<script>",
			"a.forEach(p=>{if(p){x();}})}",
			"b.forEach(p=>{if(p){y();}})}",
			"c.forEach(p=>{if(p){z();}})}",
			"</script>",
		].join("\n");

		const report = describeDelimiterBalance("game.html", source);

		expect(report).toContain("line(s) do not balance");
		expect(report).toContain("line 2");
		expect(report).toContain("line 3");
		expect(report).toContain("line 4");
	});

	it("reports one line once, however many crossings it holds", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) } ) }",
		);
		const named = (report ?? "")
			.split("\n")
			.filter((line) => line.startsWith("  line "));
		expect(named).toHaveLength(1);
	});

	it("keeps the singular heading when only one line is at fault", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) }",
		);
		expect(report).toContain(
			"Delimiter scan of the whole file, read from line 1:",
		);
		expect(report).toContain("edit the line named above");
	});

	it("leads with the line and the tally, not with the crossing", () => {
		// Measured, and the reason this order exists. Led by the crossing, the
		// report read "the `(` opened at line 90, column 30 is closed by `}` at
		// line 90, column 382; counting only code, this line has 1 more `}`
		// than `{`". The model quoted that first clause and spent six turns —
		// four of them ending at the thinking budget — trying to work out how a
		// `(` could be closed by a `}`, while the half that told it what to
		// change sat behind a semicolon.
		const report = describeDelimiterBalance(
			"app.js",
			"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
		);
		const named = (report ?? "")
			.split("\n")
			.find((line) => line.startsWith("  line "));
		expect(named).toBe(
			"  line 1: counting only code, this line has 1 more `}` than `{` (the `}` at column 48 that follows …`{c.fill();}}` comes while the `(` at column 26 that follows …`s.dc.forEach` is still open, both on line 1)",
		);
	});

	it("quotes each bracket so it is found by its text, not by counting", () => {
		// Measured, pandorum 2026-10-23: told the `(` at column 30 was still
		// open, a model counted the line by hand, reached the `(` at column 5,
		// found it balanced and decided the scan was counting some other line.
		// The quote names which `(` it is.
		const report = describeDelimiterBalance(
			"app.js",
			"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
		);
		expect(report).toContain(
			"the `(` at column 26 that follows …`s.dc.forEach`",
		);
		expect(report).not.toContain("column 5");
	});

	it("gives both lines when a crossing spans two", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f() {\n  g(1, 2;\n}\n",
		);
		expect(report).toMatch(
			/the `\}` at line 3, column 1, which starts the line, comes while the `\(` at line 2, column 4 that follows ` {2}g` is still open/,
		);
		expect(report).not.toContain("both on line");
	});

	it("scans script bodies in HTML at their real line numbers", () => {
		const html = [
			"<!DOCTYPE html>",
			"<body>",
			"<script>",
			"function f(){ g(); ) }",
			"</script>",
			"</body>",
		].join("\n");
		const report = describeDelimiterBalance("game.html", html);
		expect(report).toContain("line 4");
	});

	it("skips a script element that only references a source file", () => {
		const html = ['<script src="game.js"></script>', "<p>)))</p>"].join("\n");
		expect(describeDelimiterBalance("game.html", html)).toBeNull();
	});

	/**
	 * The counts are what make the report an instruction rather than a
	 * description. A model told only that two brackets cross sent back the line
	 * it already had, twelve times; the line held one `}` more than it opened.
	 */
	describe("surplus counts", () => {
		it("names the surplus when a crossing starts and ends on one line", () => {
			// `dPw(){...}}` — one closing brace too many, all on line 1.
			const report = describeDelimiterBalance(
				"app.js",
				"function dPw(c){ if (c) { c(); }}}\n",
			);
			expect(report).toContain("1 more `}` than `{`");
			// The count is a fact; which brace is the spare one is not.
			expect(report).not.toContain("that is the edit");
			expect(report).toContain(
				"Brackets cannot tell which block was meant to close",
			);
		});

		it("says a crossed line that balances is out of order, not short", () => {
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain("balance in number");
			expect(report).toContain("wrong place");
		});

		it("says nothing about counts for a block left open across lines", () => {
			// Ordinary code: line 1 opens a brace it does not close. That is not
			// a surplus, and calling it one would send an edit to a correct line.
			const report = describeDelimiterBalance(
				"app.js",
				"function f() {\n  g();\n)\n",
			);
			expect(report).not.toContain("counting only code");
		});

		it("counts only code, not brackets inside strings", () => {
			const report = describeDelimiterBalance(
				"app.js",
				'function f(){ s = "}}}}"; }}\n',
			);
			expect(report).toContain("1 more `}` than `{`");
		});
	});

	/**
	 * Which brackets cross is the easy half. Whether to delete one, add one or
	 * move one is the half the model pays for: one measured turn spent 33,350
	 * tokens deciding between a swap and a deletion on a 500-column line, hit
	 * the thinking budget mid-sentence, and had picked the wrong one anyway —
	 * the run that fixed that file deleted a brace. A scan is microseconds, so
	 * the edit is tried and re-scanned rather than reasoned about.
	 */
	describe("a checked repair", () => {
		it("names the edit that clears the line", () => {
			// The shape from the file this was measured on, reduced. The run that
			// fixed it made exactly this edit.
			const report = describeDelimiterBalance(
				"app.js",
				"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
			);
			expect(report).toContain("delete the `}` at column 48 — checked");
			expect(report).toContain("nothing else in this file crosses after that");
		});

		it("gives the edit as arguments the editor takes, not as text to match", () => {
			// Measured: told to delete the `}` at column 382, the model restated
			// that correctly and then composed an `old_text` for a 500-column
			// minified line, which came back "No replacement performed: text not
			// found". The editor addresses a character directly; so does this.
			const report = describeDelimiterBalance(
				"app.js",
				"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
			);
			expect(report).toContain(
				'`editor` with start_line: 1, start_column: 48, new_text: ""',
			);
			expect(report).toContain("there is no text to match on");
		});

		it("orders a move so the deletion accounts for the insert's shift", () => {
			// Insert first at column 12, which pushes the `)` from 13 to 14.
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain(
				'insert_line: 1, insert_column: 12, new_text: ")"',
			);
			expect(report).toContain('start_line: 1, start_column: 14, new_text: ""');
		});

		it("moves a closer to the end of a line, and never past it", () => {
			// pandorum, 2026-10-18 (e97h3): `update()` with line 111's `)` one
			// `}` too early. The line is 388 columns long; the scan said "to
			// column 393", which was on the line below.
			const update =
				"function update(){\nif(gameOverFlag)return;\nif(gameState==='COUNTDOWN'){const now=performance.now();if(now-lastCountdownUpdate>=1000){countdownTimer--;statusEl.innerText=countdownTimer>0?`${countdownTimer}...`:'GO!';statusEl.style.color='#ff8800';lastCountdownUpdate=now;if(countdownTimer<=0){gameState='PLAYING';statusEl.innerText='';player.grounded=true;}}return;}\nif(gameState==='LEVEL_COMPLETE'){transitionTimer--;if(transitionTimer<=0){if(currentLevel>=20){gameOverFlag=true;goOverlay.style.display='flex';document.getElementById('go-title').innerText='YOU WIN!';document.getElementById('go-score').innerText=`Final Score: ${player.score}`;return;}gameState='SHOW_STARTING_MSG';levelMsgEl.style.display='block';levelMsgEl.innerText=`CAVERN ${currentLevel+1} STARTING, ARE YOU READY?`;transitionTimer=90;}return;}\nif(gameState==='SHOW_STARTING_MSG'){transitionTimer--;if(transitionTimer<=0){levelMsgEl.style.display='none';gameState='COUNTDOWN';countdownTimer=3;lastCountdownUpdate=performance.now();}return;}\nplayer.frameCount++;player.vy+=.45;if(player.vy>8)player.vy=8;player.vx*=.92;if(Math.abs(player.vx)<.1)player.vx=0;player.grounded=false;const nx=player.x+player.vx;if(!collide(nx,player.y,player.width,player.height))player.x=nx;else player.vx=0;const ny=player.y+player.vy;if(!collide(player.x,ny,player.width,player.height)){player.y=ny;}else{if(player.vy>0)player.grounded=true;player.vy=0;}if(player.x<0){player.x=0;player.vx=0;}if(player.x>currentLevelObj.width*TILE_SIZE-player.width){player.x=currentLevelObj.width*TILE_SIZE-player.width;}\nif(keys.u&&player.grounded){player.vy=-9;player.grounded=false;sound.playJump();}\nif(keys.l)player.vx-=.6;if(player.vx<-5)player.vx=-5;\nif(keys.r)player.vx+=.6;if(player.vx>5)player.vx=5;\ncurrentLevelObj.it.forEach(it=>{if(!it.cl&&Math.abs(player.x+player.width/2-it.x)<16&&Math.abs(player.y+player.height/2-it.y)<16){it.cl=true;player.score+=it.pt;sound.collectGem();}});\ncurrentLevelObj.o2c.forEach(o=>{if(!o.cl&&Math.abs(player.x+player.width/2-o.x)<14&&Math.abs(player.y+player.height/2-o.y)<14){o.cl=true;player.o2=Math.min(100,player.o2+o.ra);sound.collectO2();}});\ncurrentLevelObj.pw.forEach(p=>{if(!p.cl&&Math.abs(player.x+player.width/2-p.x)<14&&Math.abs(player.y+player.height/2-p.y)<14){p.cl=true;player.isSuper=true;player.powerupTimer=300;sound.powerup();}});\ncurrentLevelObj.en.forEach(e=>{if(e.al){e.x+=e.vx;e.fc++;if(e.x<TILE_SIZE||e.x>(currentLevelObj.width-2)*TILE_SIZE)e.vx*=-1;const ex=e.x+10,ey=e.y+6;if(Math.abs(player.x+player.width/2-ex)<18&&Math.abs(player.y+player.height/2-ey)<18){if(!player.isSuper){player.o2-=15;sound.hitEnemy();player.vy=-5;player.vx=(player.x<e.x)?-3:3;}else{e.al=false;player.score+=25;sound.collectGem();}}});}\nif(currentLevelObj.bs&&currentLevelObj.boss&&currentLevelObj.boss.ac){const b=currentLevelObj.boss;b.x+=b.vx;if(b.x<currentLevelObj.width*TILE_SIZE/2||b.x>(currentLevelObj.width-5)*TILE_SIZE)b.vx*=-1;const bx=b.x,by=b.y;if(Math.abs(player.x+player.width/2-bx)<25&&Math.abs(player.y+player.height/2-by)<30){if(!player.isSuper){player.o2-=10;sound.hitEnemy();player.vy=-6;}else{b.hp--;if(b.hp<=0){b.ac=false;player.score+=100+currentLevel*10;gameState='LEVEL_COMPLETE';transitionTimer=120;sound.levelComplete();}else sound.collectGem();}}}\nif(player.isSuper){player.powerupTimer--;if(player.powerupTimer<=0){player.isSuper=false;player.powerupTimer=0;}}\ncamera.x=Math.max(0,Math.min(player.x-VIEWPORT_W/2,currentLevelObj.width*TILE_SIZE-VIEWPORT_W));\nif(player.x>(currentLevelObj.width-8)*TILE_SIZE){gameState='LEVEL_COMPLETE';transitionTimer=120;player.score+=currentLevel*50;sound.levelComplete();}\nscoreEl.innerText=player.score;cavernEl.innerText=currentLevel;o2El.innerText=`${Math.max(0,~~(player.o2))}%`;\nclouds.forEach(c=>c.update());\n}\n";
			const report = describeDelimiterBalance("app.js", update) ?? "";
			const width = update.split("\n")[12]?.length ?? 0;
			expect(width).toBe(388);
			expect(report).toContain(
				"move the `)` at column 386 to column 389 — checked",
			);
			expect(report).toContain(
				'insert_line: 13, insert_column: 389, new_text: ")"',
			);
			for (const match of report.matchAll(/column (\d+)/g)) {
				expect(Number(match[1])).toBeLessThanOrEqual(width + 1);
			}
		});

		it("proposes a move when the line balances and a closer is misplaced", () => {
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain(
				"move the `)` at column 13 to column 12 — checked",
			);
		});

		it("says what is left over when the file has more than one fault", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"function f(){ if (a) { b(); ) } ) }\n",
			);
			expect(report).toContain("replace the `)` at column 29 with `}`");
			expect(report).toContain(
				"leaves 2 of the 3 crossings, all further down the file",
			);
		});

		it("gives the enclosing chain when no single edit clears it", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"function f(){\n  if (a) {\n    b();\n)\n",
			);
			expect(report).toContain("a `}` is what belongs at column 1");
			expect(report).toContain(
				"no single-character edit clears it, and still open there, innermost first: `{` 1:13",
			);
		});

		it("does not claim a search it never ran on a file too big to search", () => {
			const big = `function f(){ if (a) { b(); ) }\n${"// filler\n".repeat(20_000)}`;
			const report = describeDelimiterBalance("big.js", big);
			expect(report).not.toContain("no single-character edit clears it");
			expect(report).toContain("Still open there, innermost first");
		});

		it("says it about the first line only, whatever else is broken", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"f(){ a(); ) }\ng(){ b(); ) }\nh(){ c(); ) }\n",
			);
			const checked = (report ?? "")
				.split("\n")
				.filter((line) => line.includes("— checked"));
			expect(checked).toHaveLength(1);
		});
	});
});

describe("findScriptSyntaxError", () => {
	// The exact shape a run left on disk: a `;` where the argument list wanted
	// its `)`. The browser said nothing about it, so a parser has to.
	it("finds a broken script inside a page", () => {
		const html =
			"<body><script>\nfoo.forEach(e=>{if(e){bar();}};\n});\n</script></body>";

		expect(findScriptSyntaxError("game.html", html)).toContain("SyntaxError");
	});

	it("says nothing about a page whose scripts parse", () => {
		const html =
			"<body><script>\nfoo.forEach(e=>{if(e){bar();}});\n</script></body>";

		expect(findScriptSyntaxError("game.html", html)).toBeUndefined();
	});

	it("says nothing about a page with no script at all", () => {
		expect(
			findScriptSyntaxError("page.html", "<body><p>hi</p></body>"),
		).toBeUndefined();
	});

	// A module body is parsed under different rules -- `import` is a syntax
	// error in a function body -- so reporting on one would be reporting the
	// checker's own limitation as the page's fault.
	it("leaves module scripts to the browser", () => {
		const html =
			'<body><script type="module">\nimport x from "./x.js";\n</script></body>';

		expect(findScriptSyntaxError("page.html", html)).toBeUndefined();
	});

	it("checks a plain script file directly", () => {
		expect(
			findScriptSyntaxError("app.js", "function f(){ return 1; }"),
		).toBeUndefined();
		expect(
			findScriptSyntaxError("app.js", "function f({ return 1; }"),
		).toContain("SyntaxError");
	});

	// Only where a classic-script parse is the right question. A .ts file is
	// not JavaScript, and a report on one would be noise.
	it("declines a language it does not parse", () => {
		expect(
			findScriptSyntaxError("app.ts", "const x: number = ;"),
		).toBeUndefined();
		expect(findScriptSyntaxError("styles.css", "a { color")).toBeUndefined();
	});
});

/**
 * The same defect as above, on the line endings the host actually writes.
 *
 * The bound the scan now enforces is measured against a `\n` split
 * (`delimiter-balance.ts:485`), so on a CRLF file every line keeps its `\r` and
 * counts one column wider than the line the editor sees — `editor.ts:1604`
 * splits on `/\r\n|\n/`. The prescription shifts with it, and `insertAtColumn`
 * refuses the call the report called "checked" (`editor.ts:1691`). pandorum is
 * a Windows machine, so this is the ending the benchmark file arrives with.
 */
describe("a checked repair against the editor's own bounds", () => {
	// pandorum, 2026-10-18 (e97h3): `update()` with line 111's `)` one `}` too
	// early. Line 13 here is the same shape at 388 columns.
	const update =
		"function update(){\nif(gameOverFlag)return;\nif(gameState==='COUNTDOWN'){const now=performance.now();if(now-lastCountdownUpdate>=1000){countdownTimer--;statusEl.innerText=countdownTimer>0?`${countdownTimer}...`:'GO!';statusEl.style.color='#ff8800';lastCountdownUpdate=now;if(countdownTimer<=0){gameState='PLAYING';statusEl.innerText='';player.grounded=true;}}return;}\nif(gameState==='LEVEL_COMPLETE'){transitionTimer--;if(transitionTimer<=0){if(currentLevel>=20){gameOverFlag=true;goOverlay.style.display='flex';document.getElementById('go-title').innerText='YOU WIN!';document.getElementById('go-score').innerText=`Final Score: ${player.score}`;return;}gameState='SHOW_STARTING_MSG';levelMsgEl.style.display='block';levelMsgEl.innerText=`CAVERN ${currentLevel+1} STARTING, ARE YOU READY?`;transitionTimer=90;}return;}\nif(gameState==='SHOW_STARTING_MSG'){transitionTimer--;if(transitionTimer<=0){levelMsgEl.style.display='none';gameState='COUNTDOWN';countdownTimer=3;lastCountdownUpdate=performance.now();}return;}\nplayer.frameCount++;player.vy+=.45;if(player.vy>8)player.vy=8;player.vx*=.92;if(Math.abs(player.vx)<.1)player.vx=0;player.grounded=false;const nx=player.x+player.vx;if(!collide(nx,player.y,player.width,player.height))player.x=nx;else player.vx=0;const ny=player.y+player.vy;if(!collide(player.x,ny,player.width,player.height)){player.y=ny;}else{if(player.vy>0)player.grounded=true;player.vy=0;}if(player.x<0){player.x=0;player.vx=0;}if(player.x>currentLevelObj.width*TILE_SIZE-player.width){player.x=currentLevelObj.width*TILE_SIZE-player.width;}\nif(keys.u&&player.grounded){player.vy=-9;player.grounded=false;sound.playJump();}\nif(keys.l)player.vx-=.6;if(player.vx<-5)player.vx=-5;\nif(keys.r)player.vx+=.6;if(player.vx>5)player.vx=5;\ncurrentLevelObj.it.forEach(it=>{if(!it.cl&&Math.abs(player.x+player.width/2-it.x)<16&&Math.abs(player.y+player.height/2-it.y)<16){it.cl=true;player.score+=it.pt;sound.collectGem();}});\ncurrentLevelObj.o2c.forEach(o=>{if(!o.cl&&Math.abs(player.x+player.width/2-o.x)<14&&Math.abs(player.y+player.height/2-o.y)<14){o.cl=true;player.o2=Math.min(100,player.o2+o.ra);sound.collectO2();}});\ncurrentLevelObj.pw.forEach(p=>{if(!p.cl&&Math.abs(player.x+player.width/2-p.x)<14&&Math.abs(player.y+player.height/2-p.y)<14){p.cl=true;player.isSuper=true;player.powerupTimer=300;sound.powerup();}});\ncurrentLevelObj.en.forEach(e=>{if(e.al){e.x+=e.vx;e.fc++;if(e.x<TILE_SIZE||e.x>(currentLevelObj.width-2)*TILE_SIZE)e.vx*=-1;const ex=e.x+10,ey=e.y+6;if(Math.abs(player.x+player.width/2-ex)<18&&Math.abs(player.y+player.height/2-ey)<18){if(!player.isSuper){player.o2-=15;sound.hitEnemy();player.vy=-5;player.vx=(player.x<e.x)?-3:3;}else{e.al=false;player.score+=25;sound.collectGem();}}});}\nif(currentLevelObj.bs&&currentLevelObj.boss&&currentLevelObj.boss.ac){const b=currentLevelObj.boss;b.x+=b.vx;if(b.x<currentLevelObj.width*TILE_SIZE/2||b.x>(currentLevelObj.width-5)*TILE_SIZE)b.vx*=-1;const bx=b.x,by=b.y;if(Math.abs(player.x+player.width/2-bx)<25&&Math.abs(player.y+player.height/2-by)<30){if(!player.isSuper){player.o2-=10;sound.hitEnemy();player.vy=-6;}else{b.hp--;if(b.hp<=0){b.ac=false;player.score+=100+currentLevel*10;gameState='LEVEL_COMPLETE';transitionTimer=120;sound.levelComplete();}else sound.collectGem();}}}\nif(player.isSuper){player.powerupTimer--;if(player.powerupTimer<=0){player.isSuper=false;player.powerupTimer=0;}}\ncamera.x=Math.max(0,Math.min(player.x-VIEWPORT_W/2,currentLevelObj.width*TILE_SIZE-VIEWPORT_W));\nif(player.x>(currentLevelObj.width-8)*TILE_SIZE){gameState='LEVEL_COMPLETE';transitionTimer=120;player.score+=currentLevel*50;sound.levelComplete();}\nscoreEl.innerText=player.score;cavernEl.innerText=currentLevel;o2El.innerText=`${Math.max(0,~~(player.o2))}%`;\nclouds.forEach(c=>c.update());\n}\n";

	const EDITOR_LINE_WIDTH = 388;
	const FIX_LINE = 13;

	/** The `editor` call the report calls "checked", or null when it named none. */
	function prescribedCall(
		report: string,
	): { line: number; column: number } | null {
		const match = /insert_line: (\d+), insert_column: (\d+)/.exec(report);
		return match ? { line: Number(match[1]), column: Number(match[2]) } : null;
	}

	/** How the editor counts the line, which is the only count that binds. */
	function editorWidth(text: string): number {
		return text.split(/\r\n|\n/)[FIX_LINE - 1]?.length ?? 0;
	}

	/**
	 * Send the prescription through the real executor and return its verdict.
	 *
	 * "Checked" is a claim about what the editor will accept, so the editor is
	 * the only authority on it — not the scanner's own arithmetic.
	 */
	async function send(text: string, column?: number): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "delimiter-bounds-"));
		const filePath = path.join(dir, "app.js");
		await fs.writeFile(filePath, text, "utf-8");
		try {
			const call = prescribedCall(
				describeDelimiterBalance("app.js", text) ?? "",
			);
			expect(call).not.toBeNull();
			const receipts = createReadReceipts();
			receipts.noteRead(filePath, 1, FIX_LINE + 7);
			const editor = createEditorExecutor({ receipts });
			return await editor(
				{
					path: filePath,
					insert_line: call?.line,
					insert_column: column ?? call?.column,
					new_text: ")",
				},
				dir,
				{ agentId: "agent-1", conversationId: "conv-1", iteration: 1 },
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it("names the append position, and the editor takes it, on an LF file", async () => {
		expect(editorWidth(update)).toBe(EDITOR_LINE_WIDTH);
		const report = describeDelimiterBalance("app.js", update) ?? "";
		expect(prescribedCall(report)).toEqual({
			line: FIX_LINE,
			column: EDITOR_LINE_WIDTH + 1,
		});
		await expect(send(update)).resolves.toContain("Inserted 1 character(s)");
	});

	it("names no column the editor refuses on a CRLF file", async () => {
		const crlf = update.replace(/\n/g, "\r\n");
		// The editor splits on /\r\n|\n/, so line 13 is 388 either way.
		expect(editorWidth(crlf)).toBe(EDITOR_LINE_WIDTH);

		const report = describeDelimiterBalance("app.js", crlf) ?? "";
		const call = prescribedCall(report);
		expect(call).not.toBeNull();
		// The scan splits on "\n" and counts the `\r` as a column, so it says 390.
		expect(call?.column).toBeLessThanOrEqual(EDITOR_LINE_WIDTH + 1);
		await expect(send(crlf)).resolves.toContain("Inserted 1 character(s)");
	});

	it("refuses the column the original report named, and no longer names it", async () => {
		// The incident itself: 393 on a 388-column line, four into line 14.
		await expect(send(update, 393)).rejects.toThrow(
			"Invalid insert_column: 393",
		);
		expect(describeDelimiterBalance("app.js", update) ?? "").not.toContain(
			"to column 393",
		);
	});

	it("never names a column past the line it is a column of, on either ending", () => {
		for (const text of [update, update.replace(/\n/g, "\r\n")]) {
			const report = describeDelimiterBalance("app.js", text) ?? "";
			for (const match of report.matchAll(/insert_column: (\d+)/g)) {
				expect(Number(match[1])).toBeLessThanOrEqual(editorWidth(text) + 1);
			}
		}
	});
});
