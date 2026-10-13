/// <reference types="@types/bun" />
export {};

type PackageManifest = {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const packageJson = (await Bun.file(
	new URL("./package.json", import.meta.url),
).json()) as PackageManifest;
const sourcemap = Bun.env.CLINE_SOURCEMAPS === "1" ? "linked" : "none";
// minify: true keeps identifier mangling active even when sourcemaps are enabled.
const minify = Bun.env.CLINE_SOURCEMAPS !== "1";

// A dependency this repository patches (`patchedDependencies` in the root
// manifest) exists in its patched form only in this workspace. Left external,
// a consumer who installs the published package gets the registry's unpatched
// copy: `@cerebriline/llms` 4.100.250 sent a bare `think: true` to Ollama for
// every effort level, because the level is carried by the patch to
// `ollama-ai-provider-v2`. So a patched dependency is bundled, and the packing
// script removes it from the published manifest.
const rootManifest = (await Bun.file(
	new URL("../../../package.json", import.meta.url),
).json()) as { patchedDependencies?: Record<string, string> };
const patched = new Set(
	Object.keys(rootManifest.patchedDependencies ?? {}).map((spec) =>
		spec.slice(0, spec.lastIndexOf("@")),
	),
);

// Keep published third-party runtime packages external, but bundle internal
// workspace code and anything patched here.
const external = Object.keys({
	...(packageJson.dependencies ?? {}),
	...(packageJson.peerDependencies ?? {}),
}).filter((name) => !name.startsWith("@cline/") && !patched.has(name));

const builds: Parameters<typeof Bun.build>[0][] = [
	{
		entrypoints: ["./src/index.ts", "./src/models.ts", "./src/providers.ts"],
		outdir: "./dist",
		target: "node",
		external,
		packages: "bundle",
		minify,
		sourcemap,
	},
	{
		entrypoints: ["./src/index.browser.ts", "./src/providers.browser.ts"],
		outdir: "./dist",
		target: "browser",
		external,
		packages: "bundle",
		minify,
		sourcemap,
	},
];

for (const config of builds) {
	const result = await Bun.build(config);

	if (result.logs.length > 0) {
		for (const log of result.logs) {
			console.warn(log);
		}
	}
}
