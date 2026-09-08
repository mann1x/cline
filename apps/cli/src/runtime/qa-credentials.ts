import { normalizeQaCredentials, type QaCredential } from "@cline/core";

export interface ResolvedQaCredentials {
	credentials: QaCredential[];
	/** One line per name, for the log. Never includes a value. */
	notes: string[];
}

/**
 * Read the QA credentials named by `--qa-credential` out of this process's
 * environment.
 *
 * The CLI has no secret store and should not grow one: a headless tool is
 * already being started by something that knows how to set an environment
 * variable -- a shell profile, direnv, a CI secret, a password manager's `run`
 * subcommand -- and every one of those is a better place for the secret than a
 * file this program writes. So the flag takes a *name* and the value comes from
 * the environment, which also keeps it off the command line and out of shell
 * history.
 *
 * The value being in this process's environment is exactly why the withholding
 * in `ShellExecutionOptions` exists: without it every command a run makes would
 * inherit the secret regardless of whether it asked, and the gate would be
 * decorative here.
 */
export function resolveQaCredentialsFromEnv(
	names: readonly string[] | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedQaCredentials {
	if (!names || names.length === 0) {
		return { credentials: [], notes: [] };
	}
	const notes: string[] = [];
	const found: QaCredential[] = [];
	for (const name of names) {
		const value = env[name];
		if (value === undefined || value.length === 0) {
			// Named but not set is a mistake worth reporting: the run would
			// otherwise fail later, inside a QA command, for a reason nothing
			// connects back to a missing export.
			notes.push(`${name} is not set in this environment`);
			continue;
		}
		found.push({ name, value });
	}

	const { credentials, rejected } = normalizeQaCredentials(found);
	for (const entry of rejected) {
		notes.push(`${entry.name}: ${entry.reason}`);
	}
	for (const credential of credentials) {
		notes.push(`${credential.name} available to commands that ask for it`);
	}
	return { credentials, notes };
}
