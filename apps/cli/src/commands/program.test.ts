import { relative, sep } from "node:path";
import {
	resolveClineDataDir,
	resolveClineDir,
	setHomeDir,
} from "@cline/shared/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commanderToParsedArgs, createProgram } from "./program";

/** Render an absolute path under `home` the way help text does: `~/...`. */
function tildePath(absolutePath: string, home: string): string {
	return `~/${relative(home, absolutePath).split(sep).join("/")}`;
}

describe("root option help text", () => {
	const FAKE_HOME = "/home/cline-help-test";
	const savedEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		// Pin the resolver inputs so the defaults below are the true defaults
		// (no CLINE_DIR/CLINE_DATA_DIR overrides, known home directory).
		for (const key of ["CLINE_DIR", "CLINE_DATA_DIR"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		setHomeDir(FAKE_HOME);
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("reports the actual resolver defaults for --config and --data-dir", () => {
		// A wide help width keeps each option description on one line so the
		// full default text can be matched.
		const help = createProgram()
			.configureHelp({ helpWidth: 500 })
			.helpInformation();

		const configDefault = tildePath(resolveClineDir(), FAKE_HOME);
		const dataDirDefault = tildePath(resolveClineDataDir(), FAKE_HOME);

		// Sanity-check the resolvers themselves so the assertions below can't
		// silently drift along with a resolver regression.
		expect(configDefault).toBe("~/.cerebriline");
		expect(dataDirDefault).toBe("~/.cerebriline/data");

		expect(help).toContain(
			`Configuration directory (default: ${configDefault})`,
		);
		expect(help).toContain(
			`Use isolated local state at this directory path (default: ${dataDirDefault})`,
		);
	});
});

describe("--propose-check", () => {
	function parse(argv: string[]) {
		const program = createProgram();
		program.exitOverride();
		program.parse(["node", "cline", ...argv]);
		return commanderToParsedArgs(program);
	}

	it("accepts the two modes and rejects anything else", () => {
		expect(parse(["--propose-check", "auto"]).proposeCheck).toBe("auto");
		expect(parse(["--propose-check", "off"]).proposeCheck).toBe("off");

		// Coercing a typo to the default would run the whole batch on the
		// verdict the operator believed they had switched away from.
		const bad = parse(["--propose-check", "on"]);
		expect(bad.proposeCheck).toBeUndefined();
		expect(bad.invalidProposeCheck).toBe("on");
	});

	it("is absent when the flag is not passed", () => {
		expect(parse([]).proposeCheck).toBeUndefined();
		expect(parse([]).invalidProposeCheck).toBeUndefined();
	});
});

describe("--expert-model and its knobs", () => {
	function parse(argv: string[]) {
		const program = createProgram();
		program.exitOverride();
		program.parse(["node", "cline", ...argv]);
		return commanderToParsedArgs(program);
	}

	it("carries the expert flags through to the parsed args", () => {
		const args = parse([
			"--expert-model",
			"nemotron-3-nano:30b-cloud",
			"--expert-num-ctx",
			"131072",
			"--expert-max-escalations",
			"2",
			"--expert-max-follow-ups",
			"8",
			"--expert-close-after",
		]);

		expect(args.expertModel).toBe("nemotron-3-nano:30b-cloud");
		expect(args.expertNumCtx).toBe("131072");
		expect(args.expertMaxEscalations).toBe("2");
		expect(args.expertMaxFollowUps).toBe("8");
		expect(args.expertCloseAfter).toBe(true);
	});

	// The thresholds that decide whether the expert is ever offered. They are
	// on the CLI as well as the panel because finding their defaults is a
	// measurement, and the measurement runs here.
	it("carries the struggle thresholds through to the parsed args", () => {
		const args = parse([
			"--expert-model",
			"nemotron-3-nano:30b-cloud",
			"--struggle-failed-calls",
			"1",
			"--struggle-distress-hits",
			"3",
			"--struggle-window",
			"14",
			"--struggle-min-iteration",
			"5",
			"--struggle-max-per-task",
			"4",
		]);

		expect(args.struggleFailedCalls).toBe("1");
		expect(args.struggleDistressHits).toBe("3");
		expect(args.struggleWindow).toBe("14");
		expect(args.struggleMinIteration).toBe("5");
		expect(args.struggleMaxPerTask).toBe("4");
	});

	// The protocol's own threshold, added after the other five and on the same
	// contract: a string, absent leaves core's measured default in place.
	it("carries the thrown-away-attempt threshold too", () => {
		expect(
			parse(["--struggle-failed-transactions", "3"]).struggleFailedTransactions,
		).toBe("3");
		expect(parse([]).struggleFailedTransactions).toBeUndefined();
	});

	// The compaction threshold travels the same way and for the same reason:
	// the default is measured, and the arm that checks it runs from here.
	it("carries the forced full compaction through to the parsed args", () => {
		expect(
			parse(["--force-full-from-compaction", "3"]).forceFullFromCompaction,
		).toBe("3");
		// Zero is the off switch and has to reach the parser as a value.
		expect(
			parse(["--force-full-from-compaction", "0"]).forceFullFromCompaction,
		).toBe("0");
		expect(parse([]).forceFullFromCompaction).toBeUndefined();
	});

	it("is absent when no expert is named", () => {
		// Absent has to stay absent all the way down: it is what closes the
		// escalation paths, rather than offering a tool with nobody behind it.
		const args = parse([]);

		expect(args.expertModel).toBeUndefined();
		expect(args.expertCloseAfter).toBeUndefined();
		expect(args.expertMaxEscalations).toBeUndefined();
	});

	it("names the expert in the help, and says what omitting it does", () => {
		const program = createProgram();
		const help = program.helpInformation();

		expect(help).toContain("--expert-model");
		expect(help).toContain("escalation paths stay closed");
	});
});

describe("--teammates", () => {
	function parse(argv: string[]) {
		const program = createProgram();
		program.exitOverride();
		program.parse(["node", "cline", ...argv]);
		return commanderToParsedArgs(program);
	}

	// Off by default, like the extension's Teammates setting: absent is not
	// false-by-accident but the default the run resolves to.
	it("is on only when passed", () => {
		expect(parse(["--teammates"]).teammates).toBe(true);
		expect(parse([]).teammates).toBeUndefined();
	});
});
