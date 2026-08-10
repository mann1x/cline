import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createShellTool } from "./definitions";
import type { QaCredential } from "./qa-credentials";
import type { StructuredCommandInput } from "./schemas";
import type { ShellExecutionOptions } from "./types";

const CREDENTIALS: QaCredential[] = [
	{ name: "QA_USER", value: "qa-account@example.test" },
	{ name: "QA_PASSWORD", value: "hunter2-but-longer" },
];

const CONTEXT = {} as AgentToolContext;

interface Call {
	command: string | StructuredCommandInput;
	options: ShellExecutionOptions | undefined;
}

function makeTool(output = "ok", credentials: QaCredential[] = CREDENTIALS) {
	const calls: Call[] = [];
	const executor = vi.fn(
		async (
			command: string | StructuredCommandInput,
			_cwd: string,
			_context: AgentToolContext,
			options?: ShellExecutionOptions,
		) => {
			calls.push({ command, options });
			return output;
		},
	);
	const tool = createShellTool(executor, {
		cwd: "/workspace",
		qaCredentials: credentials,
	});
	return { tool, calls };
}

async function run(
	tool: ReturnType<typeof createShellTool>,
	input: unknown,
): Promise<Array<{ query: string; result: string; error?: string }>> {
	return (await tool.execute(input, CONTEXT)) as Array<{
		query: string;
		result: string;
		error?: string;
	}>;
}

describe("run_commands with QA credentials configured", () => {
	// The whole point of the gate: a run is mostly commands that have no
	// business seeing a secret, and none of them do.
	it("gives an unrelated command no credential", async () => {
		const { tool, calls } = makeTool();

		await run(tool, { commands: ["git status"] });

		expect(calls[0].options?.env).toBeUndefined();
	});

	// Withholding is for the commands that did *not* ask. Where the host itself
	// holds the secret -- the CLI, started with it exported -- spawn inherits the
	// parent environment, so without this every command sees it anyway and asking
	// means nothing.
	it("strips every configured name from what an unrelated command inherits", async () => {
		const { tool, calls } = makeTool();

		await run(tool, { commands: ["git status"] });

		expect(calls[0].options?.withhold).toEqual(["QA_USER", "QA_PASSWORD"]);
	});

	it("gives a command the credential it named", async () => {
		const { tool, calls } = makeTool();

		await run(tool, { commands: ['curl -u "$QA_USER:$QA_PASSWORD" https://staging'] });

		expect(calls[0].options?.env).toEqual({
			QA_USER: "qa-account@example.test",
			QA_PASSWORD: "hunter2-but-longer",
		});
	});

	// The majority case, and the one reference-scanning cannot reach: the command
	// line says nothing because the test runner reads the environment itself.
	it("honours the names listed on the call", async () => {
		const { tool, calls } = makeTool();

		await run(tool, {
			commands: ["npx playwright test"],
			credentials: ["QA_USER", "QA_PASSWORD"],
		});

		expect(calls[0].options?.env).toEqual({
			QA_USER: "qa-account@example.test",
			QA_PASSWORD: "hunter2-but-longer",
		});
	});

	// Per command, not per call: one call can carry a login and a `ls`, and the
	// `ls` has no more claim on the secret than it would in a separate call.
	it("scopes the environment to the command that asked, within one call", async () => {
		const { tool, calls } = makeTool();

		await run(tool, { commands: ["echo $QA_USER", "ls -la"] });

		expect(calls[0].options?.env).toEqual({ QA_USER: "qa-account@example.test" });
		expect(calls[1].options?.env).toBeUndefined();
	});

	it("masks a value the command printed", async () => {
		const { tool } = makeTool("logged in as qa-account@example.test");

		const [result] = await run(tool, { commands: ["echo $QA_USER"] });

		expect(result.result).toBe("logged in as [redacted: QA_USER]");
	});

	// `query` is the command echoed back into the transcript. A model that
	// inlined the value instead of referencing it would leak from here even if
	// the command printed nothing at all.
	it("masks a value the model inlined into the command itself", async () => {
		const { tool } = makeTool();

		const [result] = await run(tool, {
			commands: ["curl -u hunter2-but-longer https://staging"],
		});

		expect(result.query).not.toContain("hunter2-but-longer");
		expect(result.query).toContain("[redacted: QA_PASSWORD]");
	});

	// A failing QA command is the one whose output matters most, and it is also
	// where a framework tends to dump its resolved configuration.
	it("masks a value in the output of a command that failed", async () => {
		const executor = vi.fn(async () => {
			throw new Error("auth failed for qa-account@example.test");
		});
		const tool = createShellTool(executor, {
			cwd: "/workspace",
			qaCredentials: CREDENTIALS,
		});

		const [result] = await run(tool, { commands: ["login"] });

		expect(result.error).not.toContain("qa-account@example.test");
		expect(result.error).toContain("[redacted: QA_USER]");
	});

	// Redaction is not conditional on the command having received anything:
	// `cat .env.test` is given no credential and can still print one.
	it("masks a value printed by a command that was given none", async () => {
		const { tool, calls } = makeTool("QA_PASSWORD=hunter2-but-longer");

		const [result] = await run(tool, { commands: ["cat .env.test"] });

		expect(calls[0].options?.env).toBeUndefined();
		expect(result.result).toBe("QA_PASSWORD=[redacted: QA_PASSWORD]");
	});

	it("names the credentials in its description and never their values", async () => {
		const { tool } = makeTool();

		expect(tool.description).toContain("QA_USER");
		expect(tool.description).toContain("QA_PASSWORD");
		expect(tool.description).not.toContain("hunter2-but-longer");
	});

	// The set is editable while a session runs, and the runtime re-reads
	// `description` for every request, so a credential added mid-session is
	// nameable on the next request rather than the next run.
	it("picks up a credential added after the tool was built", () => {
		const credentials: QaCredential[] = [];
		const tool = createShellTool(vi.fn(async () => "ok"), {
			cwd: "/workspace",
			qaCredentials: () => credentials,
		});

		expect(tool.description).not.toContain("QA_TOKEN");

		credentials.push({ name: "QA_TOKEN", value: "token-value-here" });

		expect(tool.description).toContain("QA_TOKEN");
	});
});

describe("run_commands with no QA credentials configured", () => {
	it("says nothing about credentials in its description", () => {
		const tool = createShellTool(vi.fn(async () => "ok"), { cwd: "/workspace" });

		expect(tool.description).not.toContain("QA credentials");
	});

	it("passes no per-call environment", async () => {
		const { tool, calls } = makeTool("ok", []);

		await run(tool, { commands: ["echo $QA_USER"], credentials: ["QA_USER"] });

		expect(calls[0].options).toBeUndefined();
	});

	it("leaves output untouched", async () => {
		const { tool } = makeTool("hunter2-but-longer", []);

		const [result] = await run(tool, { commands: ["echo hi"] });

		expect(result.result).toBe("hunter2-but-longer");
	});
});
