/**
 * Rewrite the tool sections of `default.md` from the tools themselves.
 *
 * `default.md` carries every tool description verbatim, because a template is
 * allowed to override one and a model reading the file has to be reading what
 * the model in a session is really given. A guard test proves the two match,
 * which turns any change to a description into a failing test and a manual
 * copy — fine for one tool, miserable for thirty, and the kind of chore that
 * ends with someone editing the test instead of the file.
 *
 * So the copying is done here:
 *
 *   bun scripts/sync-default-template.mts        # rewrite
 *   bun scripts/sync-default-template.mts --check  # fail if stale (CI)
 *
 * The `# system` section is never touched. That part is written by hand and is
 * the whole point of the file; only the `# tool:` sections are generated.
 *
 * Two tools keep `{{DEFAULT}}` instead of their text: `run_commands` is written
 * against whichever shell was detected and `skills` appends the skills that
 * happen to be installed, so pinning either would pin one machine's answer.
 * Host tools — the ones `apps/vscode` contributes — cannot be constructed from
 * here at all, so their sections are left exactly as they are and guarded by a
 * test on that side of the boundary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createApplyPatchTool,
	createAskQuestionTool,
	createEditorTool,
	createReadFilesTool,
	createSearchTool,
	createShellTool,
	createSkillsTool,
	createSubmitAndExitTool,
	createWebFetchTool,
} from "../src/extensions/tools/definitions";
import { createSpawnAgentTool } from "../src/extensions/tools/team/spawn-agent-tool";
import { createAgentTeamsTools } from "../src/extensions/tools/team/team-tools";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(
	here,
	"..",
	"assets",
	"prompt-templates",
	"default.md",
);

/** Descriptions that are computed per machine and stay as the marker. */
const COMPUTED = new Set(["run_commands", "skills"]);

const stubExecutor = (() => {
	throw new Error("not executed");
}) as never;

function liveTools(): { name: string; description?: string }[] {
	// Only the tools whose description depends on where they run take a cwd.
	// The rest were narrowed to a timeout of their own in f4fe3d36e and reject
	// this object outright, so they are left to their defaults.
	const config = { cwd: "/workspace" };
	return [
		createReadFilesTool(stubExecutor),
		createSearchTool(stubExecutor, config),
		createShellTool(stubExecutor, config),
		createWebFetchTool(stubExecutor),
		createEditorTool(stubExecutor, config),
		createApplyPatchTool(stubExecutor, config),
		createSkillsTool(stubExecutor),
		createAskQuestionTool(stubExecutor),
		createSubmitAndExitTool(stubExecutor),
		createSpawnAgentTool({ configProvider: {} as never }),
		...createAgentTeamsTools({
			runtime: {} as never,
			requesterId: "lead",
			teammateConfigProvider: {} as never,
		}),
	];
}

/**
 * Split the file into its sections without parsing it as a template.
 *
 * The parser would give back the sections' text but not the order they were
 * written in or the host sections it knows nothing about, and both have to
 * survive a rewrite.
 */
function splitSections(raw: string): { heading: string; body: string }[] {
	const lines = raw.split("\n");
	const sections: { heading: string; body: string }[] = [];
	let heading = "";
	let body: string[] = [];
	for (const line of lines) {
		if (/^# (system|tool: )/.test(line)) {
			if (heading !== "") {
				sections.push({ heading, body: body.join("\n") });
			}
			heading = line;
			body = [];
			continue;
		}
		if (heading === "") {
			// Frontmatter and the comment above the first heading.
			sections.push({ heading: "", body: line });
			continue;
		}
		body.push(line);
	}
	if (heading !== "") {
		sections.push({ heading, body: body.join("\n") });
	}
	return sections;
}

function main(): void {
	const check = process.argv.includes("--check");
	const raw = readFileSync(TEMPLATE_PATH, "utf8");
	const descriptions = new Map(
		liveTools().map((tool) => [tool.name, (tool.description ?? "").trim()]),
	);

	const preamble: string[] = [];
	const sections = splitSections(raw);
	const rendered: string[] = [];
	const stale: string[] = [];
	const missing = new Set(descriptions.keys());

	for (const section of sections) {
		if (section.heading === "") {
			preamble.push(section.body);
			continue;
		}
		const toolMatch = /^# tool: (.+)$/.exec(section.heading);
		const name = toolMatch?.[1];
		const current = section.body.trim();
		if (!name || COMPUTED.has(name) || !descriptions.has(name)) {
			// The system section, a computed marker, or a host tool this package
			// cannot build. All three are kept exactly as written.
			missing.delete(name ?? "");
			rendered.push(`${section.heading}\n${current}`);
			continue;
		}
		missing.delete(name);
		const wanted = descriptions.get(name) ?? "";
		if (current !== wanted) {
			stale.push(name);
		}
		rendered.push(`${section.heading}\n${wanted}`);
	}

	// A tool that exists in code and has no section at all is the failure the
	// guard test catches; say so here rather than writing it in silently, since
	// where it belongs in the file is an editorial decision.
	for (const name of missing) {
		console.error(`  ${name} has no section in default.md — add one`);
	}

	// Sections are separated by a blank line. The parser does not need it; a
	// person reading a thirty-section file does.
	const next = `${[preamble.join("\n").trimEnd(), ...rendered].join("\n\n").trimEnd()}\n`;
	if (next === raw && missing.size === 0) {
		console.log("default.md is up to date.");
		return;
	}
	if (check) {
		for (const name of stale) {
			console.error(`  ${name} is stale in default.md`);
		}
		console.error("Run: bun scripts/sync-default-template.mts");
		process.exit(1);
	}
	writeFileSync(TEMPLATE_PATH, next, "utf8");
	console.log(
		stale.length > 0
			? `Updated ${stale.length} section(s): ${stale.join(", ")}`
			: "Rewrote default.md.",
	);
	if (missing.size > 0) {
		process.exit(1);
	}
}

main();
