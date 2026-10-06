import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	currentPlatformKey,
	ensureLanceDb,
	installLanceDb,
	isLanceDbInstalled,
	LanceDbUnavailableError,
	lanceDbUnsupportedReason,
	loadLanceDb,
} from "./lancedb-runtime";
import {
	LANCEDB_RUNTIME_MANIFEST,
	type LanceDbRuntimeManifest,
} from "./lancedb-runtime.manifest";
import { tarGz } from "./tar-fixture";

const integrity = (data: Buffer) =>
	`sha512-${createHash("sha512").update(data).digest("base64")}`;

const tarballs = {
	"https://registry.test/lancedb.tgz": tarGz([
		{
			name: "package/package.json",
			body: '{"name":"@lancedb/lancedb","main":"index.js"}',
		},
		{
			name: "package/index.js",
			body: 'module.exports = { connect: () => "connected", native: require("@lancedb/lancedb-test-native") };',
		},
	]),
	"https://registry.test/arrow.tgz": tarGz([
		{
			name: "package/package.json",
			body: '{"name":"apache-arrow","main":"index.js"}',
		},
		{ name: "package/index.js", body: "module.exports = { Schema: 1 };" },
	]),
	"https://registry.test/native.tgz": tarGz([
		{
			name: "package/package.json",
			body: '{"name":"@lancedb/lancedb-test-native","main":"index.js"}',
		},
		{ name: "package/index.js", body: 'module.exports = "native";' },
	]),
};

const manifest: LanceDbRuntimeManifest = {
	version: "9.9.9",
	arrow: "1.0.0",
	packages: [
		{
			path: "node_modules/@lancedb/lancedb",
			tarball: "https://registry.test/lancedb.tgz",
			integrity: integrity(tarballs["https://registry.test/lancedb.tgz"]),
		},
		{
			path: "node_modules/apache-arrow",
			tarball: "https://registry.test/arrow.tgz",
			integrity: integrity(tarballs["https://registry.test/arrow.tgz"]),
		},
	],
	platforms: {
		"test-os": {
			path: "node_modules/@lancedb/lancedb-test-native",
			tarball: "https://registry.test/native.tgz",
			integrity: integrity(tarballs["https://registry.test/native.tgz"]),
			unpackedBytes: 42,
		},
	},
};

function registry(overrides: Record<string, Buffer | number> = {}) {
	const calls: string[] = [];
	const send = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		const answer =
			overrides[url] ?? tarballs[url as keyof typeof tarballs] ?? 404;
		return typeof answer === "number"
			? new Response("no", { status: answer })
			: new Response(new Uint8Array(answer), {
					headers: { "content-length": String(answer.length) },
				});
	}) as typeof fetch;
	return { send, calls };
}

describe("the LanceDB runtime", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "lancedb-runtime-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("downloads, verifies and loads what the manifest names", async () => {
		const { send, calls } = registry();
		const seen: string[] = [];
		const runtime = await ensureLanceDb({
			directory,
			manifest,
			platformKey: "test-os",
			fetch: send,
			onProgress: (progress) => {
				if (seen.at(-1) !== progress.path) seen.push(progress.path);
				expect(progress.packageCount).toBe(3);
				expect(progress.totalBytes).toBeGreaterThan(0);
			},
		});
		expect(calls).toHaveLength(3);
		expect(seen).toEqual([
			"node_modules/@lancedb/lancedb",
			"node_modules/apache-arrow",
			"node_modules/@lancedb/lancedb-test-native",
		]);
		expect(runtime.version).toBe("9.9.9");
		expect(runtime.root).toBe(join(directory, "9.9.9"));
		expect(runtime.lancedb.connect()).toBe("connected");
		// The native package resolves from inside the installed tree.
		expect(runtime.lancedb.native).toBe("native");
		expect(runtime.arrow.Schema).toBe(1);
		expect(readdirSync(directory)).toEqual(["9.9.9"]);
	});

	it("downloads nothing when it is already installed", async () => {
		const first = registry();
		await installLanceDb({
			directory,
			manifest,
			platformKey: "test-os",
			fetch: first.send,
		});
		const second = registry();
		await installLanceDb({
			directory,
			manifest,
			platformKey: "test-os",
			fetch: second.send,
		});
		expect(second.calls).toHaveLength(0);
	});

	it("keeps nothing from a download that does not match its integrity", async () => {
		const tampered = tarGz([
			{
				name: "package/package.json",
				body: '{"name":"apache-arrow","main":"index.js"}',
			},
			{ name: "package/index.js", body: 'module.exports = "evil";' },
		]);
		const { send } = registry({ "https://registry.test/arrow.tgz": tampered });
		await expect(
			installLanceDb({
				directory,
				manifest,
				platformKey: "test-os",
				fetch: send,
			}),
		).rejects.toThrow(/does not match its recorded integrity/);
		expect(isLanceDbInstalled({ directory, manifest })).toBe(false);
		expect(readdirSync(directory)).toEqual([]);
		// And the next attempt, with the right bytes, installs.
		await installLanceDb({
			directory,
			manifest,
			platformKey: "test-os",
			fetch: registry().send,
		});
		expect(isLanceDbInstalled({ directory, manifest })).toBe(true);
	});

	it("leaves nothing behind when the registry refuses", async () => {
		const { send } = registry({ "https://registry.test/native.tgz": 503 });
		await expect(
			installLanceDb({
				directory,
				manifest,
				platformKey: "test-os",
				fetch: send,
			}),
		).rejects.toThrow(/answered 503/);
		expect(readdirSync(directory)).toEqual([]);
	});

	it("says so on a platform LanceDB is not published for", async () => {
		const { send, calls } = registry();
		expect(
			lanceDbUnsupportedReason({ manifest, platformKey: "darwin-x64" }),
		).toMatch(/not published for darwin-x64.*Keyword search still works/);
		await expect(
			installLanceDb({
				directory,
				manifest,
				platformKey: "darwin-x64",
				fetch: send,
			}),
		).rejects.toBeInstanceOf(LanceDbUnavailableError);
		expect(calls).toHaveLength(0);
	});

	it("refuses to load what is not installed", () => {
		expect(() => loadLanceDb({ directory, manifest })).toThrow(
			/not installed yet/,
		);
		expect(existsSync(join(directory, "9.9.9"))).toBe(false);
	});

	it("has a native package for this machine in the shipped manifest", () => {
		const key = currentPlatformKey();
		// Intel Macs are the one platform LanceDB stopped publishing for.
		if (key === "darwin-x64") {
			expect(LANCEDB_RUNTIME_MANIFEST.platforms[key]).toBeUndefined();
			return;
		}
		expect(LANCEDB_RUNTIME_MANIFEST.platforms[key]?.integrity).toMatch(
			/^sha512-/,
		);
		for (const entry of [
			...LANCEDB_RUNTIME_MANIFEST.packages,
			...Object.values(LANCEDB_RUNTIME_MANIFEST.platforms),
		]) {
			expect(entry.tarball).toMatch(/^https:\/\/registry\.npmjs\.org\//);
			expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
			expect(entry.path).toMatch(/^node_modules\//);
		}
	});
});
