/**
 * Pipelines as files in the workspace (plan sections 2 and 7).
 *
 * `.cerebriline/pipelines/<slug>.pipeline.json`, versioned by the
 * workspace's Git. A version is the hash of the file's text. Which version
 * may run is recorded in `.cerebriline/pipelines/approved.json`, written
 * only when the person approves; a file the model saved is a proposal until
 * then.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PipelineDefinition } from "./model";
import { pipelineHash, validatePipeline } from "./validate";

export const PIPELINES_DIR = join(".cerebriline", "pipelines");
export const PIPELINE_FILE_SUFFIX = ".pipeline.json";
const APPROVALS_FILE = "approved.json";

export interface PipelineApproval {
	hash: string;
	/** Who approved: the person, by the host's name for them. */
	by: string;
	at: string;
}

export interface PipelineFile {
	/** The pipeline's `name`, or the file's slug when it has none. */
	name: string;
	slug: string;
	path: string;
	text: string;
	hash: string;
	valid: boolean;
	errors: string[];
	definition?: PipelineDefinition;
	approved?: PipelineApproval;
	/** The file is the version that was approved. */
	isApproved: boolean;
}

export function pipelineSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "pipeline"
	);
}

export function pipelinesDir(workspaceRoot: string): string {
	return join(workspaceRoot, PIPELINES_DIR);
}

export function readApprovals(
	workspaceRoot: string,
): Record<string, PipelineApproval> {
	const path = join(pipelinesDir(workspaceRoot), APPROVALS_FILE);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, PipelineApproval>)
			: {};
	} catch {
		return {};
	}
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

function readFile(
	path: string,
	approvals: Record<string, PipelineApproval>,
): PipelineFile {
	const text = readFileSync(path, "utf8");
	const slug = path
		.replace(/^.*[\\/]/, "")
		.slice(0, -PIPELINE_FILE_SUFFIX.length);
	const checked = validatePipeline(text);
	const hash = pipelineHash(text);
	const approved = approvals[slug];
	return {
		name: checked.pipeline?.name ?? slug,
		slug,
		path,
		text,
		hash,
		valid: checked.ok,
		errors: checked.errors,
		...(checked.pipeline ? { definition: checked.pipeline } : {}),
		...(approved ? { approved } : {}),
		isApproved: approved?.hash === hash,
	};
}

/** Every pipeline file in the workspace, by slug. */
export function listPipelines(workspaceRoot: string): PipelineFile[] {
	const dir = pipelinesDir(workspaceRoot);
	if (!existsSync(dir)) return [];
	const approvals = readApprovals(workspaceRoot);
	return readdirSync(dir)
		.filter((file) => file.endsWith(PIPELINE_FILE_SUFFIX))
		.sort()
		.map((file) => readFile(join(dir, file), approvals));
}

/** One pipeline, by name or slug. */
export function findPipeline(
	workspaceRoot: string,
	name: string,
): PipelineFile | undefined {
	const wanted = name.trim().toLowerCase();
	const all = listPipelines(workspaceRoot);
	return (
		all.find((file) => file.slug === pipelineSlug(name)) ??
		all.find((file) => file.name.toLowerCase() === wanted)
	);
}

export type SaveOutcome =
	| { ok: true; file: PipelineFile; created: boolean }
	| { ok: false; errors: string[] };

/**
 * Write a pipeline. It is validated first; an existing file is replaced
 * only when `base` is the hash the writer last saw, so a model never
 * overwrites a change the person made after it looked (as the editor
 * refuses a stale read).
 */
export function savePipeline(
	workspaceRoot: string,
	definition: unknown,
	base?: string,
): SaveOutcome {
	const checked = validatePipeline(definition);
	if (!checked.ok || !checked.pipeline)
		return { ok: false, errors: checked.errors };
	const slug = pipelineSlug(checked.pipeline.name);
	const dir = pipelinesDir(workspaceRoot);
	const path = join(dir, `${slug}${PIPELINE_FILE_SUFFIX}`);
	const created = !existsSync(path);
	if (!created) {
		const current = pipelineHash(readFileSync(path, "utf8"));
		if (base !== current) {
			return {
				ok: false,
				errors: [
					base
						? `${slug}${PIPELINE_FILE_SUFFIX} changed since version ${base} (it is ${current} now): read it with \`pipeline show\` and save again from that`
						: `${slug}${PIPELINE_FILE_SUFFIX} exists: send \`base\` with the version \`pipeline show\` gave, so a newer change is not overwritten`,
				],
			};
		}
	}
	mkdirSync(dir, { recursive: true });
	writeAtomic(path, `${JSON.stringify(checked.pipeline, null, "\t")}\n`);
	return {
		ok: true,
		file: readFile(path, readApprovals(workspaceRoot)),
		created,
	};
}

/** The person approves the file's current version: it may run. */
export function approvePipeline(
	workspaceRoot: string,
	name: string,
	by = "user",
	now: () => Date = () => new Date(),
): PipelineFile {
	const file = findPipeline(workspaceRoot, name);
	if (!file) throw new Error(`no pipeline "${name}" in ${PIPELINES_DIR}`);
	if (!file.valid) {
		throw new Error(
			`"${file.name}" does not validate: ${file.errors.join("; ")}`,
		);
	}
	const approvals = readApprovals(workspaceRoot);
	approvals[file.slug] = { hash: file.hash, by, at: now().toISOString() };
	const dir = pipelinesDir(workspaceRoot);
	mkdirSync(dir, { recursive: true });
	writeAtomic(
		join(dir, APPROVALS_FILE),
		`${JSON.stringify(approvals, null, "\t")}\n`,
	);
	return {
		...file,
		approved: approvals[file.slug] as PipelineApproval,
		isApproved: true,
	};
}
