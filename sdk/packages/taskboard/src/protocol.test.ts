import { describe, expect, it } from "vitest";
import { readBoardSnapshot } from "./protocol";

const task = {
	id: "T1",
	title: "Write it",
	status: "pending",
	priority: "M",
	depends: [],
	openDepends: [],
	acceptance: [],
	later: false,
	files: [],
	notes: [],
	ready: true,
	blocked: false,
};

describe("readBoardSnapshot", () => {
	it("reads a board's text and drops what is not a task", () => {
		const snapshot = readBoardSnapshot(
			JSON.stringify({ tasks: [task, { id: "T2" }, null], layers: [["T1"]] }),
		);
		expect(snapshot?.tasks.map((entry) => entry.id)).toEqual(["T1"]);
		expect(snapshot?.layers).toEqual([["T1"]]);
	});

	it("answers undefined for no text, broken text, or something else", () => {
		expect(readBoardSnapshot(undefined)).toBeUndefined();
		expect(readBoardSnapshot("{not json")).toBeUndefined();
		expect(readBoardSnapshot("null")).toBeUndefined();
		expect(readBoardSnapshot(JSON.stringify({ items: [] }))).toBeUndefined();
	});

	it("keeps a board without layers", () => {
		expect(
			readBoardSnapshot(JSON.stringify({ tasks: [task] }))?.layers,
		).toEqual([]);
	});
});
