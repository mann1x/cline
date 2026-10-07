import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const production = process.argv.includes("--production") || process.env["IS_DEBUG_BUILD"] === "false"
const watch = process.argv.includes("--watch")
const standalone = process.argv.includes("--standalone")
const e2eBuild = process.argv.includes("--e2e-build")
const destDir = standalone ? "dist-standalone" : "dist"

/**
 * @type {import('esbuild').Plugin}
 */
const aliasResolverPlugin = {
	name: "alias-resolver",
	setup(build) {
		const aliases = {
			"@": path.resolve(__dirname, "src"),
			"@core": path.resolve(__dirname, "src/core"),
			"@integrations": path.resolve(__dirname, "src/integrations"),
			"@services": path.resolve(__dirname, "src/services"),
			"@shared": path.resolve(__dirname, "src/shared"),
			"@utils": path.resolve(__dirname, "src/utils"),
			"@packages": path.resolve(__dirname, "src/packages"),
		}

		// For each alias entry, create a resolver
		Object.entries(aliases).forEach(([alias, aliasPath]) => {
			const aliasRegex = new RegExp(`^${alias}($|/.*)`)
			build.onResolve({ filter: aliasRegex }, (args) => {
				const importPath = args.path.replace(alias, aliasPath)

				// First, check if the path exists as is
				if (fs.existsSync(importPath)) {
					const stats = fs.statSync(importPath)
					if (stats.isDirectory()) {
						// If it's a directory, try to find index files
						const extensions = [".ts", ".tsx", ".js", ".jsx"]
						for (const ext of extensions) {
							const indexFile = path.join(importPath, `index${ext}`)
							if (fs.existsSync(indexFile)) {
								return { path: indexFile }
							}
						}
					} else {
						// It's a file that exists, so return it
						return { path: importPath }
					}
				}

				// If the path doesn't exist, try appending extensions
				const extensions = [".ts", ".tsx", ".js", ".jsx"]
				for (const ext of extensions) {
					const pathWithExtension = `${importPath}${ext}`
					if (fs.existsSync(pathWithExtension)) {
						return { path: pathWithExtension }
					}
				}

				// If nothing worked, return the original path and let esbuild handle the error
				return { path: importPath }
			})
		})
	},
}

