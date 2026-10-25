import { afterEach, describe, expect, it } from "vitest"
import * as vscode from "vscode"
import { getWorkspacePaths } from "../hostbridge/workspace/getWorkspacePaths"
import { createVscodeWorkspaceLister } from "../list-files-support"

// An SSH FS folder has an fsPath too (/home/dev/project here, C:\home\dev\project
// on Windows), naming a local directory that is not the folder.
const folders = [
	{ name: "local", index: 0, uri: { scheme: "file", fsPath: "/work/local", path: "/work/local" } },
	{
		name: "project",
		index: 1,
		uri: { scheme: "ssh", authority: "box", fsPath: "/home/dev/project", path: "/home/dev/project" },
	},
]

describe("workspace roots", () => {
	// The vitest stub's workspace, whose folders are a plain settable array.
	const workspace = vscode.workspace as unknown as { workspaceFolders: unknown[] }
	afterEach(() => {
		workspace.workspaceFolders = []
	})

	it("getWorkspacePaths leaves out folders that are not on this machine's disk", async () => {
		workspace.workspaceFolders = folders

		expect((await getWorkspacePaths({})).paths).toEqual(["/work/local"])
	})

	it("the workspace lister's roots leave them out too", () => {
		workspace.workspaceFolders = folders

		expect(createVscodeWorkspaceLister().roots()).toEqual(["/work/local"])
	})

	it("an SSH FS-only window has no workspace path", async () => {
		workspace.workspaceFolders = [folders[1]]

		expect((await getWorkspacePaths({})).paths).toEqual([])
	})
})
