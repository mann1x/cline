import { describe, expect, it } from "vitest"
import {
	addRemoteWorkspace,
	DEFAULT_REMOTE_RETENTION_DAYS,
	duplicateRemoteTerminalNames,
	expiredRemoteWorkspaces,
	isUsableRemoteTerminal,
	markRemoteWorkspacesDeleted,
	mergeRemoteTerminals,
	parseDiscoveredRemoteTerminals,
	parseRemoteTerminals,
	parseRemoteWorkspaces,
	serializeRemoteTerminals,
} from "./remote-terminals"

const DAY = 24 * 60 * 60 * 1000

describe("parseRemoteTerminals", () => {
	it("reads what the tab stores and defaults the retention to 7 days", () => {
		const parsed = parseRemoteTerminals(
			JSON.stringify({
				openWebUiUrl: " http://owui:3003 ",
				terminals: [
					{ name: "bench-app", machineId: "solidpc-bench-app", description: "benchmarks" },
					{ name: "general", machineId: "solidpc-open-terminal", enabled: false },
					"junk",
				],
			}),
		)
		expect(parsed).toEqual({
			openWebUiUrl: "http://owui:3003",
			retentionDays: DEFAULT_REMOTE_RETENTION_DAYS,
			terminals: [
				{ name: "bench-app", machineId: "solidpc-bench-app", description: "benchmarks" },
				{ name: "general", machineId: "solidpc-open-terminal", enabled: false },
			],
		})
		expect(parseRemoteTerminals(serializeRemoteTerminals(parsed))).toEqual(parsed)
	})

	it("survives nothing stored and broken JSON", () => {
		expect(parseRemoteTerminals(undefined)).toEqual({ openWebUiUrl: "", retentionDays: 7, terminals: [] })
		expect(parseRemoteTerminals("{nope").terminals).toEqual([])
		expect(parseRemoteTerminals(JSON.stringify({ retentionDays: 0 })).retentionDays).toBe(0)
	})

	it("offers only named, pointed, switched-on terminals and finds duplicate names", () => {
		expect(isUsableRemoteTerminal({ name: "a", machineId: "m" })).toBe(true)
		expect(isUsableRemoteTerminal({ name: "a", machineId: "m", enabled: false })).toBe(false)
		expect(isUsableRemoteTerminal({ name: "", machineId: "m" })).toBe(false)
		expect(
			duplicateRemoteTerminalNames([
				{ name: "Bench", machineId: "a" },
				{ name: "bench ", machineId: "b" },
			]),
		).toEqual(["bench"])
	})
})

describe("the workspace registry", () => {
	const ws = {
		terminal: "bench-app",
		machineId: "solidpc-bench-app",
		workspaceId: "1790_a",
		path: "/home/u/cerebriline/1790_a",
	}

	it("lists a workspace once, and starts its clock when the conversation is deleted", () => {
		const once = addRemoteWorkspace([], ws, 100)
		expect(addRemoteWorkspace(once, ws, 200)).toEqual(once)
		const deleted = markRemoteWorkspacesDeleted(once, new Set(["1790_a"]), 1_000)
		expect(deleted[0].deletedAt).toBe(1_000)
		// A second delete does not restart the clock.
		expect(markRemoteWorkspacesDeleted(deleted, new Set(["1790_a"]), 5_000)[0].deletedAt).toBe(1_000)
		expect(parseRemoteWorkspaces(JSON.stringify(deleted))).toEqual(deleted)
	})

	it("expires a workspace only after the retention period, and never one still in use", () => {
		const entries = [
			{ ...ws, firstUsed: 0, deletedAt: 0 },
			{ ...ws, workspaceId: "1790_b", firstUsed: 0, deletedAt: 6 * DAY },
			{ ...ws, workspaceId: "1790_c", firstUsed: 0 },
		]
		expect(expiredRemoteWorkspaces(entries, 7, 7 * DAY).map((entry) => entry.workspaceId)).toEqual(["1790_a"])
		expect(expiredRemoteWorkspaces(entries, 7, 13 * DAY).map((entry) => entry.workspaceId)).toEqual(["1790_a", "1790_b"])
	})
})

describe("mergeRemoteTerminals", () => {
	const discovered = [
		{ name: "solidpc", machineId: "solidpc-open-terminal" },
		{ name: "bench-app", machineId: "solidpc-bench-app" },
	]

	it("offers every machine Open WebUI lists, with no row needed", () => {
		expect(mergeRemoteTerminals([], discovered)).toEqual([
			{
				name: "solidpc",
				machineId: "solidpc-open-terminal",
				enabled: true,
				source: "openwebui",
				discoveredName: "solidpc",
			},
			{
				name: "bench-app",
				machineId: "solidpc-bench-app",
				enabled: true,
				source: "openwebui",
				discoveredName: "bench-app",
			},
		])
	})

	it("lets a row rename, describe or switch off a listed machine, and keeps rows for unlisted ones", () => {
		const merged = mergeRemoteTerminals(
			[
				{ name: "open-terminal", machineId: "solidpc-open-terminal", description: "general box" },
				{ name: "", machineId: "solidpc-bench-app", enabled: false },
				{ name: "gpu", machineId: "elsewhere-gpu" },
			],
			discovered,
		)
		expect(merged.map((entry) => [entry.name, entry.enabled, entry.source, entry.storedIndex])).toEqual([
			["open-terminal", true, "openwebui", 0],
			["bench-app", false, "openwebui", 1],
			["gpu", true, "manual", 2],
		])
		expect(merged[0].description).toBe("general box")
	})

	it("reads the discovery cache, keeping an error beside the old machines", () => {
		const parsed = parseDiscoveredRemoteTerminals(JSON.stringify({ at: 5, machines: [{ machineId: "m" }], error: "401" }))
		expect(parsed).toEqual({ at: 5, machines: [{ name: "m", machineId: "m" }], error: "401" })
		expect(parseDiscoveredRemoteTerminals("junk")).toEqual({ at: 0, machines: [] })
	})
})
