import { describe, expect, it } from "vitest";
import {
	type CheckProposal,
	describeCheckProposal,
	proposalToOracle,
	readCheckProposal,
	sameProposal,
} from "./proposal";

const ROOT = "/work";

function reject(input: unknown): string {
	const result = readCheckProposal(input, ROOT);
	if (!("problem" in result)) {
		throw new Error("expected a rejection");
	}
	return result.problem;
}

describe("readCheckProposal", () => {
	it("takes a page check", () => {
		expect(
			readCheckProposal(
				{ kind: "page", path: "game.html", reason: "the task is this page" },
				ROOT,
			),
		).toEqual({
			kind: "page",
			path: "game.html",
			reason: "the task is this page",
		});
	});

	it("takes a command check with a pattern", () => {
		expect(
			readCheckProposal(
				{
					kind: "command",
					command: "node run.js",
					expect: '"ok":true',
					reason: "it prints the verdict",
				},
				ROOT,
			),
		).toEqual({
			kind: "command",
			command: "node run.js",
			expect: '"ok":true',
			reason: "it prints the verdict",
		});
	});

	// The user reads this to decide, so a proposal without it is not a proposal.
	it("refuses a proposal that does not say why", () => {
		expect(reject({ kind: "page", path: "game.html" })).toContain("`reason`");
	});

	it("refuses a kind it does not run", () => {
		expect(reject({ kind: "vibes", reason: "trust me" })).toContain("`kind`");
	});

	// Approved once, then run repeatedly and unattended: the file it names is
	// not somewhere to be relaxed about.
	it("refuses a path that leaves the workspace", () => {
		expect(
			reject({ kind: "page", path: "../../etc/passwd", reason: "no" }),
		).toContain("inside the workspace");
	});

	it("refuses a file this check cannot load", () => {
		expect(reject({ kind: "page", path: "notes.md", reason: "no" })).toContain(
			"neither",
		);
	});

	it("refuses a command with nothing to run", () => {
		expect(reject({ kind: "command", reason: "no" })).toContain("`command`");
	});

	// A pattern that will not compile would silently return the protocol to
	// judging on exit status, which for this class of check keeps everything.
	it("refuses a pattern that will not compile", () => {
		const problem = reject({
			kind: "command",
			command: "node run.js",
			expect: "ok(",
			reason: "no",
		});
		expect(problem).toContain("`expect`");
		expect(problem).toContain("never a command");
	});
});

describe("describeCheckProposal", () => {
	it("puts the exact command on its own line", () => {
		const text = describeCheckProposal({
			kind: "command",
			command: "npm test -- --run",
			reason: "the suite covers it",
		});

		expect(text).toContain("    npm test -- --run");
		expect(text).toContain("the suite covers it");
	});

	// The failure this wording exists for: the first user to see this dialog
	// read "Load and run `manic_miner.html`" as a job for them, and declined a
	// check that never involved them at all.
	it("says who runs it before it says what it is", () => {
		const text = describeCheckProposal({
			kind: "page",
			path: "game.html",
			reason: "the task is this page",
		});

		expect(text.split("\n")[0]).toContain("Cline runs this itself");
		expect(text).toContain("You are not asked to test anything");
		expect(text).toContain("no browser window opens");
		expect(text).toContain("game.html");
	});

	it("attributes the reason to the model, not to the reader", () => {
		const text = describeCheckProposal({
			kind: "command",
			command: "node run.js",
			reason: "it exits non-zero while the level data is missing",
		});

		expect(text).toContain("Cline's reason for choosing it:");
		expect(text).toContain("unattended");
	});
});

describe("proposalToOracle", () => {
	it("turns a page proposal into a check the harness runs itself", () => {
		const oracle = proposalToOracle(
			{ kind: "page", path: "game.html", reason: "why" },
			ROOT,
		);

		expect(oracle.kind).toBe("page");
		expect(oracle.reason).toContain("approved by you");
	});

	it("runs a command proposal through the shell, as a user-named one is", () => {
		const oracle = proposalToOracle(
			{ kind: "command", command: "a | b", expect: "ok", reason: "why" },
			ROOT,
		);

		if (oracle.kind === "page") {
			throw new Error("expected a command oracle");
		}
		expect(oracle.args.at(-1)).toBe("a | b");
		expect(oracle.expect).toBe("ok");
	});
});

describe("sameProposal", () => {
	const base: CheckProposal = {
		kind: "command",
		command: "node run.js",
		reason: "why",
	};

	// A proposal that differs by one character is a different one, and has to
	// be approved again.
	it("is false when the command changes at all", () => {
		expect(sameProposal(base, { ...base, command: "node run.js " })).toBe(
			false,
		);
		expect(sameProposal(base, { ...base, expect: "ok" })).toBe(false);
	});

	// The reason is prose for the user, not part of what runs.
	it("is true when only the reason is reworded", () => {
		expect(sameProposal(base, { ...base, reason: "different words" })).toBe(
			true,
		);
	});
});
