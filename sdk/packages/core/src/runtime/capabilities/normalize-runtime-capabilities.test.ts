import { describe, expect, it } from "vitest";
import { createReadReceipts } from "../../extensions/tools";
import { normalizeRuntimeCapabilities } from "./normalize-runtime-capabilities";

/**
 * The read registry is a capability, and capabilities are merged by an explicit
 * field list. A field nobody copies is a field that silently never arrives:
 * 4.100.105 shipped `grep`/`sed`/`awk` guarding against a registry the VS Code
 * host's reader never wrote to, so every in-place `sed` was refused with "has
 * not been read in this session" while `read_files` calls on that very path sat
 * in the same transcript.
 */
describe("normalizeRuntimeCapabilities", () => {
	it("carries the read receipts through", () => {
		const receipts = createReadReceipts();
		const normalized = normalizeRuntimeCapabilities({ readReceipts: receipts });
		expect(normalized?.readReceipts).toBe(receipts);
	});

	it("keeps the receipts when they arrive alongside executors", () => {
		const receipts = createReadReceipts();
		const normalized = normalizeRuntimeCapabilities(
			{ toolExecutors: { readFile: (async () => []) as never } },
			{ readReceipts: receipts },
		);
		expect(normalized?.readReceipts).toBe(receipts);
		expect(normalized?.toolExecutors?.readFile).toBeDefined();
	});

	it("lets a later source replace the registry", () => {
		const first = createReadReceipts();
		const second = createReadReceipts();
		const normalized = normalizeRuntimeCapabilities(
			{ readReceipts: first },
			{ readReceipts: second },
		);
		expect(normalized?.readReceipts).toBe(second);
	});

	it("is still undefined when nothing was supplied", () => {
		expect(normalizeRuntimeCapabilities(undefined, {})).toBeUndefined();
	});

	it("survives on its own, with no executors and no approver", () => {
		// Otherwise the whole capabilities object collapses to undefined and the
		// registry is dropped on the way down.
		const receipts = createReadReceipts();
		expect(normalizeRuntimeCapabilities({ readReceipts: receipts })).toEqual({
			readReceipts: receipts,
		});
	});
});
