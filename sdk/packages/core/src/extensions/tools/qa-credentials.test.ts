import { describe, expect, it } from "vitest";
import {
	commandText,
	createSecretRedactor,
	describeQaCredentials,
	normalizeQaCredentials,
	type QaCredential,
	referencedCredentialNames,
	resolveCredentialEnv,
} from "./qa-credentials";

const CREDENTIALS: QaCredential[] = [
	{ name: "QA_USER", value: "qa-account@example.test" },
	{ name: "QA_PASSWORD", value: "hunter2-but-longer" },
];

describe("what the user is allowed to configure", () => {
	it("keeps a well-formed credential", () => {
		const { credentials, rejected } = normalizeQaCredentials(CREDENTIALS);

		expect(credentials).toEqual(CREDENTIALS);
		expect(rejected).toEqual([]);
	});

	// Setting these is code execution rather than authentication: LD_PRELOAD on a
	// QA command changes what the command is.
	it.each([
		"PATH",
		"LD_PRELOAD",
		"NODE_OPTIONS",
		"ld_preload",
	])("refuses %s, which controls how a process runs", (name) => {
		const { credentials, rejected } = normalizeQaCredentials([
			{ name, value: "anything-long-enough" },
		]);

		expect(credentials).toEqual([]);
		expect(rejected[0]?.reason).toMatch(/controls how a process runs/);
	});

	it.each([
		["2FA_CODE", /environment variable name/],
		["QA PASSWORD", /environment variable name/],
		["QA-PASSWORD", /environment variable name/],
	])("refuses %s as a name", (name, reason) => {
		expect(
			normalizeQaCredentials([{ name, value: "long-enough-value" }]).rejected[0]
				?.reason,
		).toMatch(reason);
	});

	// A value this short appears inside ordinary words, so masking every
	// occurrence would replace half a build log. Since it cannot be masked it is
	// not accepted -- the alternative is a secret that silently comes back in
	// output.
	it("refuses a value too short to mask", () => {
		const { credentials, rejected } = normalizeQaCredentials([
			{ name: "QA_PIN", value: "1234" },
		]);

		expect(credentials).toEqual([]);
		expect(rejected[0]?.reason).toMatch(/too short to mask/);
	});

	it("refuses a second credential with the same name rather than picking one", () => {
		const { credentials, rejected } = normalizeQaCredentials([
			{ name: "QA_USER", value: "first-value-here" },
			{ name: "QA_USER", value: "second-value-here" },
		]);

		expect(credentials).toEqual([
			{ name: "QA_USER", value: "first-value-here" },
		]);
		expect(rejected[0]?.reason).toMatch(/already set/);
	});

	// Says so rather than dropping it: a credential that silently does not exist
	// is indistinguishable from a QA run that failed for some other reason.
	it("reports an empty value instead of ignoring the row", () => {
		expect(
			normalizeQaCredentials([{ name: "QA_TOKEN", value: "" }]).rejected,
		).toEqual([{ name: "QA_TOKEN", reason: "has no value" }]);
	});
});

describe("which commands get a credential", () => {
	it("gives an unrelated command nothing", () => {
		expect(resolveCredentialEnv(CREDENTIALS, { command: "ls -la" })).toEqual(
			{},
		);
	});

	it("gives a command exactly what it named", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, {
				command: 'curl -u "$QA_USER:$QA_PASSWORD" https://staging.example.test',
			}),
		).toEqual({
			QA_USER: "qa-account@example.test",
			QA_PASSWORD: "hunter2-but-longer",
		});
	});

	it("gives it only the one it named, not the set", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, { command: "echo ${QA_USER}" }),
		).toEqual({ QA_USER: "qa-account@example.test" });
	});

	// The majority case: the command line mentions nothing because the test
	// runner reads its own environment. Nothing can be inferred from the text, so
	// the call says what it needs.
	it("honours an explicit request from a command that names nothing", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, {
				command: "npx playwright test",
				requested: ["QA_USER", "QA_PASSWORD"],
			}),
		).toEqual({
			QA_USER: "qa-account@example.test",
			QA_PASSWORD: "hunter2-but-longer",
		});
	});

	// Nothing, rather than an empty string: an empty variable is indistinguishable
	// from a wrong one, and the command failing is the clearer signal.
	it("ignores a request for a credential that was never configured", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, {
				command: "npx playwright test",
				requested: ["QA_TOTP"],
			}),
		).toEqual({});
	});

	it("does not treat $QA_USER_ID as a reference to QA_USER", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, { command: "echo $QA_USER_ID" }),
		).toEqual({});
	});

	it.each([
		["posix", "echo $QA_USER"],
		["braced", "echo ${QA_USER}"],
		["windows", "echo %QA_USER%"],
		["powershell", "echo $env:QA_USER"],
	])("recognises the %s form", (_shell, text) => {
		expect(referencedCredentialNames(text, ["QA_USER"])).toEqual(["QA_USER"]);
	});

	it("reads a structured command's arguments too", () => {
		expect(
			resolveCredentialEnv(CREDENTIALS, {
				command: { command: "psql", args: ["-U", "$QA_USER"] },
			}),
		).toEqual({ QA_USER: "qa-account@example.test" });
	});

	it("has nothing to hand out when none are configured", () => {
		expect(resolveCredentialEnv([], { command: "echo $QA_USER" })).toEqual({});
	});
});

describe("what comes back", () => {
	it("masks a value a command printed", () => {
		const redact = createSecretRedactor(CREDENTIALS);

		expect(
			redact("logging in as qa-account@example.test with hunter2-but-longer"),
		).toBe("logging in as [redacted: QA_USER] with [redacted: QA_PASSWORD]");
	});

	it("masks every occurrence, not just the first", () => {
		const redact = createSecretRedactor([
			{ name: "QA_TOKEN", value: "tok-abcdefgh" },
		]);

		expect(redact("tok-abcdefgh and again tok-abcdefgh")).toBe(
			"[redacted: QA_TOKEN] and again [redacted: QA_TOKEN]",
		);
	});

	// Longest first: masking the short one first would leave the long one as a
	// mangled fragment plus a marker, which is both unreadable and still a partial
	// disclosure of the longer secret.
	it("masks the longer value as itself when one contains the other", () => {
		const redact = createSecretRedactor([
			{ name: "QA_SHORT", value: "abcdefghij" },
			{ name: "QA_LONG", value: "abcdefghij-and-more" },
		]);

		expect(redact("value abcdefghij-and-more here")).toBe(
			"value [redacted: QA_LONG] here",
		);
	});

	it("leaves output alone when nothing is configured", () => {
		expect(createSecretRedactor([])("nothing to hide")).toBe("nothing to hide");
	});

	it("survives empty output", () => {
		expect(createSecretRedactor(CREDENTIALS)("")).toBe("");
	});
});

describe("what the model is told", () => {
	it("names the credentials and never their values", () => {
		const description = describeQaCredentials(["QA_USER", "QA_PASSWORD"]);

		expect(description).toContain("QA_USER");
		expect(description).toContain("QA_PASSWORD");
		expect(description).not.toContain("hunter2-but-longer");
		expect(description).toContain("never shown to you");
	});

	it("says nothing at all when none are configured", () => {
		expect(describeQaCredentials([])).toBe("");
	});
});

describe("commandText", () => {
	it("joins a structured command so it can be scanned as one string", () => {
		expect(commandText({ command: "psql", args: ["-U", "qa"] })).toBe(
			"psql -U qa",
		);
	});

	it("passes a plain command through", () => {
		expect(commandText("ls -la")).toBe("ls -la");
	});
});
