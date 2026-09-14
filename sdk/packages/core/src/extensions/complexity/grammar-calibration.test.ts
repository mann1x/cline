/**
 * The same construct, in every language, must cost the same.
 *
 * The node-type sets are shared across grammars, and the header in `walker.ts`
 * once justified that by saying tree-sitter's naming is conventional enough.
 * It is not. Measured before this test existed:
 *
 * ```
 * construct          js   py   go   rs    c  cpp   rb
 * for                 1    1    1    0    1    1    0
 * switch/4 cases      1    0    0    1    9    9    0
 * ```
 *
 * A 20-case switch cost 41 in C and 1 in JavaScript -- an inversion of the one
 * property cognitive complexity is chosen for over cyclomatic. Ruby scored a
 * defined 0 for every control structure it has.
 *
 * So this is a calibration, not a unit test: it scores one construct at a time
 * in every language that ships a grammar, and fails when two disagree. A new
 * grammar, or a grammar that renames a node between versions, lands here
 * rather than silently in a number somebody reads as evidence.
 */

import { describe, expect, it } from "vitest";
import { scoreComplexity } from "./walker";

/** One construct, written once per language, with the cost it must have. */
interface Construct {
	readonly name: string;
	readonly expected: number;
	/** Languages that have no such construct, which is not a disagreement. */
	readonly absentIn?: readonly string[];
	readonly source: Readonly<Record<string, string>>;
}

const FILES: Readonly<Record<string, string>> = {
	js: "x.js",
	ts: "x.ts",
	py: "x.py",
	go: "x.go",
	rs: "x.rs",
	c: "x.c",
	cpp: "x.cpp",
	java: "X.java",
	rb: "x.rb",
	php: "x.php",
	cs: "x.cs",
	kt: "x.kt",
};

const cases = (n: number) =>
	Array.from({ length: n }, (_, i) => `case ${i}: f(); break;`).join("\n");

const CONSTRUCTS: readonly Construct[] = [
	{
		name: "a single if",
		expected: 1,
		source: {
			js: "if (a) { f(); }",
			ts: "if (a) { f(); }",
			py: "if a:\n    f()",
			go: "package m\nfunc g(){ if a { f() } }",
			rs: "fn g(){ if a { f(); } }",
			c: "int g(){ if(a){ f(); } return 0; }",
			cpp: "int g(){ if(a){ f(); } return 0; }",
			java: "class X { void g(){ if(a){ f(); } } }",
			rb: "if a\n  f\nend",
			php: "<?php if ($a) { f(); }",
			cs: "class X { void g(){ if(a){ f(); } } }",
			kt: "fun g(){ if (a) { f() } }",
		},
	},
	{
		name: "a single loop",
		expected: 1,
		source: {
			js: "for (const x of xs) { f(); }",
			ts: "for (const x of xs) { f(); }",
			py: "for x in xs:\n    f()",
			go: "package m\nfunc g(){ for i := range xs { f() } }",
			rs: "fn g(){ for x in xs { f(); } }",
			c: "int g(){ for(int i=0;i<n;i++){ f(); } return 0; }",
			cpp: "int g(){ for(auto& x : xs){ f(); } return 0; }",
			java: "class X { void g(){ for(String s : xs){ f(); } } }",
			rb: "for x in xs\n  f\nend",
			php: "<?php foreach ($xs as $x) { f(); }",
			cs: "class X { void g(){ foreach(var x in xs){ f(); } } }",
			kt: "fun g(){ for (x in xs) { f() } }",
		},
	},
	{
		name: "a single while",
		expected: 1,
		source: {
			js: "while (a) { f(); }",
			ts: "while (a) { f(); }",
			py: "while a:\n    f()",
			go: "package m\nfunc g(){ for a { f() } }",
			rs: "fn g(){ while a { f(); } }",
			c: "int g(){ while(a){ f(); } return 0; }",
			cpp: "int g(){ while(a){ f(); } return 0; }",
			java: "class X { void g(){ while(a){ f(); } } }",
			rb: "while a\n  f\nend",
			php: "<?php while ($a) { f(); }",
			cs: "class X { void g(){ while(a){ f(); } } }",
			kt: "fun g(){ while (a) { f() } }",
		},
	},
	{
		// The property the whole metric is chosen for: a flat switch is one
		// decision to follow however many arms it has. This is the case that
		// cost 41 in C.
		name: "a flat switch with four arms",
		expected: 1,
		source: {
			js: `switch(k){${cases(4)}}`,
			ts: `switch(k){${cases(4)}}`,
			py: "match k:\n    case 1:\n        f()\n    case 2:\n        f()\n    case 3:\n        f()\n    case 4:\n        f()",
			go: "package m\nfunc g(){ switch k { case 1: f()\ncase 2: f()\ncase 3: f()\ncase 4: f() } }",
			rs: "fn g(){ match k { 1=>f(), 2=>f(), 3=>f(), 4=>f(), _=>() } }",
			c: `int g(){ switch(k){${cases(4)}} return 0; }`,
			cpp: `int g(){ switch(k){${cases(4)}} return 0; }`,
			java: `class X { void g(){ switch(k){${cases(4)}} } }`,
			rb: "case k\nwhen 1 then f\nwhen 2 then f\nwhen 3 then f\nwhen 4 then f\nend",
			php: `<?php switch ($k) { ${cases(4)} }`,
			cs: `class X { void g(){ switch(k){${cases(4)}} } }`,
			kt: "fun g(){ when (k) { 1 -> f()\n2 -> f()\n3 -> f()\n4 -> f() } }",
		},
	},
	{
		name: "catching an error",
		expected: 1,
		source: {
			js: "try { f(); } catch (e) { g(); }",
			ts: "try { f(); } catch (e) { g(); }",
			py: "try:\n    f()\nexcept E:\n    g()",
			go: "",
			rs: "",
			c: "",
			cpp: "int g(){ try { f(); } catch(...) { h(); } return 0; }",
			java: "class X { void g(){ try { f(); } catch(Exception e){ h(); } } }",
			rb: "begin\n  f\nrescue => e\n  g\nend",
			php: "<?php try { f(); } catch (E $e) { h(); }",
			cs: "class X { void g(){ try { f(); } catch(Exception e){ h(); } } }",
			kt: "fun g(){ try { f() } catch (e: Exception) { h() } }",
		},
		// No exceptions in these languages at all.
		absentIn: ["go", "rs", "c"],
	},
	{
		// Nesting is the half cyclomatic complexity misses, and it has to
		// accumulate at the same rate everywhere.
		name: "three levels of nesting",
		expected: 6,
		source: {
			js: "function g(xs){ for (const x of xs) { if (x) { while (x.n) { x.n--; } } } }",
			ts: "function g(xs: number[]){ for (const x of xs) { if (x) { while (x) { break; } } } }",
			py: "def g(xs):\n    for x in xs:\n        if x:\n            while x.n:\n                x.n -= 1",
			go: "package m\nfunc g(xs []int) { for i := range xs { if xs[i] > 0 { for xs[i] > 0 { xs[i]-- } } } }",
			rs: "fn g(xs: &mut Vec<i32>) { for x in xs.iter_mut() { if *x > 0 { while *x > 0 { *x -= 1; } } } }",
			c: "int g(int* xs,int n){ for(int i=0;i<n;i++){ if(xs[i]){ while(xs[i]){ xs[i]--; } } } return 0; }",
			cpp: "int g(int* xs,int n){ for(int i=0;i<n;i++){ if(xs[i]){ while(xs[i]){ xs[i]--; } } } return 0; }",
			java: "class X { void g(int[] xs){ for(int i=0;i<xs.length;i++){ if(xs[i]>0){ while(xs[i]>0){ xs[i]--; } } } } }",
			rb: "for x in xs\n  if x\n    while x.n\n      x.n -= 1\n    end\n  end\nend",
			php: "<?php foreach ($xs as $x) { if ($x) { while ($x) { break; } } }",
			cs: "class X { void g(){ foreach(var x in xs){ if(x>0){ while(x>0){ x--; } } } } }",
			kt: "fun g(){ for (x in xs) { if (x > 0) { while (x > 0) { break } } } }",
		},
	},
];

