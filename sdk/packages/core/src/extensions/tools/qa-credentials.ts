/**
 * Credentials a QA run needs, kept out of the model's context.
 *
 * The request behind this (#46) is "let the agent log in so it can test what it
 * just changed". The obvious implementations are both wrong, and it is worth
 * naming them because they are what this exists instead of:
 *
 *   - **Ask for the credential in the conversation.** It is then in the
 *     transcript, in whatever the provider logs, and in every request until
 *     compaction drops it -- and the model forgets it long before that, so it
 *     asks again.
 *   - **Export it into the shell.** A terminal outlives the command that needed
 *     the secret. Everything the model runs afterwards inherits it, including
 *     the commands the model wrote itself, and any of them can print it.
 *
 * What this module does instead rests on three rules, none of which depend on
 * what the project under test looks like:
 *
 *   1. The model is told the *names* and never the values.
 *   2. A value reaches a command's environment only when that command asked for
 *      it -- by naming it in the command text, or by listing it on the call.
 *      Nothing else in the run carries it.
 *   3. Every value is masked out of tool output before it becomes transcript.
 *
 * Rule 3 is the one that makes the rest safe in practice, because rules 1 and 2
 * are about what we hand out and rule 3 is about what comes back. `echo
 * $QA_PASSWORD`, a test runner that dumps its resolved config, a stack trace
 * with a connection string in it -- all of them return through the same choke
 * point, and all of them come back masked.
 *
 * The environment variable is the interface on purpose. It is the one thing a
 * seeded-user script, a `curl` with a bearer token, a Playwright config and a
 * `docker compose` file all agree on, so nothing here needs to know which of
 * those the user has.
 *
 * **What this does not defend against**: a model that decides to exfiltrate. If
 * it can put `$QA_PASSWORD` in a command it can put it in a request to a server
 * it chose. That is inherent in giving a credential to a program at all, which
 * is why the setting says test and sandbox credentials only. The guarantee here
 * is against accident and drift -- the secret leaking into a transcript, a log,
 * or an unrelated command -- not against intent.
 */

import type { StructuredCommandInput } from "./schemas";

/** A named secret the user has made available to QA runs. */
export interface QaCredential {
	/** Environment variable name. What the model sees. */
	name: string;
	/** The secret itself. Never leaves this process except into a child's env. */
	value: string;
}

/** A credential that was refused, and why, so a host can say so. */
export interface RejectedQaCredential {
	name: string;
	reason: string;
}

export interface NormalizedQaCredentials {
	credentials: QaCredential[];
	rejected: RejectedQaCredential[];
}

/**
 * Valid as an environment variable name across the shells we spawn.
 *
 * Deliberately narrower than POSIX allows: no leading digit, nothing outside
 * word characters, and bounded, because a name is also what gets pattern-matched
 * against command text and rendered into a tool description.
 */
export const QA_CREDENTIAL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The shortest value that can be masked without shredding the output around it.
 *
 * A four-character secret appears inside ordinary words; redacting every
 * occurrence would replace half a build log. Since a value that cannot be masked
 * cannot be handled safely by rule 3, it is refused rather than accepted and
 * quietly left unmasked -- the caller gets a reason it can show.
 */
export const QA_CREDENTIAL_MIN_VALUE_LENGTH = 8;

/**
 * Names that decide how a process runs rather than who it runs as.
 *
 * These are refused because setting them is code execution, not authentication:
 * `LD_PRELOAD` or `NODE_OPTIONS` on a QA command changes what the command *is*.
 * A user who wants to alter their environment has a shell for it; this feature
 * is for secrets.
 */
const PROCESS_CONTROLLING_ENV_NAMES = new Set([
	"BASH_ENV",
	"CDPATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"ENV",
	"GLIBC_TUNABLES",
	"IFS",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"PATH",
	"PERL5OPT",
	"PS4",
	"PSModulePath",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"SHELL",
	"SHELLOPTS",
]);

/**
 * Sort out what can be used from what the user typed.
 *
 * Everything refused comes back with a reason instead of being dropped: a
 * credential that silently does not exist is indistinguishable, from the user's
 * side, from a QA run that failed for some other reason.
 */
export function normalizeQaCredentials(
	credentials: readonly QaCredential[] | undefined,
): NormalizedQaCredentials {
	const accepted: QaCredential[] = [];
	const rejected: RejectedQaCredential[] = [];
	const seen = new Set<string>();

	for (const credential of credentials ?? []) {
		const name = credential?.name?.trim() ?? "";
		const value = credential?.value ?? "";
		if (name.length === 0) {
			continue;
		}
		if (!QA_CREDENTIAL_NAME_PATTERN.test(name)) {
			rejected.push({
				name,
				reason:
					"not usable as an environment variable name (letters, digits and underscore only, not starting with a digit)",
			});
			continue;
		}
		if (PROCESS_CONTROLLING_ENV_NAMES.has(name.toUpperCase())) {
			rejected.push({
				name,
				reason: `${name} controls how a process runs rather than who it runs as, so it cannot be set here`,
			});
			continue;
		}
		if (seen.has(name)) {
			rejected.push({ name, reason: "a credential with this name is already set" });
			continue;
		}
		if (value.length === 0) {
			rejected.push({ name, reason: "has no value" });
			continue;
		}
		if (value.length < QA_CREDENTIAL_MIN_VALUE_LENGTH) {
			rejected.push({
				name,
				reason: `shorter than ${QA_CREDENTIAL_MIN_VALUE_LENGTH} characters, which is too short to mask out of command output reliably`,
			});
			continue;
		}
		seen.add(name);
		accepted.push({ name, value });
	}

	return { credentials: accepted, rejected };
}

