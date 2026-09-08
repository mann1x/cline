import { describe, expect, it } from "vitest"
import { createScopedSnapshotWriter, scopedSnapshotPatches } from "../scopedSnapshotWriter"

const EMPTY = { global: {}, mode: {} }

describe("createScopedSnapshotWriter", () => {
	it("lets a second write in the same turn build on the first", async () => {
		// mann1x/cline#67: editing the context window fires write() and
		// commitModelSelection() from one onChange. Both used to start from the
		// render's snapshot, so the model selection put back a providerConfig
		// with no contextWindow in it.
		const stored: unknown[] = []
		const writer = createScopedSnapshotWriter(EMPTY, async (s) => {
			stored.push(structuredClone(s))
		})

		const first = writer.mutate((s) => ({
			...s,
			providerConfig: { ...(s.providerConfig ?? {}), contextWindow: 262144 },
		}))
		const second = writer.mutate((s) => ({
			...s,
			providerConfig: { ...(s.providerConfig ?? {}), selectedModelId: "qwen3" },
		}))
		await Promise.all([first, second])

		expect(writer.current().providerConfig).toEqual({
			contextWindow: 262144,
			selectedModelId: "qwen3",
		})
		// And what was stored last is what the panel holds.
		expect(stored.at(-1)).toEqual(writer.current())
	})

	it("persists in the order the edits were applied", async () => {
		const order: number[] = []
		const writer = createScopedSnapshotWriter(EMPTY, async (s) => {
			// A slow first write must still be stored before the second.
			const n = (s.global as { n: number }).n
			if (n === 1) {
				await new Promise((r) => setTimeout(r, 20))
			}
			order.push(n)
		})

		await Promise.all([
			writer.mutate((s) => ({ ...s, global: { n: 1 } })),
			writer.mutate((s) => ({ ...s, global: { n: 2 } })),
		])

		expect(order).toEqual([1, 2])
	})

	it("does not take an incoming prop while its own writes are in flight", async () => {
		// The prop lags a round trip behind, so mid-flight it is the state
		// before the edit — adopting it would undo what the user just typed.
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		const writer = createScopedSnapshotWriter(EMPTY, async () => {
			await gate
		})

		const write = writer.mutate((s) => ({ ...s, global: { timeout: 300000 } }))
		writer.adopt({ global: {}, mode: {} })
		expect(writer.current().global).toEqual({ timeout: 300000 })

		release()
		await write
		// Once nothing is in flight the prop is authoritative again.
		writer.adopt({ global: { timeout: 300000 }, mode: { x: 1 } })
		expect(writer.current().mode).toEqual({ x: 1 })
	})

	it("keeps accepting edits after a write fails", async () => {
		let calls = 0
		const writer = createScopedSnapshotWriter(EMPTY, async () => {
			calls += 1
			if (calls === 1) {
				throw new Error("host said no")
			}
		})

		await expect(writer.mutate((s) => ({ ...s, global: { a: 1 } }))).rejects.toThrow("host said no")
		await writer.mutate((s) => ({ ...s, global: { ...s.global, b: 2 } }))

		expect(calls).toBe(2)
		expect(writer.current().global).toEqual({ a: 1, b: 2 })
	})
})

describe("the edits a scoped tab makes", () => {
	const stored = (writer: ReturnType<typeof createScopedSnapshotWriter>) => writer.current().providerConfig ?? {}

	it("keeps the context window when the model selection is committed with it", async () => {
		// mann1x/cline#67, exactly as the Ollama panel fires it: one onChange
		// calls write({contextWindow}) and then commitModelSelection(...).
		const writer = createScopedSnapshotWriter(
			{ global: {}, mode: {}, providerConfig: { contextWindow: 1_000_000 } },
			async () => {},
		)

		await Promise.all([
			writer.mutate(scopedSnapshotPatches.providerSettings({ contextWindow: 262144 })),
			writer.mutate(scopedSnapshotPatches.modelSelection({ modelId: "qwen3-coder" })),
		])

		expect(stored(writer).contextWindow).toBe(262144)
		expect(stored(writer).selectedModelId).toBe("qwen3-coder")
	})

	it("keeps the per-turn max the selection carries", async () => {
		// The scope used to take only a model id, so `overrides` — where
		// Per-Turn Max Output Tokens lives — never reached the snapshot.
		const writer = createScopedSnapshotWriter({ global: {}, mode: {} }, async () => {})

		await writer.mutate(scopedSnapshotPatches.modelSelection({ modelId: "qwen3-coder", overrides: { maxTokens: 8192 } }))

		expect(stored(writer).selectedModelOverrides).toEqual({ maxTokens: 8192 })
	})

	it("does not let a settings edit roll back a provider edit", async () => {
		// Typing a request timeout straight after a context window: the
		// settings save rebuilds the snapshot, and used to carry the render's
		// providerConfig rather than the current one.
		const writer = createScopedSnapshotWriter({ global: {}, mode: {} }, async () => {})

		await Promise.all([
			writer.mutate(scopedSnapshotPatches.providerSettings({ contextWindow: 262144 })),
			writer.mutate(scopedSnapshotPatches.settings({ global: { requestTimeoutMs: 600000 }, mode: {} })),
		])

		expect(writer.current().global).toEqual({ requestTimeoutMs: 600000 })
		expect(stored(writer).contextWindow).toBe(262144)
	})
})