describe("the same construct costs the same in every language", () => {
	for (const construct of CONSTRUCTS) {
		const absent = new Set(construct.absentIn ?? []);
		for (const [language, file] of Object.entries(FILES)) {
			if (absent.has(language)) {
				continue;
			}
			it(`${construct.name}: ${language}`, async () => {
				const score = await scoreComplexity(
					file,
					construct.source[language] ?? "",
				);
				// `undefined` is a grammar that would not load, which is a real
				// failure here even though it is silence in production: this
				// suite exists to measure, and a language it cannot measure is
				// one it cannot calibrate.
				expect(score?.score).toBe(construct.expected);
			});
		}
	}
});

/**
 * The inversion, stated as its own case because it is the reason for all of
 * the above: cognitive complexity is chosen over cyclomatic precisely because
 * a twenty-arm switch is easy to read and three nested conditionals are not.
 */
describe("a wide switch stays cheap and depth stays expensive", () => {
	it("charges a twenty-arm switch once, in C as in JavaScript", async () => {
		const c = await scoreComplexity(
			"x.c",
			`int g(int k){ switch(k){\n${cases(20)}\n} return 0; }`,
		);
		const js = await scoreComplexity(
			"x.js",
			`function g(k){ switch(k){\n${cases(20)}\n} }`,
		);

		expect(c?.score).toBe(1);
		expect(js?.score).toBe(1);
	});

	it("charges three levels of nesting more than twenty flat arms", async () => {
		const wide = await scoreComplexity(
			"x.c",
			`int g(int k){ switch(k){\n${cases(20)}\n} return 0; }`,
		);
		const deep = await scoreComplexity(
			"x.c",
			"int g(int* xs,int n){ for(int i=0;i<n;i++){ if(xs[i]){ while(xs[i]){ xs[i]--; } } } return 0; }",
		);

		expect(deep?.score).toBeGreaterThan((wide?.score ?? 0) * 5);
	});
});
