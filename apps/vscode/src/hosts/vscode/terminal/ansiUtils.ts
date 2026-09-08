function ansiRegex({ onlyFirst = false } = {}) {
	// Valid string terminator sequences are BEL, ESC\, and 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)"
	// OSC first, and deliberately permissive about its payload.
	//
	// The branches below come from `ansi-regex`, whose OSC payload charset has
	// no space in it. A shell-integration title is mostly spaces --
	// `ESC ] 0 ; pwsh in test ESC \\` -- so that branch failed, and the CSI
	// branch underneath then matched the `ESC ] 0` prefix on its own. The
	// introducer was stripped and `;pwsh in test` plus the terminator were left
	// in the command's output, where the model read them as part of what it
	// ran. Measured on both `run_commands` calls of one session.
	//
	// An OSC payload is arbitrary text, so the only thing that ends it is the
	// terminator. Lazy, so a stray introducer cannot swallow the output up to
	// some later BEL.
	const OSC = `(?:\\u001B\\u005D|\\u009D)[\\s\\S]*?${ST}`
	const pattern = [
		OSC,
		`[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ST})`,
		"(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
	].join("|")

	return new RegExp(pattern, onlyFirst ? undefined : "g")
}

export function stripAnsi(string: string): string {
	return string.replace(ansiRegex(), "")
}
