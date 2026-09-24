import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSandboxBinariesDir } from "./sandbox-binaries";

describe("resolveSandboxBinariesDir", () => {
	it("finds the monorepo assets/sandbox dir from a source run", () => {
		// In a source/test run the module lives under apps/cli/src/utils, so the
		// upward walk reaches apps/vscode/assets/sandbox at the repo root.
		const dir = resolveSandboxBinariesDir();
		expect(dir).toBeDefined();
		expect(dir?.replace(/\\/g, "/")).toMatch(/apps\/vscode\/assets\/sandbox$/);
		expect(existsSync(dir as string)).toBe(true);
	});

	it("returns a directory that actually holds a platform launcher", () => {
		const dir = resolveSandboxBinariesDir() as string;
		const anyLauncher = [
			"cerebriline-sandbox-x64",
			"cerebriline-sandbox-arm64",
			"cerebriline-sandbox-darwin-x64",
			"cerebriline-sandbox-darwin-arm64",
			"cerebriline-sandbox.exe",
		].some((name) => existsSync(`${dir}/${name}`));
		expect(anyLauncher).toBe(true);
	});
});
