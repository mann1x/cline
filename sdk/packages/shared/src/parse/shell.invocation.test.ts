import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getShellInvocation } from "./shell";

/**
 * Starting PowerShell is slow on a loaded CI runner, and these tests start it
 * from inside itself. At 10 s the spawn timed out on both hosted runners
 * (2026-10-12: `spawnSync powershell.exe ETIMEDOUT` on Windows, the same test
 * under pwsh on Ubuntu) with nothing wrong with what was being tested.
 */
const SPAWN_TIMEOUT_MS = 45_000;
/** Two spawns in the slowest test, and room over them. */
const TEST_TIMEOUT_MS = 120_000;

const shells =
	process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];

for (const shell of shells) {
	const available =
		spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: SPAWN_TIMEOUT_MS,
		}).status === 0;

	describe.runIf(available)(`${shell} invocation`, () => {
		function run(command: string) {
			const invocation = getShellInvocation(shell, command);
			const result = spawnSync(invocation.executable, invocation.args, {
				input: invocation.input,
				encoding: "utf8",
				windowsHide: true,
				timeout: SPAWN_TIMEOUT_MS,
			});
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			return result;
		}

		it(
			"does not execute a string on the next statement as a nested command",
			() => {
				const result = run(`${shell} -NoProfile -Command\n"Write-Output 42"`);
				// The native shell reports its missing argument; the next statement
				// emits a literal string rather than executing that string as a script.
				expect(result.stderr).not.toBe("");
				expect(result.stdout.trim()).toMatch(/Write-Output 42$/);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"executes a quoted multiline body with literal pipeline variables",
			() => {
				const result = run(
					`${shell}\t-NoProfile\t-Command "1, 2 | Where-Object { $_ -eq 2 }\nWrite-Output 'done'"`,
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout.trim().split(/\r?\n/)).toEqual(["2", "done"]);
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"preserves an escaped outer line continuation",
			() => {
				const result = run(
					`${shell} -NoProfile -Command \`\n"Write-Output 42"`,
				);
				expect(result.status).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout.trim()).toBe("42");
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"does not print a banner under Command with or without NoLogo",
			() => {
				for (const flags of [[], ["-NoLogo"]]) {
					const result = spawnSync(
						shell,
						[
							"-NoProfile",
							"-NonInteractive",
							...flags,
							"-Command",
							"Write-Output 42",
						],
						{ encoding: "utf8", windowsHide: true, timeout: SPAWN_TIMEOUT_MS },
					);
					expect(result.error).toBeUndefined();
					expect(result.status).toBe(0);
					expect(result.stderr).toBe("");
					expect(result.stdout.trim()).toBe("42");
				}
			},
			TEST_TIMEOUT_MS,
		);
	});
}
