/**
 * Rewrite the tool sections of the shipped templates from the tools themselves.
 *
 * `default.md` carries every tool description verbatim, because a template is
 * allowed to override one and a model reading the file has to be reading what
 * the model in a session is really given. Every family template carries a
 * section for every tool too (its own words, or `{{DEFAULT}}`), so nothing in
 * a file silently relies on the fallback.
 *
 *   bun scripts/sync-default-template.mts          # rewrite
 *   bun scripts/sync-default-template.mts --check  # fail if anything is stale
 *
 * It runs on every build of this package (`build` in package.json) and the
 * test suite runs the same check, so the file cannot go stale: a changed
 * description is copied in, and a tool new to the code gets its section --
 * its text in `default.md`, `{{DEFAULT}}` in the family templates -- after
 * the last tool section. The tool list is built, not kept
 * (`template-tool-inventory.ts`).
 *
 * The `# system` section is never touched. That part is written by hand and is
 * the whole point of the file; only the `# tool:` sections are generated.
 * Computed descriptions (`COMPUTED_TOOL_NAMES`) stay as the marker, and host
 * tools -- the ones `apps/vscode` contributes -- cannot be constructed from
 * here, so their sections are left exactly as they are and guarded by a test on
 * that side of the boundary.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMPUTED_TOOL_NAMES,
	HOST_TOOL_NAMES,
	templateToolInventory,
} from "../src/extensions/config/template-tool-inventory";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, "..", "assets", "prompt-templates");
const COMPUTED = new Set(COMPUTED_TOOL_NAMES);
const MARKER = "{{DEFAULT}}";

type Section = { heading: string; body: string };

/**
 * Split a file into its sections without parsing it as a template: the parser
 * would give back the text but not the order or the sections it does not know,
 * and both have to survive a rewrite.
 */
