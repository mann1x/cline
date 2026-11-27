/**
 * Pipelines as files in the workspace (plan sections 2 and 7).
 *
 * `.cerebriline/pipelines/<slug>.pipeline.json`, versioned by the
 * workspace's Git. A version is the hash of the file's text. Which version
 * may run is recorded in `.cerebriline/pipelines/approved.json`, written
 * only when the person approves; a file the model saved is a proposal until
 * then.
 *
 * Every version saved or approved is also kept under
 * `.cerebriline/pipelines/versions/<slug>/<hash>.json`, with who wrote it, so
 * a proposal can be shown against the approved version and rejected back to
 * it before the workspace's Git has either (plan phase 4).
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PipelineDefinition } from "./model";
import { pipelineHash, validatePipeline } from "./validate";

export const PIPELINES_DIR = join(".cerebriline", "pipelines");
export const PIPELINE_FILE_SUFFIX = ".pipeline.json";
const APPROVALS_FILE = "approved.json";
const VERSIONS_DIR = "versions";
/** Versions kept per pipeline; the approved one is kept beyond that. */
export const PIPELINE_VERSIONS_KEPT = 20;

/** Who wrote a version: the model through `pipeline save`, or the person. */
export type PipelineAuthor = "model" | "person";

/** One kept version of a pipeline file. */
export interface PipelineVersion {
	hash: string;
	by: PipelineAuthor;
	at: string;
	/** The version it replaced, when it replaced one. */
	base?: string;
	/** Set when the person rejected it and the file went back to the approved version. */
	rejected?: { at: string };
	text: string;
}

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
	/** Who wrote the file's version, when it was kept. */
	author?: PipelineAuthor;
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
	const author = readVersionRecord(
		join(path, "..", VERSIONS_DIR, slug, `${hash}.json`),
	)?.by;
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
		...(author ? { author } : {}),
	};
}

function versionsDir(workspaceRoot: string, slug: string): string {
	return join(pipelinesDir(workspaceRoot), VERSIONS_DIR, slug);
}

function readVersionRecord(path: string): PipelineVersion | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as PipelineVersion;
		return parsed && typeof parsed.text === "string" && parsed.hash
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

/** One kept version, or undefined when it was not kept. */
export function readPipelineVersion(
	workspaceRoot: string,
	slug: string,
	hash: string,
): PipelineVersion | undefined {
	if (!/^[0-9a-f]{16}$/.test(hash)) return undefined;
	return readVersionRecord(
		join(versionsDir(workspaceRoot, slug), `${hash}.json`),
	);
}

/** A pipeline's kept versions, newest first. */
export function listPipelineVersions(
	workspaceRoot: string,
	slug: string,
): PipelineVersion[] {
	const dir = versionsDir(workspaceRoot, slug);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => readVersionRecord(join(dir, file)))
		.filter((version): version is PipelineVersion => !!version)
		.sort((a, b) => b.at.localeCompare(a.at) || a.hash.localeCompare(b.hash));
}

/**
 * Keep `text` as a version of `slug`. A version already kept keeps its first
 * author: the model's proposal stays the model's after the person approves it.
 */
function keepVersion(
	workspaceRoot: string,
	slug: string,
	text: string,
	by: PipelineAuthor,
	at: string,
	base?: string,
): void {
	const hash = pipelineHash(text);
	const dir = versionsDir(workspaceRoot, slug);
	const path = join(dir, `${hash}.json`);
	if (existsSync(path)) return;
	mkdirSync(dir, { recursive: true });
	const record: PipelineVersion = {
		hash,
		by,
		at,
		...(base && base !== hash ? { base } : {}),
		text,
	};
	writeAtomic(path, `${JSON.stringify(record, null, "\t")}\n`);
	prune(workspaceRoot, slug);
}

