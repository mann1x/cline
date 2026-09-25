/**
 * One set of Agents-node snapshots, read by both halves of the context-window
 * contract: the host suite asks `buildDelegatedAgentConnection` what window
 * each resolves to, and the webview suite asks the Agents tab what it shows.
 * Shared so the two answers are compared on the same input rather than on two
 * hand-copied ones that could drift apart.
 *
 * The case that made this necessary, pandorum 2026-09-25: Node1 on opencoti,
 * the panel showing 128000, the snapshot holding 65536, and the agents running
 * at 256000 -- the `models.json` catalog entry for the same model id.
 */

export const NODE_MODEL_ID = "v9-agentic.gguf"

/** What the shared `models.json` catalog says about {@link NODE_MODEL_ID}. */
export const CATALOG_CONTEXT_WINDOW = 256_000

export interface NodeWindowCase {
	label: string
	providerConfig: Record<string, unknown>
	/** The window the tab shows and the agents run at; `undefined` is "the tab names none". */
	expected: number | undefined
}

export const NODE_WINDOW_CASES: readonly NodeWindowCase[] = [
	{
		label: "contextWindow",
		providerConfig: { selectedModelId: NODE_MODEL_ID, contextWindow: 128_000 },
		expected: 128_000,
	},
	{
		label: "selectedModelOverrides.contextWindow",
		providerConfig: { selectedModelId: NODE_MODEL_ID, selectedModelOverrides: { contextWindow: 128_000 } },
		expected: 128_000,
	},
	{
		label: "modelOverrides.contextWindow",
		providerConfig: { selectedModelId: NODE_MODEL_ID, modelOverrides: { contextWindow: 128_000 } },
		expected: 128_000,
	},
	// 128000 is also the panel's safe default, so a panel showing the default
	// passes the three above by coincidence -- which is how the bug hid. These
	// cannot be met that way.
	{
		label: "contextWindow (98304)",
		providerConfig: { selectedModelId: NODE_MODEL_ID, contextWindow: 98_304 },
		expected: 98_304,
	},
	{
		label: "selectedModelOverrides.contextWindow (98304)",
		providerConfig: { selectedModelId: NODE_MODEL_ID, selectedModelOverrides: { contextWindow: 98_304 } },
		expected: 98_304,
	},
	{
		label: "modelOverrides.contextWindow (98304)",
		providerConfig: { selectedModelId: NODE_MODEL_ID, modelOverrides: { contextWindow: 98_304 } },
		expected: 98_304,
	},
	{
		label: "contextWindow over a disagreeing override",
		providerConfig: {
			selectedModelId: NODE_MODEL_ID,
			contextWindow: 65_536,
			selectedModelOverrides: { contextWindow: 32_768, maxTokens: 8_000 },
		},
		expected: 65_536,
	},
	{
		label: "nothing (a cleared box stores zero)",
		providerConfig: { selectedModelId: NODE_MODEL_ID, contextWindow: 0 },
		expected: undefined,
	},
]

/** A stored Agents-node snapshot on opencoti holding `providerConfig`. */
export function opencotiNodeSnapshot(providerConfig: Record<string, unknown>): string {
	return JSON.stringify({ global: {}, mode: { apiProvider: "opencoti" }, providerConfig })
}
