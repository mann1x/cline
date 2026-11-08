/**
 * Plan-mode command blacklist for run_commands.
 *
 * Plan mode keeps run_commands available for read-only investigation, but
 * models (especially weaker ones) use it to edit files anyway. When the plan
 * preset sets `blockFileEditingCommands`, createShellTool checks each command
 * against this blacklist before executing and returns a tool error instead of
 * running anything that looks like a file modification.
 *
 * This is a simple blacklist, not a shell interpreter. Commands are lightly
 * preprocessed (quoted text, heredoc bodies, escapes, and comments are masked
 * so they cannot false-positive), split on shell separators, and the leading
 * command word of each part is compared against the lists below; output
 * redirection to files is also rejected. It will not catch every possible
 * mutation (e.g. `python -c "open(..., 'w')"`, or a command assembled at run
 * time from variables) — it exists to stop the common ways models edit files
 * from the shell, and entries are easy to add. A quoted `bash -c` / `eval`
 * string is read as the command line it is.
 */

import type { StructuredCommandInput } from "./schemas";

/** Commands that create, modify, or delete files. */
const BLOCKED_COMMANDS = new Set([
	// POSIX
	"rm",
	"rmdir",
	"unlink",
	"mv",
	"cp",
	"dd",
	"touch",
	"mkdir",
	"ln",
	"link",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"shred",
	"install",
	"patch",
	"rsync",
	"mkfifo",
	"mknod",
	// Windows / PowerShell
	"del",
	"erase",
	"move",
	"ren",
	"rename",
	"md",
	"rd",
	"mklink",
	"copy",
	"xcopy",
	"robocopy",
	"new-item",
	"ni",
	"remove-item",
	"move-item",
	"copy-item",
	"rename-item",
	"set-content",
	"add-content",
	"clear-content",
	"out-file",
	// Unambiguous PowerShell aliases of the cmdlets above
	"mi",
	"ri",
	"cpi",
	"rni",
	"ac",
	"clc",
]);

/** Subcommands that mutate state, keyed by the command they belong to. */
const GIT_SUBCOMMANDS = new Set([
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"init",
	"merge",
	"mv",
	"pull",
	"push",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"submodule",
	"switch",
	"worktree",
]);
const NODE_PM_SUBCOMMANDS = new Set([
	"install",
	"i",
	"ci",
	"add",
	"remove",
	"rm",
	"uninstall",
	"unlink",
	"link",
	"update",
	"up",
	"upgrade",
	"dedupe",
	"prune",
	"publish",
]);
const PIP_SUBCOMMANDS = new Set(["install", "uninstall", "add", "remove"]);
const CARGO_SUBCOMMANDS = new Set([
	"add",
	"remove",
	"rm",
	"install",
	"uninstall",
	"update",
	"new",
	"init",
	"publish",
]);
const GEM_SUBCOMMANDS = new Set(["install", "uninstall", "update", "cleanup"]);
const COMPOSER_SUBCOMMANDS = new Set([
	"install",
	"require",
	"remove",
	"update",
]);
const GO_SUBCOMMANDS = new Set(["install", "get"]);
const DOTNET_SUBCOMMANDS = new Set(["add", "remove"]);
const WINGET_SUBCOMMANDS = new Set(["install", "uninstall", "upgrade"]);
const NUGET_SUBCOMMANDS = new Set(["install", "update", "delete", "push"]);
const SYSTEM_PM_SUBCOMMANDS = new Set([
	"install",
	"reinstall",
	"remove",
	"purge",
	"uninstall",
	"upgrade",
	"autoremove",
	"add",
	"del",
]);
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
	git: GIT_SUBCOMMANDS,
	npm: NODE_PM_SUBCOMMANDS,
	pnpm: NODE_PM_SUBCOMMANDS,
	yarn: NODE_PM_SUBCOMMANDS,
	bun: NODE_PM_SUBCOMMANDS,
	pip: PIP_SUBCOMMANDS,
	pip3: PIP_SUBCOMMANDS,
	pipx: PIP_SUBCOMMANDS,
	uv: PIP_SUBCOMMANDS,
	cargo: CARGO_SUBCOMMANDS,
	apt: SYSTEM_PM_SUBCOMMANDS,
	"apt-get": SYSTEM_PM_SUBCOMMANDS,
	dnf: SYSTEM_PM_SUBCOMMANDS,
	yum: SYSTEM_PM_SUBCOMMANDS,
	apk: SYSTEM_PM_SUBCOMMANDS,
	brew: SYSTEM_PM_SUBCOMMANDS,
	snap: SYSTEM_PM_SUBCOMMANDS,
	gem: GEM_SUBCOMMANDS,
	composer: COMPOSER_SUBCOMMANDS,
	go: GO_SUBCOMMANDS,
	dotnet: DOTNET_SUBCOMMANDS,
	winget: WINGET_SUBCOMMANDS,
	nuget: NUGET_SUBCOMMANDS,
};

