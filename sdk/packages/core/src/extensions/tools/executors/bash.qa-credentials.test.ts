import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createShellExecutor } from "./bash";

const CONTEXT = {} as AgentToolContext;

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
				"echo $CLINE_TEST_SECRET",
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
				"echo [$CLINE_TEST_SECRET]",
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
				"echo $CLINE_TEST_SECRET",
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
			const output = await shell("env", process.cwd(), CONTEXT, {
				withhold: ["CLINE_TEST_SECRET"],
			});

			expect(output).not.toContain("inherited-value");
		} finally {
			delete process.env.CLINE_TEST_SECRET;
		}
	});
});
