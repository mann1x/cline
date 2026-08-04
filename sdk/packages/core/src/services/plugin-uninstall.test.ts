import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setClineDir, setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGlobalSettings, writeGlobalSettings } from "./global-settings";
import { uninstallPlugin } from "./plugin-uninstall";

/**
 * Armed filesystem failures for the two tests about what uninstall does when a
 * step fails partway through.
 *
 * Injected rather than provoked with `chmod`, because a permission bit only
 * denies a process the kernel checks it for. It does not on Windows, where
 * read-only directory permissions do not prevent removing the files inside
 * them, and it does not for root, which bypasses the check outright
 * (CAP_DAC_OVERRIDE) — so under either the simulated failure never happened,
 * uninstall succeeded, and the tests failed asserting a rejection that the
 * setup had quietly made impossible. Containers commonly run as root, which is
 * to say the environment where these two tests were skipped or broken was the
 * ordinary one.
 */
const failure = vi.hoisted(() => ({
	mcpSettingsCleanup: false,
	removePath: undefined as string | undefined,
}));

vi.mock("./plugin-mcp-settings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./plugin-mcp-settings")>();
	return {
		...actual,
		removePluginMcpServersFromSettings: (
			options: Parameters<typeof actual.removePluginMcpServersFromSettings>[0],
		) => {
			if (failure.mcpSettingsCleanup) {
				throw new Error(
					"EACCES: permission denied, open 'cline_mcp_settings.json'",
				);
			}
			return actual.removePluginMcpServersFromSettings(options);
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		// Armed for one exact path at a time; everything else, including this
		// file's own temp-directory cleanup, goes to the real implementation.
		rmSync: (
			path: Parameters<typeof actual.rmSync>[0],
			options?: Parameters<typeof actual.rmSync>[1],
		) => {
			if (
				failure.removePath !== undefined &&
				resolve(String(path)) === failure.removePath
			) {
				throw new Error(`EACCES: permission denied, unlink '${String(path)}'`);
			}
			return actual.rmSync(path, options);
		},
	};
});