function prune(workspaceRoot: string, slug: string): void {
	const keep = readApprovals(workspaceRoot)[slug]?.hash;
	const dir = versionsDir(workspaceRoot, slug);
	for (const version of listPipelineVersions(workspaceRoot, slug).slice(
		PIPELINE_VERSIONS_KEPT,
	)) {
		if (version.hash === keep) continue;
		try {
			unlinkSync(join(dir, `${version.hash}.json`));
		} catch {
			// A version that cannot be removed only costs its space.
		}
	}
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
export interface SaveOptions {
	/** Who is saving; the model's version is a proposal. Defaults to the model. */
	by?: PipelineAuthor;
	/**
	 * Approve what is saved: the person's own edits are approved as they save
	 * (plan section 7). Only for `by: "person"`; a conversion the person has
	 * not read yet passes false.
	 */
	approve?: boolean;
	now?: () => Date;
}

export function savePipeline(
	workspaceRoot: string,
	definition: unknown,
	base?: string,
	options: SaveOptions = {},
): SaveOutcome {
	const checked = validatePipeline(definition);
	if (!checked.ok || !checked.pipeline)
		return { ok: false, errors: checked.errors };
	const slug = pipelineSlug(checked.pipeline.name);
	const dir = pipelinesDir(workspaceRoot);
	const path = join(dir, `${slug}${PIPELINE_FILE_SUFFIX}`);
	const created = !existsSync(path);
	let current: string | undefined;
	if (!created) {
		current = pipelineHash(readFileSync(path, "utf8"));
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
	const by = options.by ?? "model";
	const at = (options.now ?? (() => new Date()))().toISOString();
	const text = `${JSON.stringify(checked.pipeline, null, "\t")}\n`;
	mkdirSync(dir, { recursive: true });
	// The version it replaces is kept first, so a file written by hand
	// before versions were kept can still be shown against and restored.
	if (current && !created) {
		keepVersion(workspaceRoot, slug, readFileSync(path, "utf8"), "person", at);
	}
	writeAtomic(path, text);
	keepVersion(workspaceRoot, slug, text, by, at, current);
	if (by === "person" && options.approve !== false) {
		return {
			ok: true,
			file: approvePipeline(workspaceRoot, slug, "user", options.now),
			created,
		};
	}
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
	const at = now().toISOString();
	approvals[file.slug] = { hash: file.hash, by, at };
	// What was approved is kept, so a later proposal can be shown against it.
	keepVersion(workspaceRoot, file.slug, file.text, "person", at);
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

/**
 * The person rejects the file's version: the file goes back to the approved
 * version, and the rejected one is marked so in its record (it stays, for
 * the viewer and for the model's next look). Refused when the file is the
 * approved version, and when the approved version was not kept.
 */
export function rejectPipeline(
	workspaceRoot: string,
	name: string,
	now: () => Date = () => new Date(),
): PipelineFile {
	const file = findPipeline(workspaceRoot, name);
	if (!file) throw new Error(`no pipeline "${name}" in ${PIPELINES_DIR}`);
	if (file.isApproved) {
		throw new Error(
			`"${file.name}" is the approved version: nothing to reject`,
		);
	}
	if (!file.approved) {
		throw new Error(
			`"${file.name}" has no approved version to go back to: delete the file to drop it`,
		);
	}
	const approved = readPipelineVersion(
		workspaceRoot,
		file.slug,
		file.approved.hash,
	);
	if (!approved) {
		throw new Error(
			`the approved version ${file.approved.hash} of "${file.name}" was not kept: restore it from Git`,
		);
	}
	const at = now().toISOString();
	keepVersion(workspaceRoot, file.slug, file.text, file.author ?? "person", at);
	const rejectedPath = join(
		versionsDir(workspaceRoot, file.slug),
		`${file.hash}.json`,
	);
	const rejected = readVersionRecord(rejectedPath);
	if (rejected) {
		writeAtomic(
			rejectedPath,
			`${JSON.stringify({ ...rejected, rejected: { at } }, null, "\t")}\n`,
		);
	}
	writeAtomic(file.path, approved.text);
	return readFile(file.path, readApprovals(workspaceRoot));
}
