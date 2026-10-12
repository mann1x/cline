import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveClineDataDir,
	resolveDbDataDir,
	resolveGlobalSettingsPath,
	resolveProviderSettingsPath,
	resolveSessionDataDir,
	setClineDataDir,
} from "./paths";

describe("a data directory given as configuration", () => {
	const names = [
		"CEREBRILINE_DATA_DIR",
		"CLINE_DATA_DIR",
		"CLINE_SESSION_DATA_DIR",
		"CLINE_DB_DATA_DIR",
		"CLINE_PROVIDER_SETTINGS_PATH",
		"CLINE_GLOBAL_SETTINGS_PATH",
	];
	const before = Object.fromEntries(
		names.map((name) => [name, process.env[name]]),
	);

	afterEach(() => {
		setClineDataDir(undefined);
		for (const name of names) {
			if (before[name] === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = before[name];
			}
		}
	});

	it("holds everything the process stores, and wins over the variable", () => {
		for (const name of names) {
			delete process.env[name];
		}
		process.env.CLINE_DATA_DIR = join("from", "env");
		const dir = join("runs", "0001", "data");
		setClineDataDir(dir);
		expect(resolveClineDataDir()).toBe(dir);
		expect(resolveSessionDataDir()).toBe(join(dir, "sessions"));
		expect(resolveDbDataDir()).toBe(join(dir, "db"));
		expect(resolveProviderSettingsPath()).toBe(
			join(dir, "settings", "providers.json"),
		);
		expect(resolveGlobalSettingsPath()).toBe(
			join(dir, "settings", "global-settings.json"),
		);

		setClineDataDir("");
		expect(resolveClineDataDir()).toBe(join("from", "env"));
	});
});
