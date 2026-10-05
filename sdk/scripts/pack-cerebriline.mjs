#!/usr/bin/env node
/**
 * Pack the SDK for npm under the fork's own scope, `@cerebriline/*`.
 *
 * The source keeps upstream's names (`@cline/shared`, `llms`, `agents`,
 * `core`, `sdk`): they are imported in several hundred files, and renaming
 * them there would turn every upstream merge into a conflict on each of those
 * lines. `@cline` on npm is upstream's, so the fork cannot publish to it. The
 * rename therefore happens here, on the packed output, and nowhere else.
 *
 * For each package, in dependency order:
 *   1. `bun pm pack` -- upstream's own packing, so `files` and the
 *      `workspace:*` ranges are handled the way upstream's publish handles them;
 *   2. unpack, and rewrite: the manifest's name, version, links and its
 *      dependencies on the other four; every module specifier and
 *      package-name string in the built `.js` and `.d.ts`;
 *   3. add the licence and a README, and `npm pack` the result.
 *
 * Nothing is published. The tarballs land in `--out`; publishing is
 * `npm publish <tarball> --access public`, in the order printed.
 *
 *   node sdk/scripts/pack-cerebriline.mjs --version 4.100.240 --out <dir>
 *
 * `bun run build:sdk` must have run: this packs `dist`, it does not build it.
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const FROM_SCOPE = "@cline";
const TO_SCOPE = "@cerebriline";
/** Dependency order: each depends only on the ones before it. */
const PACKAGES = ["shared", "llms", "agents", "core", "sdk"];
const REPOSITORY = "https://github.com/mann1x/cline";
const HOMEPAGE = "https://github.com/mann1x/cline/tree/main/sdk";
/** Text that can name a package: code, declarations, manifests. Not source maps. */
const REWRITTEN = /\.(?:[cm]?js|d\.[cm]?ts|json)$/;

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sdkRoot, "..");

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		out: { type: "string" },
	},
	strict: true,
});
if (!values.version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(values.version)) {
	fail("--version <semver> is required, e.g. --version 4.100.240");
}
if (!values.out) {
	fail("--out <directory> is required");
}
const version = values.version;
const outDir = resolve(values.out);
const stageRoot = join(outDir, "stage");

function fail(message) {
	console.error(`pack-cerebriline: ${message}`);
	process.exit(1);
}

function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

/**
 * A quoted reference to one of the five packages: `"@cline/shared"`,
 * `'@cline/core/hub'`. The quote and the boundary keep it to whole package
 * names, so `@cline/cli-linux-x64` (the CLI's native package, upstream's and
 * not ours to rename) and a bare `"@cline/"` prefix are left alone.
 */
const REFERENCE = new RegExp(
	`(["'\`])${FROM_SCOPE}/(${PACKAGES.join("|")})(?=["'\`/])`,
	"g",
);

function rewriteText(text) {
	let count = 0;
	const next = text.replace(REFERENCE, (_match, quote, name) => {
		count++;
		return `${quote}${TO_SCOPE}/${name}`;
	});
	return { next, count };
}

function walk(directory, visit) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") walk(path, visit);
		} else if (entry.isFile()) {
			visit(path);
		}
	}
}

function readme(name, description) {
	const install = `npm install ${TO_SCOPE}/sdk`;
	const body =
		name === "sdk"
			? `The SDK that [Cerebriline](${REPOSITORY}) is built on: a TypeScript framework for
programs that run an agent which can edit files, run commands and call tools.

\`\`\`bash
${install}
\`\`\`

\`\`\`typescript
import { Agent } from "${TO_SCOPE}/sdk"

const agent = new Agent({
	providerId: "ollama",
	modelId: "qwen3:8b",
	systemPrompt: "You are a helpful coding assistant.",
	tools: [],
})

const result = await agent.run("Say hello in one word.")
console.log(result.outputText)
\`\`\`

It carries what this fork adds for local and small models: delegated agents
and swarms, a sandbox per agent, the change protocol and file revisions,
opencoti and xOllama support, the media tools and the Document Reader.`
			: `${description ?? "Part of the Cerebriline SDK."}

Installed as a dependency of [\`${TO_SCOPE}/sdk\`](https://www.npmjs.com/package/${TO_SCOPE}/sdk);
start there unless you need this layer on its own.`;
	return `# ${TO_SCOPE}/${name}

${body}

## Where it comes from

A fork of the [Cline](https://github.com/cline/cline) SDK (\`${FROM_SCOPE}/${name}\`),
published under its own scope. The source is in
[\`sdk/packages/${name}\`](${REPOSITORY}/tree/main/sdk/packages/${name}) and keeps
upstream's package names; they are renamed when this package is packed. One
version is published per Cerebriline release, with the same number.

Needs Node 22 or newer. Apache-2.0, as upstream.
`;
}

