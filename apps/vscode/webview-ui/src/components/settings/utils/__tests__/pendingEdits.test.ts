import { afterEach, describe, expect, it, vi } from "vitest"
import {
	__resetPendingEdits,
	discardPendingEdits,
	flushPendingEdits,
	hasPendingEdits,
	registerPendingEdit,
} from "../pendingEdits"

afterEach(() => {
	__resetPendingEdits()
})

/**
 * A field that holds one value until something makes it save or drop it.
 *
 * `null` rather than `undefined` for "holding nothing": passing `undefined`
 * explicitly takes a parameter default, so `field(undefined)` would have built
 * a field that *is* holding something — which is how the first draft of these
 * tests managed to assert the opposite of what it set up.
 */
function field(initial: string | null = "typed") {
	const state = {
		value: initial === null ? undefined : initial,
		saved: undefined as string | undefined,
	}
	const edit = {
		pending: () => state.value !== undefined,
		flush: () => {
			state.saved = state.value
			state.value = undefined
			return Promise.resolve()
		},
		discard: () => {
			state.value = undefined
		},
	}
	return { state, edit }
}

describe("pending edits", () => {
	it("reports nothing pending when no field is holding one", () => {
		const { edit } = field(null)
		registerPendingEdit(edit)
		expect(hasPendingEdits()).toBe(false)
	})

	it("reports a pending edit while a field holds one", () => {
		const { edit } = field()
		registerPendingEdit(edit)
		expect(hasPendingEdits()).toBe(true)
	})

	it("saves every pending edit and waits for the writes", async () => {
		// The waiting is the whole point: a caller that captures the config
		// without awaiting the write captures the value from before the edit.
		let landed = false
		const slow = {
			pending: () => !landed,
			flush: () =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						landed = true
						resolve()
					}, 5)
				}),
			discard: () => {},
		}
		registerPendingEdit(slow)

		await flushPendingEdits()

		expect(landed).toBe(true)
	})

	it("leaves a field that has nothing pending alone", async () => {
		const { state, edit } = field(null)
		registerPendingEdit(edit)

		await flushPendingEdits()

		expect(state.saved).toBeUndefined()
	})

	it("saves the rest when one field refuses", async () => {
		const angry = {
			pending: () => true,
			flush: () => {
				throw new Error("nope")
			},
			discard: () => {},
		}
		const { state, edit } = field("kept")
		registerPendingEdit(angry)
		registerPendingEdit(edit)

		await flushPendingEdits()

		expect(state.saved).toBe("kept")
	})

	it("drops pending edits without saving them", () => {
		// A debounce that fires after a revert writes the value the user just
		// asked to discard, so revert has to end the wait the other way.
		const { state, edit } = field()
		registerPendingEdit(edit)

		discardPendingEdits()

		expect(state.saved).toBeUndefined()
		expect(hasPendingEdits()).toBe(false)
	})

	it("stops tracking a field once it unregisters", () => {
		const { edit } = field()
		const unregister = registerPendingEdit(edit)

		unregister()

		expect(hasPendingEdits()).toBe(false)
	})

	it("survives a flush that unmounts the field it is flushing", async () => {
		// `flush` writes, the write re-renders, and the field can go away mid
		// iteration; mutating the set while walking it would skip its neighbour.
		const { state, edit } = field("second")
		const unregister = registerPendingEdit({
			pending: () => true,
			flush: () => {
				unregisterFirst()
				return undefined
			},
			discard: () => {},
		})
		const unregisterFirst = unregister
		registerPendingEdit(edit)

		await flushPendingEdits()

		expect(state.saved).toBe("second")
	})

	it("does not fire a flush during a plain check", () => {
		const flush = vi.fn()
		registerPendingEdit({ pending: () => true, flush, discard: () => {} })

		expect(hasPendingEdits()).toBe(true)
		expect(flush).not.toHaveBeenCalled()
	})
})
