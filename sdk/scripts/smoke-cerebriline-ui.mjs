#!/usr/bin/env node
/**
 * Check the packed `@cerebriline/ui` the way upstream checks `@cline/ui`.
 *
 * Upstream's `sdk/packages/ui/scripts/smoke-package.ts` installs the packed
 * archive into a Bun/React 19 project and an npm/Node/React 18 one, imports
 * every entry point, resolves the stylesheets, type-checks a consumer and
 * compiles the Tailwind contract. That is the check worth having, so it is run
 * here rather than rewritten: a copy is made with the scope renamed and the
 * `@cerebriline/shared` and `@cerebriline/taskboard` taken from the release's
 * tarballs through the consumers' `overrides` (the renamed `ui` asks for them
 * at the release's exact version, which is not on npm yet when this runs). Upstream's file is left as it is, so merges do not touch it.
 * Each substitution is counted: if upstream reshapes the script, this stops
 * instead of quietly checking less. Upstream's script knows nothing of the
 * fork's Board tab, so a third consumer installs it with its optional peers
 * and loads it.
 *
 *   node sdk/scripts/smoke-cerebriline-ui.mjs --dir <tarballs> [--work <dir>]
 *
 * `--work` holds the two consumer projects (several hundred MB of
 * node_modules); without it they go to the system temp directory.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { dir: { type: "string" }, work: { type: "string" } },
	strict: true,
});
if (!values.dir) {
	console.error(
		"smoke-cerebriline-ui: --dir <directory of tarballs> is required",
	);
	process.exit(1);
}
const dir = resolve(values.dir);
const find = (pkg) => {
	const found = readdirSync(dir).filter(
		(name) => name.startsWith(`cerebriline-${pkg}-`) && name.endsWith(".tgz"),
	);
	if (found.length !== 1) {
		console.error(
			`smoke-cerebriline-ui: expected one cerebriline-${pkg}-*.tgz in ${dir}, found ${found.length}`,
		);
		process.exit(1);
	}
	return join(dir, found[0]);
};
const ui = find("ui");
const shared = find("shared");
const taskboard = find("taskboard");

const upstreamScript = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"packages",
	"ui",
	"scripts",
	"smoke-package.ts",
);
let script = readFileSync(upstreamScript, "utf8");

function replace(pattern, replacement, expected) {
	const count = script.split(pattern).length - 1;
	if (expected === "some" ? count === 0 : count !== expected) {
		console.error(
			`smoke-cerebriline-ui: upstream's smoke-package.ts changed shape: ${JSON.stringify(pattern)} found ${count} times, expected ${expected}`,
		);
		process.exit(1);
	}
	script = script.split(pattern).join(replacement);
}

// Every specifier, CSS import and type-check consumer names the package.
replace("@cline/ui", "@cerebriline/ui", "some");
// The renamed ui asks for the renamed shared and taskboard at the release's
// exact version, which is not on npm while this runs: each consumer is told to
// take them from the release's tarballs (npm reads `overrides`, bun both).
const fromRelease = {
	"@cerebriline/shared": `file:${shared}`,
	"@cerebriline/taskboard": `file:${taskboard}`,
};
const consumerManifest = (name) =>
	JSON.stringify({
		name,
		private: true,
		type: "module",
		overrides: fromRelease,
		resolutions: fromRelease,
	});
replace(
	'JSON.stringify({ name: "cline-ui-smoke", private: true, type: "module" }, null, 2)',
	`JSON.stringify(${consumerManifest("cline-ui-smoke")}, null, 2)`,
	1,
);
// Nothing of upstream's scope may come in with it.
replace(
	'\tawait run([process.execPath, "-e", importCheck], bunConsumer);\n',
	'\tawait run([process.execPath, "-e", importCheck], bunConsumer);\n\tif ((await import("node:fs")).existsSync(join(bunConsumer, "node_modules", "@cline"))) {\n\t\tthrow new Error("the install pulled in a package from the @cline scope");\n\t}\n',
	1,
);

const work = values.work
	? resolve(values.work)
	: mkdtempSync(join(tmpdir(), "cerebriline-ui-"));
mkdirSync(work, { recursive: true });
const copy = join(work, "smoke-package.ts");
writeFileSync(copy, script);

execFileSync("bun", [copy, ui], {
	cwd: work,
	stdio: "inherit",
	// Upstream's script makes its consumers under the temp directory.
	env: { ...process.env, TMPDIR: work },
});

// The Board tab: its entry loads in Node beside its optional peers, and both
// stylesheets (its own, and the xyflow one it imports) resolve.
const boardConsumer = join(work, "board-consumer");
mkdirSync(boardConsumer, { recursive: true });
writeFileSync(
	join(boardConsumer, "package.json"),
	`${JSON.stringify(JSON.parse(consumerManifest("board-consumer")), null, "\t")}\n`,
);
execFileSync(
	"npm",
	[
		"install",
		"--no-audit",
		"--no-fund",
		"--loglevel=error",
		ui,
		"react@18",
		"react-dom@18",
		"@xyflow/react@12",
		"@dagrejs/dagre@3",
	],
	{ cwd: boardConsumer, stdio: "inherit" },
);
const boardCheck = `
const board = await import("@cerebriline/ui/components/board-viewer");
for (const name of ["BoardViewer", "windowMessageTransport", "readViewerMessage", "readBoardText"]) {
	if (typeof board[name] !== "function") throw new Error("board-viewer is missing " + name);
}
const css = new URL(import.meta.resolve("@cerebriline/ui/components/board-viewer.css"));
const text = (await import("node:fs")).readFileSync(css, "utf8");
const imported = text.match(/@import "([^"]+)"/g) ?? [];
if (imported.length === 0) throw new Error("board-viewer.css imports nothing");
for (const line of imported) import.meta.resolve(line.slice(9, -1));
if (text.includes("@cline/")) throw new Error("board-viewer.css names the @cline scope");
`;
execFileSync(process.execPath, ["--input-type=module", "-e", boardCheck], {
	cwd: boardConsumer,
	stdio: "inherit",
});
if (existsSync(join(boardConsumer, "node_modules", "@cline"))) {
	throw new Error(
		"the board consumer pulled in a package from the @cline scope",
	);
}
console.log("ok   @cerebriline/ui/components/board-viewer");
console.log(`ok   @cerebriline/ui (${ui.split("/").at(-1)})`);
