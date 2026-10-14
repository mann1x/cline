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

// One session against a stub Ollama, reading what goes on the wire. Loading
// every entry point proved nothing about a request: 4.100.250 passed this
// script and then sent Ollama a bare `think: true` for every effort level,
// because the installed `ollama-ai-provider-v2` was the registry's and the
// level is carried by this repository's patch to it. The same install threw on
// its first tool-using session under the zod that `^4.3.6` resolved to.
// npm nests a dependency under the package that asked for it when versions
// differ, so both places are looked in.
const stockOllama = [
	join(work, "node_modules"),
	...PACKAGES.map((name) =>
		join(work, "node_modules", "@cerebriline", name, "node_modules"),
	),
].find((directory) => existsSync(join(directory, "ollama-ai-provider-v2")));
if (stockOllama) {
	fail(
		`the install pulled in ollama-ai-provider-v2 (${stockOllama}); the patched copy must be bundled`,
	);
}
try {
	const { createServer } = await import("node:http");
	const sdk = await import(
		pathToFileURL(
			join(work, "node_modules", "@cerebriline", "sdk", "dist", "index.js"),
		).href
	);
	const chats = [];
	const line = (message, rest) =>
		`${JSON.stringify({ model: "m", created_at: "2024-01-01T00:00:00Z", message, ...rest })}\n`;
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			if (request.url === "/api/chat") {
				const body = JSON.parse(raw);
				// The reachability probes ask for one token; the turn does not.
				if ((body.options?.num_predict ?? 2) > 1) chats.push(body);
				response.writeHead(200, { "content-type": "application/x-ndjson" });
				response.write(
					line({ role: "assistant", content: "done" }, { done: false }),
				);
				response.end(
					line(
						{ role: "assistant", content: "" },
						{
							done: true,
							done_reason: "stop",
							prompt_eval_count: 1,
							eval_count: 1,
						},
					),
				);
			} else if (request.url === "/api/show") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						capabilities: ["completion", "tools", "thinking"],
						model_info: {},
						parameters: "",
					}),
				);
			} else {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
			}
		});
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const cwd = join(work, "wire-workspace");
	mkdirSync(cwd, { recursive: true });
	const core = await sdk.ClineCore.create({
		backendMode: "local",
		dataDir: join(work, "wire-data"),
	});
	// The saved effort is the budget dropdown's share and travels as
	// `think_budget`; `think` names a level only when one was picked.
	for (const [label, thinking, expected, budget] of [
		[
			"a budget share",
			{ thinking: true, reasoningEffort: "high" },
			true,
			"high",
		],
		[
			"a picked level",
			{
				thinking: true,
				providerConfig: {
					providerId: "ollama",
					modelId: "m",
					baseUrl,
					sampling: { reasoningLevel: "xhigh" },
				},
			},
			"xhigh",
			undefined,
		],
		["thinking left unset", {}, true, undefined],
		["thinking off", { thinking: false }, false, undefined],
	]) {
		chats.length = 0;
		const started = await core.start({
			config: {
				providerId: "ollama",
				modelId: "m",
				baseUrl,
				cwd,
				systemPrompt: "smoke",
				mode: "act",
				enableTools: true,
				enableSpawnAgent: false,
				enableAgentTeams: false,
				storedProviderSettings: "ignore",
				contextWindow: 32768,
				...thinking,
			},
			prompt: "hi",
			interactive: false,
		});
		await core.stop(started.sessionId).catch(() => {});
		const sent = chats.at(-1);
		if (!sent) {
			fail(`wire, ${label}: no chat request reached the server`);
		} else if (sent.think !== expected) {
			fail(
				`wire, ${label}: think is ${JSON.stringify(sent.think)}, expected ${JSON.stringify(expected)}`,
			);
		} else if (sent.options?.think_budget !== budget) {
			fail(
				`wire, ${label}: think_budget is ${JSON.stringify(sent.options?.think_budget)}, expected ${JSON.stringify(budget)}`,
			);
		} else if (sent.options?.num_ctx !== 32768) {
			fail(`wire, ${label}: num_ctx is ${sent.options?.num_ctx}`);
		} else {
			console.log(
				`ok   wire, ${label}: think ${JSON.stringify(sent.think)}, think_budget ${JSON.stringify(sent.options?.think_budget)}, ${sent.tools?.length ?? 0} tools`,
			);
		}
	}
	server.close();
	await core.dispose().catch(() => {});
} catch (error) {
	fail(
		`a session against a stub server :: ${String(error?.stack ?? error)
			.split("\n")
			.slice(0, 3)
			.join(" | ")
			.slice(0, 400)}`,
	);
}

if (!values.work) rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall entry points load");
// A session leaves timers behind; the verdict is in, so leave.
process.exit(failed ? 1 : 0);
