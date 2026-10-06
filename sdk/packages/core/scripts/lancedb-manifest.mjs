#!/usr/bin/env node
/**
 * Regenerates `src/services/retrieval/lancedb-runtime.manifest.ts`: the list
 * of packages the Library's vector search downloads on first use, each with
 * the integrity npm records for it.
 *
 *   node sdk/packages/core/scripts/lancedb-manifest.mjs <lancedb version> <apache-arrow version> <scratch dir>
 *
 * It resolves the two packages in the scratch directory with npm (lock file
 * only, nothing is installed), keeps the non-optional JavaScript packages
 * without their type declarations, and adds the native package of every
 * platform LanceDB publishes. apache-arrow must be a version LanceDB's peer
 * range accepts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [version, arrow, scratchArg] = process.argv.slice(2);
if (!version || !arrow || !scratchArg) {
	console.error(
		"usage: lancedb-manifest.mjs <lancedb version> <apache-arrow version> <scratch dir>",
	);
	process.exit(1);
}
const scratch = resolve(scratchArg);
mkdirSync(scratch, { recursive: true });
writeFileSync(
	join(scratch, "package.json"),
	'{"name":"lancedb-manifest","private":true}\n',
);
execFileSync(
	"npm",
	[
		"install",
		"--package-lock-only",
		"--no-audit",
		"--no-fund",
		`@lancedb/lancedb@${version}`,
		`apache-arrow@${arrow}`,
	],
	{ cwd: scratch, stdio: "inherit" },
);
const lock = JSON.parse(
	readFileSync(join(scratch, "package-lock.json"), "utf8"),
);

const PLATFORMS = {
	"linux-x64-gnu": "linux-x64-gnu",
	"linux-x64-musl": "linux-x64-musl",
	"linux-arm64-gnu": "linux-arm64-gnu",
	"linux-arm64-musl": "linux-arm64-musl",
	"darwin-arm64": "darwin-arm64",
	"win32-x64-msvc": "win32-x64",
	"win32-arm64-msvc": "win32-arm64",
};

const packages = [];
for (const [path, entry] of Object.entries(lock.packages)) {
	if (
		!path ||
		entry.optional ||
		`/${path}`.includes("/@types/") ||
		path.endsWith("undici-types")
	)
		continue;
	packages.push({ path, tarball: entry.resolved, integrity: entry.integrity });
}
const platforms = {};
for (const [suffix, key] of Object.entries(PLATFORMS)) {
	const path = `node_modules/@lancedb/lancedb-${suffix}`;
	const entry = lock.packages[path];
	if (!entry) continue;
	const unpackedBytes = JSON.parse(
		execFileSync(
			"npm",
			[
				"view",
				`@lancedb/lancedb-${suffix}@${version}`,
				"dist.unpackedSize",
				"--json",
			],
			{ encoding: "utf8" },
		),
	);
	platforms[key] = {
		path,
		tarball: entry.resolved,
		integrity: entry.integrity,
		unpackedBytes,
	};
}

const target = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"services",
	"retrieval",
	"lancedb-runtime.manifest.ts",
);
const current = readFileSync(target, "utf8");
const marker =
	"export const LANCEDB_RUNTIME_MANIFEST: LanceDbRuntimeManifest = ";
const head = current.slice(0, current.indexOf(marker) + marker.length);
writeFileSync(
	target,
	`${head}${JSON.stringify({ version, arrow, packages, platforms }, null, "\t")};\n`,
);
console.log(
	`${packages.length} JavaScript packages, ${Object.keys(platforms).length} platforms -> ${target}`,
);
