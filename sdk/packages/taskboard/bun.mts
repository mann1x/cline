/// <reference types="@types/bun" />
export {};

// Declared dependencies stay external, as in core: an application that uses
// both this package and @cline/core must get one copy of @cline/shared, not two.
const manifest = (await Bun.file(
	new URL("./package.json", import.meta.url),
).json()) as { dependencies?: Record<string, string> };
const external = Object.keys(manifest.dependencies ?? {});
const sourcemap = Bun.env.CLINE_SOURCEMAPS === "1" ? "linked" : "none";
const minify = Bun.env.CLINE_SOURCEMAPS !== "1";

const result = await Bun.build({
	entrypoints: ["./src/index.ts"],
	outdir: "./dist",
	target: "node",
	format: "esm",
	minify,
	sourcemap,
	packages: "bundle",
	external,
});
for (const log of result.logs) console.warn(log);
if (!result.success) process.exit(1);
