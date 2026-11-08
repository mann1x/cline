import { describe, expect, it } from "vitest";
import { compilePosixRegex, posixToJsSource } from "./posix-regex";

describe("BRE, the dialect grep and sed default to", () => {
	// The failure this prevents is silent: `a+` is a literal in BRE and a
	// quantifier in ERE, and neither dialect errors on the other's spelling.
	it("treats +, ?, (, ), {, } and | as literal characters", () => {
		expect(compilePosixRegex("a+").test("a+")).toBe(true);
		expect(compilePosixRegex("a+").test("aa")).toBe(false);
		expect(compilePosixRegex("a|b").test("a|b")).toBe(true);
		expect(compilePosixRegex("a|b").test("a")).toBe(false);
		expect(compilePosixRegex("x(y)").test("x(y)")).toBe(true);
	});

	it("gives the escaped forms their special meaning", () => {
		expect(compilePosixRegex("a\\+").test("aaa")).toBe(true);
		expect(compilePosixRegex("a\\|b").test("b")).toBe(true);
		expect(compilePosixRegex("\\(ab\\)\\{2\\}").test("abab")).toBe(true);
		expect(compilePosixRegex("\\(ab\\)\\{2\\}").test("ab")).toBe(false);
	});

	it("keeps backreferences working", () => {
		expect(compilePosixRegex("\\(foo\\)bar\\1").test("foobarfoo")).toBe(true);
	});
});

describe("ERE, the dialect grep -E, sed -E and awk use", () => {
	const ere = { extended: true };

	it("treats +, ?, (, ) and | as operators", () => {
		expect(compilePosixRegex("a+", ere).test("aaa")).toBe(true);
		expect(compilePosixRegex("a|b", ere).test("b")).toBe(true);
		expect(compilePosixRegex("(ab){2}", ere).test("abab")).toBe(true);
	});

	it("treats the escaped forms as literals", () => {
		expect(compilePosixRegex("a\\+", ere).test("a+")).toBe(true);
		expect(compilePosixRegex("a\\+", ere).test("aa")).toBe(false);
		expect(compilePosixRegex("\\(x\\)", ere).test("(x)")).toBe(true);
	});
});

describe("POSIX character classes, which JavaScript does not have", () => {
	it("expands the common ones", () => {
		expect(compilePosixRegex("[[:digit:]]").test("7")).toBe(true);
		expect(compilePosixRegex("[[:digit:]]").test("x")).toBe(false);
		expect(compilePosixRegex("[[:alpha:]]").test("q")).toBe(true);
		expect(compilePosixRegex("[[:space:]]").test(" ")).toBe(true);
		expect(compilePosixRegex("[[:xdigit:]]").test("f")).toBe(true);
	});

	it("expands one inside a larger set, and honours negation", () => {
		expect(compilePosixRegex("[[:digit:]x]").test("x")).toBe(true);
		expect(compilePosixRegex("[^[:digit:]]").test("7")).toBe(false);
		expect(compilePosixRegex("[^[:digit:]]").test("a")).toBe(true);
	});

	it("leaves an unknown class alone rather than dropping it", () => {
		// Better a pattern that does not match than one that silently matches
		// everything because the class vanished.
		expect(() => compilePosixRegex("[[:nosuch:]]")).not.toThrow();
	});
});

describe("bracket expressions", () => {
	it("takes a leading ] as a literal", () => {
		expect(compilePosixRegex("[]x]").test("]")).toBe(true);
		expect(compilePosixRegex("[]x]").test("x")).toBe(true);
	});

	it("keeps ranges and negation", () => {
		expect(compilePosixRegex("[a-c]").test("b")).toBe(true);
		expect(compilePosixRegex("[^a-c]").test("b")).toBe(false);
	});
});

describe("options", () => {
	it("matches whole words only with wordBoundary", () => {
		const re = compilePosixRegex("cat", { wordBoundary: true });
		expect(re.test("a cat here")).toBe(true);
		expect(re.test("concatenate")).toBe(false);
	});

	it("treats the pattern literally with fixed", () => {
		const re = compilePosixRegex("a.c", { fixed: true });
		expect(re.test("a.c")).toBe(true);
		expect(re.test("abc")).toBe(false);
	});

	it("ignores case when asked", () => {
		expect(compilePosixRegex("abc", { ignoreCase: true }).test("ABC")).toBe(
			true,
		);
	});

	it("maps GNU \\< and \\> onto word boundaries", () => {
		const re = compilePosixRegex("\\<cat\\>");
		expect(re.test("a cat here")).toBe(true);
		expect(re.test("concatenate")).toBe(false);
	});
});

describe("failure reporting", () => {
	it("names the pattern the user wrote, not the translated one", () => {
		// Showing translated source to a model that wrote POSIX would be quoting
		// back something it never typed.
		expect(() => compilePosixRegex("a\\(b", { extended: false })).toThrow(
			/`a\\\(b`/,
		);
	});

	it("says which dialect it was read as", () => {
		expect(() => compilePosixRegex("a\\(b")).toThrow(
			/basic regular expression/,
		);
		expect(() => compilePosixRegex("(", { extended: true })).toThrow(
			/extended regular expression/,
		);
	});
});

describe("posixToJsSource", () => {
	it("does not escape a dot or star, which mean the same in both", () => {
		expect(posixToJsSource("a.c*")).toBe("a.c*");
	});
});

// GNU's rules where the translation used to differ (automaticum audit
// 2026-11-08, readers 5): each was a "No match" over text that matched.
describe("anchors and stars where GNU reads them as text", () => {
	it("takes a $ or ^ in the middle of a BRE as a literal", () => {
		expect(compilePosixRegex("$HOME").test("echo $HOME")).toBe(true);
		expect(compilePosixRegex("PATH=$PATH").test("PATH=$PATH:/x")).toBe(true);
		expect(compilePosixRegex("a^b").test("a^b")).toBe(true);
	});

	it("keeps them as anchors at the ends, after \\( and after \\|", () => {
		expect(compilePosixRegex("^a").test("xa")).toBe(false);
		expect(compilePosixRegex("a$").test("ax")).toBe(false);
		expect(compilePosixRegex("\\(^a\\)").test("abc")).toBe(true);
		expect(compilePosixRegex("\\(^a\\)").test("ba")).toBe(false);
		expect(compilePosixRegex("x\\|^a").test("ba")).toBe(false);
	});

	it("keeps a mid-pattern $ an anchor in ERE", () => {
		expect(
			compilePosixRegex("$HOME", { extended: true }).test("echo $HOME"),
		).toBe(false);
	});

	it("takes a leading * as a literal star", () => {
		expect(compilePosixRegex("*x").test("a*x")).toBe(true);
		expect(compilePosixRegex("^*").test("*abc")).toBe(true);
	});

	it("matches a whole word that starts with a non-word character", () => {
		const word = { wordBoundary: true };
		expect(compilePosixRegex("@Override", word).test("  @Override")).toBe(true);
		expect(compilePosixRegex("@Override", word).test("x@Override")).toBe(false);
		expect(compilePosixRegex("foo", word).test("foobar")).toBe(false);
	});
});
