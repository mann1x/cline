import { describe, expect, it } from "vitest"
// The real core, by path: this suite's `@cline/core` is a stub whose tools
// carry no descriptions, and a drift test measured against a stub measures
// nothing. `dist` rather than `src` because `dist` is what the vsix bundles,
// so this compares the catalog against the build that ships.
import {
	createAskLspTool,
	createBrowserTool,
	createBuiltinTools,
	createCheckFileTool,
	createListFilesTool,
	MAX_READ_REFUSAL_CHARS,
} from "../../node_modules/@cline/core/dist/index.js"
import { DEFAULT_READ_LIMIT_CHARS, SELECTABLE_TOOLS } from "./tool-selection"

/**
 * Rebuild every selectable tool and measure it.
 *
 * The catalog carries a token figure per tool so the panel can say what
 * switching one off buys, and a hand-written number in a file nobody rebuilds
 * is a number that rots. This is what stops it: a description or a schema that
 * grows past a few percent fails here, and the fix is to write down what the
 * tool now costs.
 */
/** Only the three fields that go on the wire; the executors are irrelevant here. */
interface WireTool {
	name: string
	description?: string
	inputSchema?: unknown
}

function buildEveryTool(): WireTool[] {
	const stub = { cwd: process.cwd(), onError: () => {} }
	return [
		...createBuiltinTools({
			cwd: process.cwd(),
			enableReadFiles: true,
			enableSearch: true,
			enableBash: true,
			enableWebFetch: true,
			enableEditor: true,
			enableGrep: true,
			enableSed: true,
			enableAwk: true,
		}),
		createCheckFileTool({ cwd: stub.cwd }),
		createAskLspTool({ ...stub, provider: { readLine: async () => undefined } as never }),
		createListFilesTool({ ...stub, createLister: async () => ({ roots: () => [] }) as never }),
		createBrowserTool({ ...stub, createDriver: async () => ({}) as never }),
	]
}

/** What a provider serializes: everything else stays on this side of the wire. */
function wireTokens(tool: WireTool): number {
	const serialized = JSON.stringify({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	})
	return Math.ceil(serialized.length / 4)
}

describe("the selectable tool catalog", () => {
	const built = new Map(buildEveryTool().map((tool) => [tool.name, tool] as const))

	it("names a tool that exists for every entry", () => {
		for (const entry of SELECTABLE_TOOLS) {
			expect(built.has(entry.name), `no tool named ${entry.name}`).toBe(true)
		}
	})

	it("lists every unconditional tool", () => {
		// The other direction: a tool added to the always-on set has to appear in
		// the panel, or it is a cost nobody can decline. A conditional tool does
		// not belong here -- see the module's own comment for why -- so this
		// compares against what an unconditional build produces.
		const listed = new Set(SELECTABLE_TOOLS.map((entry) => entry.name))
		for (const name of built.keys()) {
			expect(listed.has(name), `${name} is built unconditionally but not selectable`).toBe(true)
		}
	})

	it("records what each tool actually costs", () => {
		for (const entry of SELECTABLE_TOOLS) {
			const tool = built.get(entry.name)
			if (!tool) {
				continue
			}
			const measured = wireTokens(tool)
			// Five percent: enough that a reworded sentence does not fail the
			// build, tight enough that a new parameter or a rewritten
			// description does.
			expect(
				Math.abs(measured - entry.tokens) / entry.tokens,
				`${entry.name} is ${measured} tokens, catalog says ${entry.tokens}`,
			).toBeLessThan(0.05)
		}
	})

	// The panel shows this in a placeholder as "the default". A copy that
	// drifted from the runtime's would put a number on screen no session uses.
	it("shows the threshold the runtime actually applies", () => {
		expect(DEFAULT_READ_LIMIT_CHARS).toBe(MAX_READ_REFUSAL_CHARS)
	})
})