/** The part of a credential set the model is allowed to know. */
export function qaCredentialNames(
	credentials: readonly QaCredential[],
): string[] {
	return credentials.map((credential) => credential.name);
}

/** The text of a command, whichever shape `run_commands` delivered it in. */
export function commandText(
	command: string | StructuredCommandInput,
): string {
	if (typeof command === "string") {
		return command;
	}
	return [command.command, ...(command.args ?? [])].join(" ");
}

function referencePattern(name: string): RegExp {
	// `$NAME`, `${NAME}`, `%NAME%` and PowerShell's `$env:NAME`, each anchored so
	// that `$QA_USER_ID` does not count as a reference to `QA_USER`.
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?:\\$\\{${escaped}\\}|\\$env:${escaped}\\b|\\$${escaped}\\b|%${escaped}%)`,
	);
}

/**
 * Which credentials a command asked for by writing them into itself.
 *
 * This exists so the common one-liner -- `curl -H "Authorization: Bearer
 * $QA_API_KEY" ...` -- works without the model also having to declare what it
 * just wrote. It is a convenience, not the whole gate: a command like `npx
 * playwright test`, where the *framework* reads the environment and the command
 * line mentions nothing, is the majority case and is covered by the explicit
 * list instead.
 */
export function referencedCredentialNames(
	text: string,
	names: readonly string[],
): string[] {
	return names.filter((name) => referencePattern(name).test(text));
}

export interface CredentialEnvRequest {
	/** The command about to run, if the caller has it. */
	command?: string | StructuredCommandInput;
	/** Names the call asked for explicitly. */
	requested?: readonly string[];
}

/**
 * The environment a single command gets: nothing unless it asked.
 *
 * Returns an empty object rather than the whole set when nothing matched, which
 * is what keeps `ls`, `git status` and every other incidental command in a run
 * from carrying secrets they have no use for.
 */
export function resolveCredentialEnv(
	credentials: readonly QaCredential[],
	request: CredentialEnvRequest,
): Record<string, string> {
	if (credentials.length === 0) {
		return {};
	}
	const names = qaCredentialNames(credentials);
	const wanted = new Set<string>(
		request.command
			? referencedCredentialNames(commandText(request.command), names)
			: [],
	);
	for (const name of request.requested ?? []) {
		// Only names that exist: a model asking for a credential the user never
		// configured gets nothing, and finds out from the command failing rather
		// than from an empty variable it cannot tell apart from a wrong one.
		if (names.includes(name)) {
			wanted.add(name);
		}
	}
	const env: Record<string, string> = {};
	for (const credential of credentials) {
		if (wanted.has(credential.name)) {
			env[credential.name] = credential.value;
		}
	}
	return env;
}

/**
 * Replace every configured value wherever it appears in text.
 *
 * Longest first, so a value that contains another value masks as itself rather
 * than being chewed into pieces by the shorter one.
 *
 * The replacement names the credential on purpose: `[redacted: QA_PASSWORD]`
 * tells the model that the thing it is looking for was there and was withheld,
 * which is actionable. A blank, or nothing at all, reads as a bug in the tool
 * and gets retried.
 */
export function createSecretRedactor(
	credentials: readonly QaCredential[],
): (text: string) => string {
	const maskable = credentials
		.filter(
			(credential) =>
				credential.value.length >= QA_CREDENTIAL_MIN_VALUE_LENGTH,
		)
		.slice()
		.sort((a, b) => b.value.length - a.value.length);
	if (maskable.length === 0) {
		return (text) => text;
	}
	return (text) => {
		if (!text) {
			return text;
		}
		let masked = text;
		for (const credential of maskable) {
			masked = masked.split(credential.value).join(`[redacted: ${credential.name}]`);
		}
		return masked;
	};
}

/**
 * What the model is told, appended to the `run_commands` description.
 *
 * In the tool description rather than the system prompt because that is where a
 * model looks when it is deciding how to call the tool, and because the names
 * are only meaningful next to the parameter that uses them.
 */
export function describeQaCredentials(names: readonly string[]): string {
	if (names.length === 0) {
		return "";
	}
	return (
		`\n\nQA credentials configured by the user: ${names.join(", ")}. ` +
		"Their values are never shown to you. Reference them in a command as " +
		"environment variables (for example `$" +
		names[0] +
		"`), or list the ones a command needs in `credentials` when the command " +
		"itself does not name them — a test runner that reads its own environment " +
		"is the usual case. They are set only for the commands that ask, and are " +
		"masked out of any output that contains them."
	);
}