function packOne(name) {
	const packageDir = join(sdkRoot, "packages", name);
	if (!existsSync(join(packageDir, "dist", "index.js"))) {
		fail(`${name} has no dist/index.js; run \`bun run build:sdk\` first`);
	}

	const rawDir = join(stageRoot, "raw");
	mkdirSync(rawDir, { recursive: true });
	const packed = run(
		"bun",
		["pm", "pack", "--destination", rawDir, "--quiet"],
		packageDir,
	)
		.trim()
		.split("\n")
		.at(-1);
	const tarball = join(rawDir, packed.split("/").at(-1));

	const stage = join(stageRoot, name);
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true });
	run("tar", ["-xzf", tarball, "-C", stage, "--strip-components=1"], stage);

	const manifestPath = join(stage, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const description = manifest.description
		?.replace(/\bCline\b/g, "Cerebriline")
		.replaceAll(FROM_SCOPE, TO_SCOPE);
	manifest.name = `${TO_SCOPE}/${name}`;
	manifest.version = version;
	manifest.description = description;
	manifest.license = "Apache-2.0";
	manifest.repository = {
		type: "git",
		url: `git+${REPOSITORY}.git`,
		directory: `sdk/packages/${name}`,
	};
	manifest.homepage = HOMEPAGE;
	manifest.bugs = { url: `${REPOSITORY}/issues` };
	manifest.publishConfig = { access: "public" };
	delete manifest.scripts;
	delete manifest.devDependencies;
	for (const field of [
		"dependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		const deps = manifest[field];
		if (!deps) continue;
		for (const dependency of Object.keys(deps)) {
			const sibling = PACKAGES.find(
				(other) => dependency === `${FROM_SCOPE}/${other}`,
			);
			if (!sibling) continue;
			delete deps[dependency];
			// Exact: the five are built and tested as one set.
			deps[`${TO_SCOPE}/${sibling}`] = version;
		}
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	let rewritten = 0;
	let files = 0;
	walk(stage, (path) => {
		if (path === manifestPath || !REWRITTEN.test(path)) return;
		const { next, count } = rewriteText(readFileSync(path, "utf8"));
		if (count > 0) {
			writeFileSync(path, next);
			rewritten += count;
			files++;
		}
	});

	cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
	writeFileSync(join(stage, "README.md"), readme(name, description));

	// What is left of the old scope, for the reader of the log to judge.
	const left = new Map();
	walk(stage, (path) => {
		if (!REWRITTEN.test(path)) return;
		for (const match of readFileSync(path, "utf8").matchAll(
			/["'`]@cline\/[^"'`\s]{0,40}/g,
		)) {
			left.set(match[0], (left.get(match[0]) ?? 0) + 1);
		}
	});

	const result = run(
		"npm",
		["pack", "--pack-destination", outDir, "--json"],
		stage,
	);
	const info = JSON.parse(result)[0];
	return {
		name: manifest.name,
		tarball: join(outDir, info.filename),
		size: statSync(join(outDir, info.filename)).size,
		entries: info.entryCount,
		rewritten,
		files,
		left: [...left.entries()],
	};
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const results = PACKAGES.map(packOne);
rmSync(join(stageRoot, "raw"), { recursive: true, force: true });

console.log(`\n${TO_SCOPE} ${version}, in publish order:`);
for (const result of results) {
	console.log(
		`  ${result.tarball}\n    ${(result.size / 1024).toFixed(0)} KB, ${result.entries} files; ${result.rewritten} references renamed in ${result.files} files`,
	);
	for (const [text, count] of result.left) {
		console.log(`    left as is: ${text}  (${count})`);
	}
}
writeFileSync(
	join(outDir, "manifest.json"),
	`${JSON.stringify({ version, packages: results.map(({ name, tarball }) => ({ name, tarball })) }, null, "\t")}\n`,
);
