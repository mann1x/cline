import { describe, expect, it } from "vitest"
import { parseCommandArgs, parseEnvLines } from "./AddLocalServerForm"

/**
 * The arguments are typed as a line of shell, and stored as a list. Nothing
 * runs them through a shell — the server is spawned from the list — so the
 * parsing has to do the one thing a user expects from that box: keep a quoted
 * path with a space in it in one piece.
 */
describe("parseCommandArgs", () => {
	it("splits on spaces", () => {
		expect(parseCommandArgs("-y @azure/mcp@latest")).toEqual(["-y", "@azure/mcp@latest"])
	})

	it("takes one argument per line", () => {
		expect(parseCommandArgs("-y\n@azure/mcp@latest")).toEqual(["-y", "@azure/mcp@latest"])
	})

	it("keeps a quoted path with spaces together", () => {
		expect(parseCommandArgs('--root "C:\\Program Files\\thing"')).toEqual(["--root", "C:\\Program Files\\thing"])
	})

	it("handles single quotes the same way", () => {
		expect(parseCommandArgs("--name 'my server'")).toEqual(["--name", "my server"])
	})

	it("keeps an empty quoted argument, which is not the same as no argument", () => {
		expect(parseCommandArgs('--prefix ""')).toEqual(["--prefix", ""])
	})

	it("has nothing to say about an empty box", () => {
		expect(parseCommandArgs("")).toEqual([])
		expect(parseCommandArgs("   \n  ")).toEqual([])
	})
})

describe("parseEnvLines", () => {
	it("reads KEY=value lines", () => {
		expect(parseEnvLines("API_TOKEN=abc\nREGION=eu")).toEqual({ API_TOKEN: "abc", REGION: "eu" })
	})

	it("keeps everything after the first separator", () => {
		// A connection string is mostly `=` signs.
		expect(parseEnvLines("DSN=key=value;other=thing")).toEqual({ DSN: "key=value;other=thing" })
	})

	it("ignores blank lines and comments", () => {
		expect(parseEnvLines("# a note\n\nA=1")).toEqual({ A: "1" })
	})

	it("ignores a line with no key", () => {
		expect(parseEnvLines("=orphan\nA=1")).toEqual({ A: "1" })
	})
})
