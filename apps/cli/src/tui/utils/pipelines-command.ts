import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	approvePipeline,
	foldJournal,
	listPipelines,
	PIPELINE_RUNS_DIR,
	PIPELINES_DIR,
	type PipelineFile,
	readJournal,
} from "@cline/core";

/**
 * `/pipelines`: the person's side of pipelines in the CLI, as the Approve
 * Pipeline command is in the extension. Approval is never a tool — a model
 * that could approve what it wrote would make the step meaningless.
 *
 *   /pipelines                 every pipeline file and whether it may run
 *   /pipelines approve <name>  approve the version on disk now
 *   /pipelines runs            the runs in this workspace, newest first
 */
export const PIPELINES_USAGE =
	"Usage: /pipelines [list] · /pipelines approve <name> · /pipelines runs";

function state(file: PipelineFile): string {
	if (!file.valid) {
		return `does not validate: ${file.errors[0] ?? "unknown problem"}`;
	}
	if (file.isApproved) return `approved, version ${file.hash}`;
	return file.approved
		? `changed since approval, version ${file.hash}: /pipelines approve ${file.slug}`
		: `not approved, version ${file.hash}: /pipelines approve ${file.slug}`;
}

function list(workspaceRoot: string): string {
	const files = listPipelines(workspaceRoot);
	if (files.length === 0) return `No pipelines in ${PIPELINES_DIR} yet.`;
	return [
		`Pipelines in ${PIPELINES_DIR}:`,
		...files.map((file) => `- ${file.name} (${file.slug}): ${state(file)}`),
	].join("\n");
}

function approve(workspaceRoot: string, name: string): string {
	if (!name) return PIPELINES_USAGE;
	try {
		const file = approvePipeline(workspaceRoot, name);
		return `Approved ${file.name} at version ${file.hash}. Any later change to the file needs approving again.`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function runs(workspaceRoot: string, limit = 20): string {
	const dir = join(workspaceRoot, PIPELINE_RUNS_DIR);
	if (!existsSync(dir)) return "No pipeline runs in this workspace yet.";
	const journals = readdirSync(dir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => ({ file, at: statSync(join(dir, file)).mtimeMs }))
		.sort((a, b) => b.at - a.at)
		.slice(0, limit);
	if (journals.length === 0) return "No pipeline runs in this workspace yet.";
	return [
		"Pipeline runs, newest first:",
		...journals.map(({ file }) => {
			const id = file.slice(0, -".jsonl".length);
			const fold = foldJournal(readJournal(join(dir, file)));
			const name = fold.run?.pipeline ? ` (${fold.run.pipeline})` : "";
			const error = fold.error ? `: ${fold.error}` : "";
			return `- ${id}${name}: ${fold.status}${error}`;
		}),
	].join("\n");
}

/** The text `/pipelines …` prints. `text` is the whole command line. */
export function pipelinesCommand(text: string, workspaceRoot: string): string {
	const [verb = "list", ...rest] = text
		.replace(/^\s*\/pipelines\b/, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	switch (verb.toLowerCase()) {
		case "list":
			return list(workspaceRoot);
		case "approve":
			return approve(workspaceRoot, rest.join(" "));
		case "runs":
			return runs(workspaceRoot);
		default:
			return PIPELINES_USAGE;
	}
}