const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",

	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started")
		})
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`)
				console.error(`    ${location.file}:${location.line}:${location.column}:`)
			})
			console.log("[watch] build finished")
		})
	},
}

const buildEnvVars = {
	"import.meta.url": "_importMetaUrl",
	"process.env.IS_STANDALONE": JSON.stringify(standalone ? "true" : "false"),
	// Always inline these values so ordinary builds cannot be mislabeled by a
	// user's runtime environment. Only the combined rollout workflow sets them.
	"process.env.CLINE_ROLLOUT_VARIANT": JSON.stringify(process.env.CLINE_ROLLOUT_VARIANT || ""),
}

if (production) {
	// IS_DEV is always disable in production builds.
	buildEnvVars["process.env.IS_DEV"] = "false"
}
// Set the environment and telemetry env vars. The API key env vars need to be populated in the GitHub
// workflows from the secrets.
if (process.env.CLINE_ENVIRONMENT) {
	buildEnvVars["process.env.CLINE_ENVIRONMENT"] = JSON.stringify(process.env.CLINE_ENVIRONMENT)
}
if (process.env.TELEMETRY_SERVICE_API_KEY) {
	buildEnvVars["process.env.TELEMETRY_SERVICE_API_KEY"] = JSON.stringify(process.env.TELEMETRY_SERVICE_API_KEY)
}
if (process.env.ERROR_SERVICE_API_KEY) {
	buildEnvVars["process.env.ERROR_SERVICE_API_KEY"] = JSON.stringify(process.env.ERROR_SERVICE_API_KEY)
}

// OpenTelemetry configuration (injected at build time from GitHub secrets)
// These provide production defaults that can be overridden at runtime via environment variables
if (process.env.OTEL_TELEMETRY_ENABLED) {
	buildEnvVars["process.env.OTEL_TELEMETRY_ENABLED"] = JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED)
}
if (process.env.OTEL_LOGS_EXPORTER) {
	buildEnvVars["process.env.OTEL_LOGS_EXPORTER"] = JSON.stringify(process.env.OTEL_LOGS_EXPORTER)
}
if (process.env.OTEL_METRICS_EXPORTER) {
	buildEnvVars["process.env.OTEL_METRICS_EXPORTER"] = JSON.stringify(process.env.OTEL_METRICS_EXPORTER)
}
if (process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_PROTOCOL"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL)
}
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_ENDPOINT"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
}
if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_HEADERS"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS)
}
if (process.env.OTEL_METRIC_EXPORT_INTERVAL) {
	buildEnvVars["process.env.OTEL_METRIC_EXPORT_INTERVAL"] = JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL)
}
// Base configuration shared between extension and standalone builds
const baseConfig = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	logLevel: "silent",
	define: buildEnvVars,
	tsconfig: path.resolve(__dirname, "tsconfig.json"),
	plugins: [
		aliasResolverPlugin,
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
	format: "cjs",
	sourcesContent: false,
	platform: "node",
	target: "node22.15",
	banner: {
		js: "const _importMetaUrl=require('url').pathToFileURL(__filename)",
	},
}

// Extension-specific configuration
const extensionConfig = {
	...baseConfig,
	entryPoints: ["src/extension.ts"],
	outfile: `${destDir}/extension.js`,
	external: ["vscode"],
}

// Standalone-specific configuration
const standaloneConfig = {
	...baseConfig,
	entryPoints: ["src/standalone/cline-core.ts"],
	outfile: `${destDir}/cline-core.js`,
	// These modules need to load files from the module directory at runtime,
	// so they cannot be bundled.
	external: ["vscode", "@grpc/reflection", "grpc-health-check", "better-sqlite3"],
}

// E2E build script configuration
const e2eBuildConfig = {
	...baseConfig,
	entryPoints: ["src/test/e2e/utils/build.ts"],
	outfile: `${destDir}/e2e-build.mjs`,
	external: ["@vscode/test-electron", "execa"],
	sourcemap: false,
	plugins: [aliasResolverPlugin, esbuildProblemMatcherPlugin],
}

/**
 * Put the tree-sitter grammars beside the bundle.
 *
 * `@cline/core` reads these as data at runtime -- 36 wasm files, ~50 MB -- and
 * a bundler cannot inline them into anything shippable. The VSIX has no
 * `node_modules` to resolve them from either, so the build copies them to
 * `dist/grammars/` and core finds them next to itself. Without this the
 * complexity measurement is silent, which reads as "this code is simple"
 * rather than as "nothing was measured", so it is worth the 50 MB to have the
 * feature tell the truth.
 *
 * `tree-sitter.wasm` is web-tree-sitter's own runtime and goes in `dist/`
 * itself, because emscripten resolves it against `__dirname` -- which after
 * bundling is the bundle's directory.
 *
 * Missing packages are not fatal: the copy is skipped with a warning and the
 * feature goes quiet, the same way it does in a host that never had them.
 */
function copyGrammars(destDir) {
	// Resolve from `@cline/core`, not from here: the grammars are its
	// dependencies, and under bun's isolated node_modules they are not
	// reachable from this package at all. Its manifest is found by path
	// rather than by `require.resolve`, because the package's `exports` map
	// refuses every subpath including `./package.json`.
	const candidates = [
		path.join(__dirname, "node_modules", "@cline", "core", "package.json"),
		path.resolve(__dirname, "..", "..", "sdk", "packages", "core", "package.json"),
	]
	const core = candidates.find((candidate) => fs.existsSync(candidate))
	const require = createRequire(core ?? import.meta.url)
	const copies = []
	try {
		const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm")
		copies.push([runtime, path.join(destDir, "tree-sitter.wasm")])
	} catch {
		console.warn("[grammars] web-tree-sitter not resolvable; complexity will be silent")
	}
	try {
		const anyGrammar = require.resolve("tree-sitter-wasms/out/tree-sitter-javascript.wasm")
		const from = path.dirname(anyGrammar)
		const into = path.join(destDir, "grammars")
		fs.mkdirSync(into, { recursive: true })
		for (const name of fs.readdirSync(from)) {
			if (name.endsWith(".wasm")) {
				copies.push([path.join(from, name), path.join(into, name)])
			}
		}
	} catch {
		console.warn("[grammars] tree-sitter-wasms not resolvable; complexity will be silent")
	}
	let bytes = 0
	for (const [from, to] of copies) {
		fs.mkdirSync(path.dirname(to), { recursive: true })
		fs.copyFileSync(from, to)
		bytes += fs.statSync(to).size
	}
	if (copies.length) {
		console.log(`[grammars] ${copies.length} file(s), ${(bytes / 1024 / 1024).toFixed(0)} MB -> ${destDir}`)
	}
}

/**
 * Put office_oxide's WebAssembly module beside the bundle.
 *
 * It is how `extract_document` reads Word, Excel and PowerPoint 97-2003 files.
 * Core vendors it under `assets/office-oxide/` (built by
 * `sdk/packages/core/scripts/build-office-oxide.sh`) and looks for it in
 * `office-oxide/` next to itself first, which after bundling is `dist/`.
 * Missing is not fatal: the tool then says legacy Office files cannot be read,
 * and every other format still works.
 */
function copyOfficeOxide(destDir) {
	const candidates = [
		path.join(__dirname, "node_modules", "@cline", "core", "assets", "office-oxide"),
		path.resolve(__dirname, "..", "..", "sdk", "packages", "core", "assets", "office-oxide"),
	]
	const from = candidates.find((candidate) => fs.existsSync(path.join(candidate, "office_oxide_bg.wasm")))
	if (!from) {
		console.warn("[office-oxide] office_oxide_bg.wasm not found; legacy Office files will not be readable")
		return
	}
	const into = path.join(destDir, "office-oxide")
	fs.mkdirSync(into, { recursive: true })
	let bytes = 0
	for (const name of fs.readdirSync(from)) {
		fs.copyFileSync(path.join(from, name), path.join(into, name))
		bytes += fs.statSync(path.join(into, name)).size
	}
	console.log(`[office-oxide] ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${into}`)
}

/**
 * Put the skills that ship with the product beside the bundle.
 *
 * Core keeps them in `assets/skills/`, one folder per skill, and looks for
 * them in `bundled-skills/` next to itself first, which after bundling is
 * `dist/`. Missing is not fatal: the extension then offers no built-in skills.
 */
function copyBundledSkills(destDir) {
	const candidates = [
		path.join(__dirname, "node_modules", "@cline", "core", "assets", "skills"),
		path.resolve(__dirname, "..", "..", "sdk", "packages", "core", "assets", "skills"),
	]
	const from = candidates.find((candidate) => fs.existsSync(candidate))
	if (!from) {
		console.warn("[skills] core's assets/skills not found; no built-in skills will be offered")
		return
	}
	const into = path.join(destDir, "bundled-skills")
	fs.rmSync(into, { recursive: true, force: true })
	fs.cpSync(from, into, { recursive: true })
	const count = fs.readdirSync(into).filter((name) => fs.existsSync(path.join(into, name, "SKILL.md"))).length
	console.log(`[skills] ${count} built-in skills -> ${into}`)
}

/**
 * The Document Reader's data files: pdf.js's decoders and character maps,
 * tesseract's worker and core, and the English OCR model. Written by core's
 * own script, which the CLI build runs too, so both ship the same layout.
 */
async function writeDocumentReaderAssets(destDir) {
	const candidates = [
		path.join(__dirname, "node_modules", "@cline", "core", "scripts", "document-reader-assets.mjs"),
		path.resolve(__dirname, "..", "..", "sdk", "packages", "core", "scripts", "document-reader-assets.mjs"),
	]
	const script = candidates.find((candidate) => fs.existsSync(candidate))
	if (!script) {
		console.warn("[documents] core's document-reader-assets.mjs not found; scanned pages will not be readable")
		return
	}
	const { writeDocumentReaderAssets: write } = await import(script)
	await write(destDir, { esbuild })
}

/**
 * The Document Reader's own process. Core reads each document in a process
 * started for it, so a PDF that exhausts memory ends that process and not the
 * extension host every extension shares. The file it runs is core's, bundled
 * here whole (the VSIX has no `node_modules`) and written beside extension.js,
 * which is where core looks for it and where the reader's data files are.
 */
async function buildDocumentReaderChild(destDir) {
	const candidates = [
		path.join(__dirname, "node_modules", "@cline", "core", "dist", "document-reader-child.js"),
		path.resolve(__dirname, "..", "..", "sdk", "packages", "core", "dist", "document-reader-child.js"),
	]
	const entry = candidates.find((candidate) => fs.existsSync(candidate))
	if (!entry) {
		throw new Error(
			"[documents] core's document-reader-child.js not found: run `bun run build:sdk` first. Without it documents are read inside the extension host.",
		)
	}
	await esbuild.build({
		...baseConfig,
		entryPoints: [entry],
		outfile: path.join(destDir, "document-reader-child.cjs"),
		logLevel: "warning",
	})
	console.log(
		`[documents] reader process: ${(fs.statSync(path.join(destDir, "document-reader-child.cjs")).size / 1048576).toFixed(1)} MB`,
	)
}

async function main() {
	const config = standalone ? standaloneConfig : e2eBuild ? e2eBuildConfig : extensionConfig
	if (!e2eBuild) {
		copyGrammars(path.resolve(__dirname, destDir))
		copyOfficeOxide(path.resolve(__dirname, destDir))
		copyBundledSkills(path.resolve(__dirname, destDir))
		await writeDocumentReaderAssets(path.resolve(__dirname, destDir))
		await buildDocumentReaderChild(path.resolve(__dirname, destDir))
	}
	const extensionCtx = await esbuild.context(config)
	if (watch) {
		await extensionCtx.watch()
	} else {
		await extensionCtx.rebuild()
		await extensionCtx.dispose()
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
