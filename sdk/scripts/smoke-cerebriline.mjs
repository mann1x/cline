#!/usr/bin/env node
/**
 * Install the packed `@cerebriline/*` tarballs into an empty project and load
 * them, the way someone who ran `npm install @cerebriline/sdk` would.
 *
 * The SDK's own tests run from the workspace, where packages resolve to source
 * and to each other by path. None of that is what gets published: this is the
 * only check of the tarballs themselves. It caught the hub entry failing to
 * load on its own ("F60 is not defined") the first time it ran.
 *
 *   node sdk/scripts/smoke-cerebriline.mjs --dir <tarballs> [--work <empty dir>]
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PACKAGES = ["shared", "llms", "agents", "core", "sdk"];
const { values } = parseArgs({
	options: { dir: { type: "string" }, work: { type: "string" } },
	strict: true,
});
if (!values.dir) {
	console.error("smoke-cerebriline: --dir <directory of tarballs> is required");
	process.exit(1);
}
const tarballs = readdirSync(resolve(values.dir))
	.filter((name) => name.endsWith(".tgz"))
	.map((name) => join(resolve(values.dir), name));
if (tarballs.length !== PACKAGES.length) {
	console.error(
		`smoke-cerebriline: expected ${PACKAGES.length} tarballs, found ${tarballs.length}`,
	);
	process.exit(1);
}

const work = values.work
	? resolve(values.work)
	: mkdtempSync(join(tmpdir(), "cerebriline-sdk-"));
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(
	join(work, "package.json"),
	`${JSON.stringify({ name: "smoke", private: true, type: "module" })}\n`,
);
execFileSync(
	"npm",
	["install", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs],
	{
		cwd: work,
		stdio: ["ignore", "ignore", "inherit"],
	},
);

let failed = 0;
const fail = (line) => {
	failed++;
	console.log(`FAIL ${line}`);
};

if (existsSync(join(work, "node_modules", "@cline"))) {
	fail("the install pulled in a package from the @cline scope");
}

for (const name of PACKAGES) {
	const root = join(work, "node_modules", "@cerebriline", name);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	for (const [key, target] of Object.entries(
		manifest.exports ?? { ".": { import: manifest.main } },
	)) {
		const specifier = `@cerebriline/${name}${key === "." ? "" : key.slice(1)}`;
		const file = typeof target === "string" ? target : target.import;
		if (!file || !existsSync(join(root, file))) {
			// Upstream declares `./types` with a runtime file it never emits; the
			// declarations are what that path is for.
			const types = typeof target === "object" ? target.types : undefined;
			if (types && existsSync(join(root, types))) {
				console.log(`ok   ${specifier}  (types only)`);
			} else {
				fail(
					`${specifier} :: ${file ?? "no import target"} is not in the package`,
				);
			}
			continue;
		}
		// Importing the daemon entry starts a hub daemon. Its presence is the check.
		if (key.endsWith("daemon-entry")) {
			console.log(`ok   ${specifier}  (present, not run)`);
			continue;
		}
		try {
			const mod = await import(pathToFileURL(join(root, file)).href);
			console.log(`ok   ${specifier}  (${Object.keys(mod).length} exports)`);
		} catch (error) {
			const message = String(error?.message ?? error).split("\n")[0];
			// An optional peer the consumer installs only if they want it.
			const optional = Object.keys(manifest.peerDependenciesMeta ?? {}).find(
				(peer) =>
					manifest.peerDependenciesMeta[peer]?.optional &&
					message.includes(`'${peer}'`),
			);
			if (optional) {
				console.log(`ok   ${specifier}  (needs the optional peer ${optional})`);
			} else {
				fail(`${specifier} :: ${message.slice(0, 200)}`);
			}
		}
	}
}

// The two names the README leads with, built without touching a network.
try {
	const sdk = await import(
		pathToFileURL(
			join(work, "node_modules", "@cerebriline", "sdk", "dist", "index.js"),
		).href
	);
	const tool = sdk.createTool({
		name: "add",
		description: "Add two integers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		execute: async (input) => ({ sum: input.a + input.b }),
	});
	const agent = new sdk.Agent({
		providerId: "ollama",
		modelId: "none",
		baseUrl: "http://127.0.0.1:9",
		systemPrompt: "smoke",
		tools: [tool],
	});
	if (typeof agent.run !== "function") fail("Agent has no run()");
	else console.log("ok   new Agent({ tools: [createTool(...)] })");
} catch (error) {
	fail(
		`constructing an Agent :: ${String(error?.message ?? error)
			.split("\n")[0]
			.slice(0, 200)}`,
	);
}

if (!values.work) rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall entry points load");
process.exit(failed ? 1 : 0);
