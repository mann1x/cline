import { describe, expect, it } from "vitest";
import { resolveQaCredentialsFromEnv } from "./qa-credentials";

describe("--qa-credential", () => {
	it("takes the value from the environment, not the flag", () => {
		const { credentials } = resolveQaCredentialsFromEnv(["QA_PASSWORD"], {
			QA_PASSWORD: "from-the-environment",
		});

		expect(credentials).toEqual([
			{ name: "QA_PASSWORD", value: "from-the-environment" },
		]);
	});

	// Named but not exported is the mistake worth catching early: the run would
	// otherwise fail inside a QA command, for a reason nothing connects back to a
	// missing export.
	it("says so when a named variable is not set", () => {
		const { credentials, notes } = resolveQaCredentialsFromEnv(["QA_PASSWORD"], {});

		expect(credentials).toEqual([]);
		expect(notes).toEqual(["QA_PASSWORD is not set in this environment"]);
	});

	it("treats an empty value as not set", () => {
		expect(
			resolveQaCredentialsFromEnv(["QA_PASSWORD"], { QA_PASSWORD: "" }).credentials,
		).toEqual([]);
	});

	it("passes the store's own rules on, by name", () => {
		const { credentials, notes } = resolveQaCredentialsFromEnv(["PATH"], {
			PATH: "/usr/bin:/bin",
		});

		expect(credentials).toEqual([]);
		expect(notes[0]).toMatch(/^PATH: .*controls how a process runs/);
	});

	it("never puts a value in a note", () => {
		const { notes } = resolveQaCredentialsFromEnv(["QA_PASSWORD"], {
			QA_PASSWORD: "a-real-looking-secret",
		});

		expect(notes.join("\n")).not.toContain("a-real-looking-secret");
	});

	it("has nothing to do when the flag was not given", () => {
		expect(resolveQaCredentialsFromEnv(undefined)).toEqual({
			credentials: [],
			notes: [],
		});
	});
});