function splitSections(raw: string): Section[] {
	const sections: Section[] = [];
	let heading = "";
	let body: string[] = [];
	for (const line of raw.split("\n")) {
		if (/^# (system|tool: |compaction: )/.test(line)) {
			if (heading !== "") sections.push({ heading, body: body.join("\n") });
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
	if (heading !== "") sections.push({ heading, body: body.join("\n") });
	return sections;
}

function toolName(section: Section): string | undefined {
	return /^# tool: (.+)$/.exec(section.heading)?.[1];
}

function render(sections: Section[]): string {
	const preamble = sections
		.filter((section) => section.heading === "")
		.map((section) => section.body)
		.join("\n")
		.trimEnd();
	const rest = sections
		.filter((section) => section.heading !== "")
		.map((section) => `${section.heading}\n${section.body.trim()}`);
	return `${[preamble, ...rest].join("\n\n").trimEnd()}\n`;
}

/** New sections go after the last tool section, ahead of any compaction ones. */
function insertAfterTools(sections: Section[], added: Section[]): Section[] {
	if (added.length === 0) return sections;
	let at = sections.length;
	for (let index = sections.length - 1; index >= 0; index--) {
		if (toolName(sections[index] as Section)) {
			at = index + 1;
			break;
		}
	}
	return [...sections.slice(0, at), ...added, ...sections.slice(at)];
}

/** `raw` without the named tool sections (heading to the next heading), untouched otherwise. */
function removeSections(raw: string, names: string[]): string {
	if (names.length === 0) return raw;
	const out: string[] = [];
	let skipping = false;
	let joinAfterSkip = false;
	for (const line of raw.split("\n")) {
		if (/^# (system|tool: |compaction: )/.test(line)) {
			const name = /^# tool: (.+)$/.exec(line)?.[1];
			if (name !== undefined && names.includes(name)) {
				// Drop the section and the blank lines that led into it.
				while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "")
					out.pop();
				skipping = true;
				joinAfterSkip = true;
				continue;
			}
			if (joinAfterSkip && out.length > 0) out.push("");
			skipping = false;
			joinAfterSkip = false;
		}
		if (!skipping) out.push(line);
	}
	// A removed last section leaves the file ending on the one before it.
	if (skipping) return `${out.join("\n")}\n`;
	return out.join("\n");
}

/** `raw` with `added` inserted after its last tool section, untouched otherwise. */
function spliceAfterTools(raw: string, added: Section[]): string {
	if (added.length === 0) return raw;
	const lines = raw.split("\n");
	let lastTool = -1;
	for (let index = 0; index < lines.length; index++) {
		if (/^# tool: /.test(lines[index] ?? "")) lastTool = index;
	}
	let end = lines.length;
	for (let index = lastTool + 1; index < lines.length; index++) {
		if (/^# (system|tool: |compaction: )/.test(lines[index] ?? "")) {
			end = index;
			break;
		}
	}
	while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
	const block = added
		.map((section) => `${section.heading}\n${section.body}`)
		.join("\n\n");
	const before = lines.slice(0, end).join("\n");
	const after = lines.slice(end).join("\n").replace(/^\n*/, "");
	return after
		? `${before}\n\n${block}\n\n${after}`
		: `${before}\n\n${block}\n`;
}

function main(): void {
	const check = process.argv.includes("--check");
	const tools = templateToolInventory();
	const descriptions = new Map(
		tools.map((tool) => [tool.name, (tool.description ?? "").trim()]),
	);
	const problems: string[] = [];
	const changed: string[] = [];

	for (const file of readdirSync(TEMPLATE_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()) {
		const path = join(TEMPLATE_DIR, file);
		const raw = readFileSync(path, "utf8");
		const isDefault = file === "default.md";
		const sections = splitSections(raw);
		const have = new Set(sections.map(toolName).filter(Boolean) as string[]);
		const stale: string[] = [];

		if (isDefault) {
			for (const section of sections) {
				const name = toolName(section);
				if (!name || COMPUTED.has(name) || !descriptions.has(name)) continue;
				const wanted = descriptions.get(name) ?? "";
				if (section.body.trim() !== wanted) {
					stale.push(name);
					section.body = wanted;
				}
			}
		}
		// A section for a tool neither this package nor the host provides any
		// more (task_progress, since 4.100.292) is removed, in every file.
		const known = new Set([...descriptions.keys(), ...HOST_TOOL_NAMES]);
		const gone = sections
			.map(toolName)
			.filter(
				(name): name is string => Boolean(name) && !known.has(name as string),
			);
		const kept = gone.length
			? sections.filter((section) => !gone.includes(toolName(section) ?? ""))
			: sections;
		const missing = [...descriptions.keys()].filter((name) => !have.has(name));
		const added = missing.map((name) => ({
			heading: `# tool: ${name}`,
			body:
				isDefault && !COMPUTED.has(name)
					? (descriptions.get(name) ?? "")
					: MARKER,
		}));
		// default.md is generated, so it is rendered whole; a family template
		// was written by a model and keeps its text exactly, the new sections
		// spliced in after its last tool section.
		const next = isDefault
			? render(insertAfterTools(kept, added))
			: spliceAfterTools(removeSections(raw, gone), added);
		if (next === raw) continue;
		for (const name of stale) problems.push(`${file}: ${name} is stale`);
		for (const name of missing)
			problems.push(`${file}: ${name} has no section`);
		for (const name of gone)
			problems.push(`${file}: ${name} is no longer a tool`);
		if (stale.length === 0 && missing.length === 0 && gone.length === 0)
			problems.push(`${file}: layout differs`);
		if (!check) {
			writeFileSync(path, next, "utf8");
			changed.push(file);
		}
	}

	if (problems.length === 0) {
		console.log("The shipped templates are up to date.");
		return;
	}
	if (check) {
		for (const line of problems) console.error(`  ${line}`);
		console.error("Run: bun scripts/sync-default-template.mts");
		process.exit(1);
	}
	for (const line of problems) console.log(`  ${line}`);
	console.log(`Rewrote ${changed.length} file(s): ${changed.join(", ")}`);
}

main();
