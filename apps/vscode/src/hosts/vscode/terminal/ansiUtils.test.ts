import { describe, expect, it } from "vitest"
import { stripAnsi } from "./ansiUtils"

const ESC = "\u001B"
const BEL = "\u0007"
/** `ESC \\` -- the string terminator. */
const ST = `${ESC}\\`

describe("stripAnsi", () => {
	// The reason this exists. PowerShell's shell integration sets the window
	// title on every command, and the title has spaces in it. The payload
	// charset inherited from `ansi-regex` has no space in it, so this used to
	// leave `;pwsh in test` and the terminator sitting in the captured output --
	// which the model then read back as part of what its command printed.
	it("removes an OSC title whose payload contains spaces", () => {
		const output = `{"ok":false,"frames_run":0}\n${ESC}]0;pwsh in test${ST}\n`

		expect(stripAnsi(output)).toBe('{"ok":false,"frames_run":0}\n\n')
	})

	it("removes an OSC terminated by BEL as well as by ST", () => {
		expect(stripAnsi(`a${ESC}]0;pwsh in test${BEL}b`)).toBe("ab")
		expect(stripAnsi(`a${ESC}]2;a title${ST}b`)).toBe("ab")
	})

	// The whole point of a lazy payload: one unterminated introducer must not
	// eat everything up to some unrelated terminator later in the stream.
	it("stops an OSC at its own terminator, not a later one", () => {
		expect(stripAnsi(`${ESC}]0;one${ST}keep me${ESC}]0;two${ST}`)).toBe("keep me")
	})

	it("still strips the colour and cursor sequences it always did", () => {
		expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red")
		expect(stripAnsi(`${ESC}[2J${ESC}[H cleared`)).toBe(" cleared")
	})

	it("leaves ordinary output alone", () => {
		expect(stripAnsi("no escapes here\nline two\t tabbed")).toBe("no escapes here\nline two\t tabbed")
	})
})
