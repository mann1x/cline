import { describe, expect, it } from "vitest"
import { markDiffLines, markHunk } from "./diff-chars"

const changed = (segments: { text: string; same: boolean }[]) =>
	segments
		.filter((segment) => !segment.same)
		.map((segment) => segment.text)
		.join("|")

describe("markHunk", () => {
	it("marks a copy as all the same text, on both sides", () => {
		// Session 4odkd: the whole line sent back unchanged.
		const line = `    dDec(c,x){this.dc.forEach(d=>{${"c.fillRect(d.x-x,d.y-20,8,20);".repeat(10)}c.fill();}});});}`
		const marked = markHunk([line], [line])
		expect(marked?.added).toEqual([[{ text: line, same: true }]])
		expect(marked?.removed).toEqual([[{ text: line, same: true }]])
	})

	it("leaves only what changed unmarked on a long line", () => {
		const head = `    dDec(c,x){${"c.fillRect(d.x-x,d.y-20,8,20);".repeat(10)}c.fill();}});`
		const marked = markHunk([`${head}});}`], [`${head}}`])
		expect(changed(marked?.removed[0] ?? [])).toBe(");}")
		expect(changed(marked?.added[0] ?? [])).toBe("")
	})

	it("does not speckle a rewritten line with stray shared letters", () => {
		// `[` and `k]` are the shared ends; the lone `u` between is not kept.
		const marked = markHunk(["[quick]"], ["[xuyzk]"])
		expect(changed(marked?.added[0] ?? [])).toBe("xuyz")
	})

	it("finds shared text between two changes", () => {
		const marked = markHunk(["const total = price * count;"], ["let total = price * amount;"])
		// `count` and `amount` share `ount`, `const` and `let` their `t`.
		expect(changed(marked?.added[0] ?? [])).toBe("le|am")
		expect(changed(marked?.removed[0] ?? [])).toBe("cons|c")
	})

	it("splits the marks back onto their lines", () => {
		const marked = markHunk(["a();", "b();"], ["a();", "c();"])
		expect(marked?.added.map(changed)).toEqual(["", "c"])
		expect(marked?.removed.map(changed)).toEqual(["", "b"])
	})

	it("marks nothing in a hunk too large to compare", () => {
		const big = "x".repeat(150_000)
		expect(markHunk([big], [`${big}y`])).toBeUndefined()
	})

	it("treats a middle too large for the table as all changed, and stays fast", () => {
		const a = `start ${"ab".repeat(1500)} end`
		const b = `start ${"ba".repeat(1500)} end`
		const began = Date.now()
		const marked = markHunk([a], [b])
		expect(Date.now() - began).toBeLessThan(500)
		expect(marked?.added[0][0]).toEqual({ text: "start ", same: true })
	})
})

describe("markDiffLines", () => {
	it("pairs each run of removed lines with the added lines after it", () => {
		const marks = markDiffLines(["  context", "- old line", "+ new line", "  more", "+ only added", "- only removed"])
		expect(marks[0]).toBeUndefined()
		// A removed line stays all red: only the added side is marked.
		expect(marks[1]).toBeUndefined()
		expect(changed(marks[2] ?? [])).toBe("new")
		expect(marks[3]).toBeUndefined()
		// Nothing on the other side to share with: drawn as before.
		expect(marks[4]).toBeUndefined()
		expect(marks[5]).toBeUndefined()
	})
})