/**
 * Read-only forms of otherwise-mutating git subcommands, keyed by
 * subcommand: `git stash list` inspects, `git stash` mutates.
 */
const READ_ONLY_GIT_FORMS: Record<string, Set<string>> = {
	stash: new Set(["list", "show"]),
	worktree: new Set(["list"]),
	submodule: new Set(["status", "summary"]),
};

/** Prefix commands to skip over to reach the command that actually runs. */
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"builtin",
	"nohup",
	"time",
	"nice",
	"stdbuf",
	"timeout",
	"xargs",
	// The words after these are a command that runs.
	"eval",
	"exec",
	"npx",
	"bunx",
	"pnpx",
]);

/** Shell reserved words that can precede the command word. */
const RESERVED_WORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"for",
	"case",
	"esac",
	"!",
	"{",
	"}",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Redirect targets that never persist data to a file. Temp locations are
 * also allowed: the run_commands description tells models to capture
 * long-running output in a tmp file, and that never touches the workspace.
 * `..` segments are rejected so a temp prefix cannot smuggle a path back
 * into the workspace (`/tmp/../home/user/project/x`).
 */
function isAllowedRedirectTarget(rawTarget: string): boolean {
	const target = rawTarget.replace(/["']/g, "");
	if (/^(\/dev\/(null|stdout|stderr|tty)|nul:?)$/i.test(target)) {
		return true;
	}
	if (target.includes("..")) {
		return false;
	}
	return (
		target.startsWith("/tmp/") ||
		target.startsWith("/var/tmp/") ||
		target.startsWith("$TMPDIR") ||
		target.startsWith("${TMPDIR") ||
		// Windows temp locations (cmd and PowerShell forms)
		/^%te?mp%/i.test(target) ||
		/^\$env:te?mp/i.test(target)
	);
}

/** Basename, lowercased, quotes and a trailing .exe stripped. */
function normalizeCommandName(word: string): string {
	const base = word.replace(/["']/g, "").split(/[/\\]/).pop() ?? word;
	return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Mask the parts of a command string that are data rather than commands, so
 * the blacklist scan below cannot false-positive on them: heredoc bodies are
 * dropped, and special characters inside quotes / behind backslash escapes /
 * after a comment marker are replaced with "_".
 *
 * One pass that knows which state it is in. Done as separate regex passes,
 * the apostrophe in `# don't` opened a quote that swallowed the next line's
 * `rm`, `<<EOF` inside a quoted grep pattern dropped every line after it as a
 * heredoc body, and `\rm` -- which runs rm -- read as `_m` (automaticum audit
 * 2026-11-08, readers 26).
 */
function maskNonCommandText(command: string): string {
	const SPECIAL = /[\s<>|;&$()`#\\]/;
	let out = "";
	let index = 0;
	let atWordStart = true;
	const pendingHeredocs: string[] = [];
	while (index < command.length) {
		const char = command[index] as string;
		if (char === "\n") {
			out += "\n";
			index += 1;
			atWordStart = true;
			// Heredoc bodies start on the line after their `<<`.
			while (pendingHeredocs.length > 0 && index < command.length) {
				const delimiter = pendingHeredocs[0] as string;
				const end = command.indexOf("\n", index);
				const line = command.slice(index, end === -1 ? undefined : end);
				index = end === -1 ? command.length : end + 1;
				if (line.replace(/^\t+/, "") === delimiter) {
					pendingHeredocs.shift();
				}
			}
			continue;
		}
		if (char === "\\") {
			const next = command[index + 1];
			// A line continuation joins the lines; an escaped special
			// character is literal text; an escaped letter is that letter.
			out +=
				next === undefined
					? ""
					: next === "\n"
						? " "
						: SPECIAL.test(next)
							? "_"
							: next;
			index += 2;
			atWordStart = false;
			continue;
		}
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			const end = close === -1 ? command.length : close + 1;
			out += command.slice(index, end).replace(/[\s<>|;&$()`#\\]/g, "_");
			index = end;
			atWordStart = false;
			continue;
		}
		if (char === "#" && atWordStart) {
			const end = command.indexOf("\n", index);
			index = end === -1 ? command.length : end;
			out += " ";
			continue;
		}
		if (
			char === "<" &&
			command[index + 1] === "<" &&
			command[index + 2] !== "<"
		) {
			const heredoc =
				/^<<-?\s*(?:"([^"]+)"|'([^']+)'|\\?([A-Za-z0-9_./-]+))/.exec(
					command.slice(index),
				);
			if (heredoc) {
				pendingHeredocs.push(
					(heredoc[1] ?? heredoc[2] ?? heredoc[3]) as string,
				);
				out += heredoc[0].replace(/["'\\]/g, "_");
				index += heredoc[0].length;
				atWordStart = false;
				continue;
			}
		}
		out += char;
		atWordStart = /[\s;&|()]/.test(char);
		index += 1;
	}
	return (
		out
			// Arithmetic expansion ($((3 > 2))) holds comparisons, not
			// commands or redirections.
			.replace(/\$\(\([\s\S]*?\)\)/g, "_")
			// So does a [[ ... ]] test: `[[ $a > $b ]]` compares strings.
			.replace(/\[\[[\s\S]*?\]\]/g, (test) => test.replace(/[<>]/g, "_"))
	);
}

/**
 * Value-taking options of each wrapper, so `sudo -u root rm` reaches `rm`
 * rather than stopping at `root`.
 */
const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
	sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "-C", "-S"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	xargs: new Set(["-I", "-i", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]),
	nice: new Set(["-n"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	npx: new Set(["-p", "--package"]),
};

/** Shells whose `-c` argument is a command line of its own. */
const NESTED_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Formatters, and the arguments that make them write rather than check. */
function formatterWrites(name: string, args: string[]): boolean {
	const has = (...flags: string[]) =>
		args.some((arg) =>
			flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
		);
	switch (name) {
		case "prettier":
			return has("--write", "-w");
		case "eslint":
		case "stylelint":
			return has("--fix");
		case "biome":
			return has("--write", "--apply", "--fix");
		case "black":
		case "isort":
			return !has("--check", "--diff");
		case "ruff":
			return (
				(args[0] === "format" && !has("--check", "--diff")) || has("--fix")
			);
		case "gofmt":
		case "goimports":
			return has("-w");
		case "rustfmt":
			return !has("--check");
		case "clang-format":
		case "autopep8":
			return has("-i", "--in-place");
		case "dprint":
			return args[0] === "fmt";
		default:
			return false;
	}
}

/** Check one command's tokens (command word + args) against the blacklist. */
function checkTokens(tokens: string[]): string | undefined {
	let index = 0;
	while (
		index < tokens.length &&
		(ENV_ASSIGNMENT.test(tokens[index]) || RESERVED_WORDS.has(tokens[index]))
	) {
		index += 1;
	}
	// Skip wrappers (sudo, env, xargs, timeout 30, ...) and their options.
	while (
		index < tokens.length &&
		WRAPPERS.has(normalizeCommandName(tokens[index]))
	) {
		const wrapper = normalizeCommandName(tokens[index]);
		const valued = WRAPPER_VALUE_OPTIONS[wrapper];
		index += 1;
		while (
			index < tokens.length &&
			(tokens[index].startsWith("-") ||
				tokens[index] === "{}" ||
				ENV_ASSIGNMENT.test(tokens[index]) ||
				/^\d+(\.\d+)?[smhd]?$/.test(tokens[index]))
		) {
			// `-u root`, `-s KILL`, `-I %`: the value is not the command.
			index += valued?.has(tokens[index]) ? 2 : 1;
		}
		// xargs -I % rm %: the placeholder is not the command either.
	}
	if (index >= tokens.length) {
		return undefined;
	}

	const rawName = normalizeCommandName(tokens[index]);
	// pip3.11 is pip.
	const name = /^pip[\d.]*$/.test(rawName) ? "pip" : rawName;
	const args = tokens.slice(index + 1);
	const dryRun = args.some((arg) => arg === "--dry-run" || arg === "--dryrun");

	// `bash -c "rm -rf src"`: the string is a command line of its own.
	if (NESTED_SHELLS.has(name)) {
		const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		const inner = flag === -1 ? undefined : args[flag + 1];
		return inner === undefined
			? undefined
			: findFileEditingCommand(inner.replace(/^(['"])([\s\S]*)\1$/, "$2"));
	}

	if (formatterWrites(name, args)) {
		return `\`${name}\` (rewrites files)`;
	}

	// Copying out to a temp location leaves the workspace alone.
	if (name === "cp") {
		const operands = args.filter((arg) => !arg.startsWith("-"));
		const target = operands[operands.length - 1];
		if (operands.length >= 2 && target && isAllowedRedirectTarget(target)) {
			return undefined;
		}
	}

	// `| tee /tmp/log` is the documented way to capture output; only file
	// arguments outside tmp are a mutation.
	if (name === "tee") {
		const fileArgs = args.filter((arg) => !arg.startsWith("-"));
		return fileArgs.some((arg) => !isAllowedRedirectTarget(arg))
			? "`tee`"
			: undefined;
	}

	if (BLOCKED_COMMANDS.has(name)) {
		return `\`${name}\``;
	}

	// `uv pip install` is pip.
	if (name === "uv" && args[0] === "pip") {
		const sub = args.slice(1).find((arg) => !arg.startsWith("-"));
		return sub && PIP_SUBCOMMANDS.has(sub) && !dryRun
			? `\`uv pip ${sub}\``
			: undefined;
	}

	if (name === "git") {
		const sub = args.find((arg) => !arg.startsWith("-"));
		const rest = sub === undefined ? [] : args.slice(args.indexOf(sub) + 1);
		// Listing branches and tags reads; deleting, renaming or creating one
		// writes .git (readers 26: `git branch -D main` ran in plan mode).
		if (sub === "branch") {
			const listing = rest.some((arg) =>
				[
					"-a",
					"-r",
					"-l",
					"--list",
					"-v",
					"-vv",
					"--all",
					"--remotes",
					"--show-current",
					"--contains",
					"--merged",
					"--no-merged",
				].includes(arg),
			);
			const writes = rest.some(
				(arg) =>
					/^-[dDmMcCu]$/.test(arg) ||
					[
						"--delete",
						"--move",
						"--copy",
						"--set-upstream-to",
						"--unset-upstream",
						"--edit-description",
					].some((flag) => arg.startsWith(flag)),
			);
			const creates = !listing && rest.some((arg) => !arg.startsWith("-"));
			if (writes || creates) return "`git branch` (changes branches)";
			return undefined;
		}
		if (sub === "tag") {
			const listing = rest.some(
				(arg) =>
					["-l", "--list", "-n", "--contains", "--points-at"].includes(arg) ||
					/^-n\d+$/.test(arg),
			);
			const writes = rest.some(
				(arg) =>
					/^-[dafs]$/.test(arg) || arg === "--delete" || arg === "--force",
			);
			if (writes || (!listing && rest.some((arg) => !arg.startsWith("-")))) {
				return "`git tag` (changes tags)";
			}
			return undefined;
		}
		// Dry runs and a bare `git submodule` (its status) read only.
		if (
			sub === "clean" &&
			rest.some((arg) => /^-[A-Za-z]*n/.test(arg) || arg === "--dry-run")
		) {
			return undefined;
		}
		if (sub === "submodule" && rest.length === 0) {
			return undefined;
		}
	}

	const subcommands = BLOCKED_SUBCOMMANDS[name];
	if (subcommands) {
		if (dryRun) {
			return undefined;
		}
		// Help output never mutates (`git switch --help`).
		if (
			name === "git" &&
			args.some((arg) => arg === "--help" || arg === "-h")
		) {
			return undefined;
		}
		// First non-option arg is the subcommand; `git -c k=v` / `git -C dir`
		// take a value, so skip that too.
		let cursor = 0;
		while (cursor < args.length && args[cursor].startsWith("-")) {
			cursor += name === "git" && /^-[cC]$/.test(args[cursor]) ? 2 : 1;
		}
		const subcommand = args[cursor]?.toLowerCase();
		if (subcommand && subcommands.has(subcommand)) {
			const next = args[cursor + 1]?.toLowerCase();
			if (
				name === "git" &&
				next !== undefined &&
				READ_ONLY_GIT_FORMS[subcommand]?.has(next)
			) {
				return undefined;
			}
			return `\`${name} ${subcommand}\``;
		}
		// Classic yarn with no subcommand runs an install.
		if (name === "yarn" && args.length === 0) {
			return "`yarn` (install)";
		}
		return undefined;
	}

	// `python -m pip install ...` is pip.
	if (/^python[\d.]*$/.test(name)) {
		const moduleIndex = args.indexOf("-m");
		const module =
			moduleIndex === -1 ? undefined : args[moduleIndex + 1]?.toLowerCase();
		if (module === "pip" || module === "pip3") {
			const subcommand = args
				.slice(moduleIndex + 2)
				.find((arg) => !arg.startsWith("-"))
				?.toLowerCase();
			if (subcommand && PIP_SUBCOMMANDS.has(subcommand)) {
				return `\`pip ${subcommand}\``;
			}
		}
		return undefined;
	}

	// In-place edit flags on otherwise read-only text tools. The flag cluster
	// must end at the lowercase `i` (optionally followed by a `.suffix`), so
	// value-taking uppercase flags like `perl -Ilib` do not match.
	// `-i` takes the rest of its cluster as a backup suffix, so `-ie` and
	// `perl -pie` are in-place edits: the letters before it must be flags
	// that take no value.
	if (
		(name === "sed" || name === "gsed") &&
		args.some((arg) => /^-[nErsuz]*i/.test(arg) || arg.startsWith("--in-place"))
	) {
		return "`sed -i` (in-place edit)";
	}
	if (name === "perl" && args.some((arg) => /^-[pnlaswTtWX0-9]*i/.test(arg))) {
		return "`perl -i` (in-place edit)";
	}
	if (/^[gnm]?awk$/.test(name)) {
		const usesInplace = args.some(
			(arg, argIndex) =>
				((arg === "-i" || arg === "--include") &&
					args[argIndex + 1]?.startsWith("inplace")) ||
				(arg.startsWith("-i") && arg.slice(2).startsWith("inplace")) ||
				arg.startsWith("--include=inplace"),
		);
		if (usesInplace) {
			return "`awk -i inplace` (in-place edit)";
		}
		return undefined;
	}
	if (name === "sort") {
		const target = outputTarget(args, /^-o$/, /^-o(.+)$/, "--output");
		return target !== undefined && !isAllowedRedirectTarget(target)
			? "`sort -o` (writes a file)"
			: undefined;
	}
	if (name === "curl") {
		// -O / --remote-name always write into the working directory.
		if (
			args.some(
				(arg) =>
					(!arg.startsWith("--") && /^-[A-Za-z]*O/.test(arg)) ||
					arg.startsWith("--remote-name"),
			)
		) {
			return "`curl -O` (writes a file)";
		}
		// -o /dev/null is the status-probe idiom, and /tmp is allowed.
		const target = outputTarget(
			args,
			/^-[A-Za-z]*o$/,
			/^-[A-Za-z]*o(.+)$/,
			"--output",
		);
		return target !== undefined && !isAllowedRedirectTarget(target)
			? "`curl -o` (writes a file)"
			: undefined;
	}
	if (name === "wget") {
		const readOnly = args.some(
			(arg, argIndex) =>
				arg === "--spider" ||
				/^-[A-Za-z]*O-$/.test(arg) ||
				arg === "--output-document=-" ||
				(arg === "-O" && args[argIndex + 1] === "-"),
		);
		return readOnly ? undefined : "`wget` (downloads files)";
	}
	if (name === "find") {
		if (args.includes("-delete")) {
			return "`find -delete`";
		}
		for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[argIndex])) {
				continue;
			}
			const tail: string[] = [];
			for (
				let cursor = argIndex + 1;
				cursor < args.length && args[cursor] !== ";" && args[cursor] !== "+";
				cursor += 1
			) {
				tail.push(args[cursor]);
			}
			const nested = checkTokens(tail);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	}

	return undefined;
}

/** The file an `-o`-style option names, attached or as the next argument. */
function outputTarget(
	args: readonly string[],
	alone: RegExp,
	attached: RegExp,
	long: string,
): string | undefined {
	for (let at = 0; at < args.length; at += 1) {
		const arg = args[at] as string;
		if (arg.startsWith("--")) {
			if (arg === long) return args[at + 1] ?? "";
			if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
			continue;
		}
		if (alone.test(arg)) return args[at + 1] ?? "";
		const match = attached.exec(arg);
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Inspect a run_commands entry and return a short description of the first
 * file-modifying construct found, or undefined when the command looks
 * read-only.
 */
export function findFileEditingCommand(
	command: string | StructuredCommandInput,
): string | undefined {
	if (typeof command !== "string") {
		// Structured argv is executed without shell parsing, so only the
		// executable and argv matter (a ">" argument is a literal string).
		return checkTokens([command.command, ...(command.args ?? [])]);
	}

	const masked = maskNonCommandText(command);

	// Output redirection to a file (`>`, `>>`, `&>`), allowing /dev sinks,
	// fd duplication (`2>&1`, `>&2`), and /tmp output capture.
	// `>|` overrides noclobber and writes all the same.
	const redirects = masked.matchAll(
		/(?:^|[^<>])(?:>{1,2}\|?|&>{1,2})\s*([^\s;&|<>()]+)/g,
	);
	for (const redirect of redirects) {
		if (!isAllowedRedirectTarget(redirect[1])) {
			return `output redirection (\`> ${redirect[1]}\`)`;
		}
	}

	// A quoted `bash -c '...'` / `eval '...'` string is a command line, though
	// masking made it one token: read it from the original.
	for (const nested of command.matchAll(
		/(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh\s+-[A-Za-z]*c[A-Za-z]*|eval)\s+(["'])([\s\S]*?)\1/g,
	)) {
		const blocked = findFileEditingCommand(nested[2] as string);
		if (blocked) {
			return blocked;
		}
	}

	// Check the command word of every simple command in the string.
	for (const segment of masked.split(/[\n;|&()`]+/)) {
		const blocked = checkTokens(segment.trim().split(/\s+/).filter(Boolean));
		if (blocked) {
			return blocked;
		}
	}
	return undefined;
}

/**
 * Tool error returned in place of executing a blocked command in plan mode.
 */
export function formatPlanModeBlockedCommandError(reason: string): string {
	return (
		`Command not executed: ${reason} can modify files, and file modifications are blocked in plan mode. ` +
		"You are in PLAN MODE — explore, analyze, and present a plan; do not make changes. " +
		"Use read-only commands to inspect the project (redirecting output to /tmp, or %TEMP% on Windows, is allowed), " +
		"and if this change is part of the task, put it in your plan so it can run after the user approves switching to act mode."
	);
}
