import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createShellExecutor } from "./bash";

const CONTEXT = {} as AgentToolContext;

/**
 * How this platform's shell spells "the value of this variable".
 *
 * The executor runs PowerShell on Windows, where `$CLINE_TEST_SECRET` is an
 * undefined *PowerShell* variable rather than an environment one: the command
 * succeeds, prints nothing, and the test reads that as the secret having been
 * withheld. `env` has no Windows spelling at all, so the command that lists the
 * whole environment is written per platform too.
 */
const isWindows = process.platform === "win32";
const expand = (name: string) => (isWindows ? `$env:${name}` : `$${name}`);
const LIST_ENVIRONMENT = isWindows ? "Get-ChildItem Env:" : "env";

/**
 * Against a real child process, because the claim is about what a spawned
 * program can see. A mock can only confirm that an object was passed along.
 */
describe("what a spawned command can actually read", () => {
	const shell = createShellExecutor({ timeoutMs: 10_000 });

	it("inherits the parent's environment when nothing is withheld", async () => {
		process.env.CLINE_TEST_SECRET = "inherited-value";
		try {
			const output = await shell(
				`echo "${expand("CLINE_TEST_SECRET")}"`,
				process.cwd(),
				CONTEXT,
			);

			expect(output.trim()).toBe("inherited-value");
		} finally {
			delete process.env.CLINE_TEST_SECRET;
		}
	});

	// The CLI case: the secret is in this process's environment because that is
	// where the user put it, and a command that never asked must not see it.
	it("cannot read a withheld variable that the parent holds", async () => {
		process.env.CLINE_TEST_SECRET = "inherited-value";
		try {
			const output = await shell(
				`echo "[${expand("CLINE_TEST_SECRET")}]"`,
				process.cwd(),
				CONTEXT,
				{
					withhold: ["CLINE_TEST_SECRET"],
				},
			);

			expect(output.trim()).toBe("[]");
		} finally {
			delete process.env.CLINE_TEST_SECRET;
		}
	});

	// Asking is what puts it back. Withholding is applied to the inherited names
	// only, so the grant survives being stripped a moment earlier.
	it("reads it again when the same command asked for it", async () => {
		process.env.CLINE_TEST_SECRET = "inherited-value";
		try {
			const output = await shell(
				`echo "${expand("CLINE_TEST_SECRET")}"`,
				process.cwd(),
				CONTEXT,
				{
					withhold: ["CLINE_TEST_SECRET"],
					env: { CLINE_TEST_SECRET: "granted-value" },
				},
			);

			expect(output.trim()).toBe("granted-value");
		} finally {
			delete process.env.CLINE_TEST_SECRET;
		}
	});

	// `env` is a command the model can run, and it is the obvious way to find a
	// secret that was not handed over.
	it("does not list a withheld variable in the child's environment at all", async () => {
		process.env.CLINE_TEST_SECRET = "inherited-value";
		try {
			const output = await shell(LIST_ENVIRONMENT, process.cwd(), CONTEXT, {
				withhold: ["CLINE_TEST_SECRET"],
			});

			expect(output).not.toContain("inherited-value");
		} finally {
			delete process.env.CLINE_TEST_SECRET;
		}
	});
});