describe("plugin uninstall service", () => {
	let root = "";
	let home = "";
	let originalHome: string | undefined;
	let originalClineDir: string | undefined;
	let originalClineDataDir: string | undefined;
	let originalGlobalSettingsPath: string | undefined;
	let originalMcpSettingsPath: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "core-plugin-uninstall-"));
		home = join(root, "home");
		originalHome = process.env.HOME;
		originalClineDir = process.env.CLINE_DIR;
		originalClineDataDir = process.env.CLINE_DATA_DIR;
		originalGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH;
		originalMcpSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;
		process.env.HOME = home;
		process.env.CLINE_DIR = join(home, ".cline");
		process.env.CLINE_DATA_DIR = join(home, ".cline", "data");
		process.env.CLINE_GLOBAL_SETTINGS_PATH = join(
			home,
			".cline",
			"data",
			"settings",
			"global-settings.json",
		);
		setHomeDir(home);
		setClineDir(process.env.CLINE_DIR);
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalClineDir === undefined) {
			delete process.env.CLINE_DIR;
		} else {
			process.env.CLINE_DIR = originalClineDir;
		}
		if (originalClineDataDir === undefined) {
			delete process.env.CLINE_DATA_DIR;
		} else {
			process.env.CLINE_DATA_DIR = originalClineDataDir;
		}
		if (originalGlobalSettingsPath === undefined) {
			delete process.env.CLINE_GLOBAL_SETTINGS_PATH;
		} else {
			process.env.CLINE_GLOBAL_SETTINGS_PATH = originalGlobalSettingsPath;
		}
		if (originalMcpSettingsPath === undefined) {
			delete process.env.CLINE_MCP_SETTINGS_PATH;
		} else {
			process.env.CLINE_MCP_SETTINGS_PATH = originalMcpSettingsPath;
		}
		failure.mcpSettingsCleanup = false;
		failure.removePath = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("uninstalls an installed package plugin by package name", async () => {
		const installPath = join(
			home,
			".cline",
			"plugins",
			"_installed",
			"local",
			"bundled-skills-demo-123456789abc",
		);
		const entryPath = join(installPath, "package", "index.ts");
		await mkdir(join(installPath, "package"), { recursive: true });
		await writeFile(
			join(installPath, "package.json"),
			JSON.stringify(
				{
					name: "cline-installed-plugin-test",
					cline: {
						plugins: [{ paths: ["./package/index.ts"] }],
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await writeFile(
			join(installPath, "package", "package.json"),
			JSON.stringify({ name: "cline-internal-bundled-skills-demo" }, null, 2),
			"utf8",
		);
		await writeFile(
			entryPath,
			"export default { name: 'demo', manifest: { capabilities: ['skills'] } };",
			"utf8",
		);
		writeGlobalSettings({
			disabledPlugins: [entryPath, "/tmp/other-plugin.ts"],
		});

		const result = await uninstallPlugin({
			name: "cline-internal-bundled-skills-demo",
		});

		expect(result.installPath).toBe(installPath);
		expect(existsSync(installPath)).toBe(false);
		expect(readGlobalSettings()).toEqual({
			autoUpdateEnabled: true,
			disabledPlugins: ["/tmp/other-plugin.ts"],
			telemetryOptOut: false,
		});
	});

	it("uninstalls a direct plugin file by path", async () => {
		const pluginPath = join(home, ".cline", "plugins", "direct-plugin.ts");
		await mkdir(join(home, ".cline", "plugins"), { recursive: true });
		await writeFile(
			pluginPath,
			"export default { name: 'direct', manifest: { capabilities: ['tools'] } };",
			"utf8",
		);

		const result = await uninstallPlugin({ path: pluginPath });

		expect(result.installPath).toBe(pluginPath);
		expect(existsSync(pluginPath)).toBe(false);
	});

	it("keeps plugin files when MCP settings cleanup fails", async () => {
		const pluginPath = join(home, ".cline", "plugins", "mcp-plugin.ts");
		const settingsPath = join(root, "cline_mcp_settings.json");
		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
		await mkdir(join(home, ".cline", "plugins"), { recursive: true });
		await writeFile(
			pluginPath,
			"export default { name: 'mcp-plugin', manifest: { capabilities: ['mcp'] } };",
			"utf8",
		);
		await writeFile(
			settingsPath,
			JSON.stringify(
				{
					mcpServers: {
						smoke: {
							transport: {
								type: "stdio",
								command: process.execPath,
								args: ["-e", "process.exit(0)"],
							},
							metadata: {
								source: "plugin",
								pluginName: "mcp-plugin",
								pluginPath,
							},
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		failure.mcpSettingsCleanup = true;

		await expect(uninstallPlugin({ path: pluginPath })).rejects.toThrow(
			/permission denied/,
		);

		// The plugin is still registered in MCP settings, so deleting its files
		// would leave the settings pointing at nothing.
		expect(existsSync(pluginPath)).toBe(true);
	});

	it("keeps disabled plugin settings if file deletion fails", async () => {
		const pluginRoot = join(home, ".cline", "plugins");
		const pluginPath = join(pluginRoot, "locked-plugin.ts");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			pluginPath,
			"export default { name: 'locked', manifest: { capabilities: ['tools'] } };",
			"utf8",
		);
		writeGlobalSettings({ disabledPlugins: [pluginPath] });
		failure.removePath = resolve(pluginPath);

		await expect(uninstallPlugin({ path: pluginPath })).rejects.toThrow(
			/permission denied/,
		);
		expect(existsSync(pluginPath)).toBe(true);
		// The plugin is still installed and still disabled; forgetting that it
		// was disabled would silently re-enable it on the next load.
		expect(readGlobalSettings()).toEqual({
			autoUpdateEnabled: true,
			disabledPlugins: [pluginPath],
			telemetryOptOut: false,
		});
	});

	it("reports unmatched names clearly", async () => {
		await expect(uninstallPlugin({ name: "missing-plugin" })).rejects.toThrow(
			/No plugin found matching "missing-plugin"/,
		);
	});
});
