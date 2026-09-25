/**
 * The private workspaces of every delegated agent in one session.
 *
 * Every path that runs an agent on the lead's behalf -- `spawn_agent`, swarm
 * workers, configured agents (`subagent_<name>`), and teammates -- opens one
 * here, keyed by whatever identifies that agent's run, and closes it when the
 * agent is done. In between the agent's file tools resolve through its overlay
 * and its shell (when it has one) is rooted at the native launcher, so nothing
 * it does touches the lead's tree. What it changed comes back to the lead as
 * revisions in the lead's own revision log, attributed to the agent and never
 * written to disk.
 *
 * One object for all four paths so the rules cannot drift between them:
 *
 * - **The shell.** `run_commands` is offered only when the sandbox has a
 *   launcher for this platform AND the user allowed agent commands. Either
 *   missing and it is withheld -- an un-launched command runs against the real
 *   workspace, which is the escape the sandbox exists to prevent.
 * - **The hand-back.** Each changed file is seeded with the lead's current
 *   on-disk version, then recorded as the agent's revision. A long-lived agent
 *   (a teammate) hands back more than once, so each hand-back carries only
 *   what changed since the last one.
 * - **Disposal.** Idempotent, and it hands back first: an agent that failed,
 *   was cancelled or was shut down still leaves its work where the lead can
 *   find it.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RevisionLog } from "../../../runtime/atomic/file-revisions";
import type { AgentSandbox } from "../../../runtime/sandbox/agent-sandbox";
import type { DefaultExecutorsOptions } from "../executors";
import {
	type DelegatedSandboxProvider,
	type DelegatedSandboxSetup,
	setUpDelegatedSandbox,
	setUpDelegatedSandboxSync,
} from "./agent-sandbox-executors";

/** One file an agent handed back, and the revision it became. */
export interface HandedRevision {
	/** Workspace-relative path, forward-slashed. */
	rel: string;
	/** The revision number in the lead's log. */
	index: number;
	kind: string;
}

/** An agent's open workspace: what its toolset is built from. */
export interface DelegatedWorkspace {
	readonly sandbox: AgentSandbox;
	/** Pass to `createBuiltinTools({ executorOptions })`. */
	readonly executorOptions: DefaultExecutorsOptions;
	/**
	 * Whether the agent gets `run_commands`: a launcher covers this platform and
	 * the user allowed agent commands. False means build it with
	 * `enableBash: false`, whatever the mode preset or routing rules say.
	 */
	readonly allowCommands: boolean;
}

export interface DelegatedSandboxes {
	/** The lead's workspace, read-only to every agent. */
	readonly workspaceRoot: string;
	/** Open a workspace for `key`. A key already open is closed first. */
	open(key: string): Promise<DelegatedWorkspace>;
	/** {@link open} for a caller that cannot await (a teammate's toolset). */
	openSync(key: string): DelegatedWorkspace;
	has(key: string): boolean;
	/**
	 * Fold what the agent changed since its last hand-back into the lead's
	 * revision log, attributed to `agentName`. The workspace stays open.
	 */
	handBack(key: string, agentName: string): Promise<HandedRevision[]>;
	/**
	 * Hand back anything outstanding, then dispose the overlay. A key that is
	 * not open is a no-op returning nothing, so every exit path may call it.
	 */
	close(key: string, agentName: string): Promise<HandedRevision[]>;
	/** Close every open workspace -- the session is ending. */
	closeAll(): Promise<void>;
}

export interface CreateDelegatedSandboxesOptions {
	provider: DelegatedSandboxProvider;
	/** The "Agents can run commands" toggle. */
	commandsEnabled: boolean;
	/** The lead's revision log, read when a hand-back runs. */
	revisionLog: () => RevisionLog | undefined;
}

interface Entry {
	key: string;
	workspace: DelegatedWorkspace;
	agentName?: string;
	/** Fingerprint of each file as last handed back. */
	handed: Map<string, string>;
	/** Hand-backs and the close, one at a time. */
	queue: Promise<unknown>;
	closed: boolean;
}

let overlaySerial = 0;

export function createDelegatedSandboxes(
	options: CreateDelegatedSandboxesOptions,
): DelegatedSandboxes {
	const { provider } = options;
	const entries = new Map<string, Entry>();
	// Closes started without a caller waiting on them.
	const detached = new Set<Promise<unknown>>();

	// Unique per open, never just the key: a teammate respawned under the same
	// id gets a new workspace while the old one is still being disposed, and a
	// shared directory would be deleted out from under the new one.
	const overlayRootFor = (key: string): string =>
		provider.overlayRootFor(
			`${key}~${(++overlaySerial).toString(36)}${Math.random()
				.toString(36)
				.slice(2, 6)}`,
		);

	const register = (key: string, setup: DelegatedSandboxSetup): Entry => {
		const previous = entries.get(key);
		if (previous) {
			// Not awaited -- a caller that cannot await opened this one -- but
			// tracked, so `closeAll` still waits for it.
			const closing = closeEntry(previous).finally(() => {
				detached.delete(closing);
			});
			detached.add(closing);
		}
		const entry: Entry = {
			key,
			workspace: {
				sandbox: setup.sandbox,
				executorOptions: setup.executorOptions,
				allowCommands: setup.commandsEnabled && options.commandsEnabled,
			},
			handed: new Map(),
			queue: Promise.resolve(),
			closed: false,
		};
		entries.set(key, entry);
		return entry;
	};

	const enqueue = <T>(entry: Entry, task: () => Promise<T>): Promise<T> => {
		const next = entry.queue.then(task, task);
		entry.queue = next.catch(() => {});
		return next;
	};

	const handBackEntry = async (
		entry: Entry,
		agentName: string,
	): Promise<HandedRevision[]> => {
		const log = options.revisionLog();
		const handed: HandedRevision[] = [];
		if (!log) {
			return handed;
		}
		const by = `agent:${agentName}`;
		const seen = new Set<string>();
		for (const change of await entry.workspace.sandbox.changedFiles()) {
			seen.add(change.rel);
			const absolutePath = join(provider.workspaceRoot, change.rel);
			const body =
				change.kind === "deleted" || !change.overlayPath
					? undefined
					: await readIfPresent(change.overlayPath);
			const print = fingerprint(body);
			if (entry.handed.get(change.rel) === print) {
				continue;
			}
			log.seed(absolutePath, await readIfPresent(absolutePath), "session");
			const revision = log.record(absolutePath, body, by, {
				intent: `${change.kind} by delegated agent — held as a revision, not written to disk`,
			});
			entry.handed.set(change.rel, print);
			if (revision) {
				handed.push({
					rel: change.rel,
					index: revision.index,
					kind: change.kind,
				});
			}
		}
		// A file handed back before and no longer changed: the agent put it back
		// the way the workspace has it. The lead's latest revision is still the
		// agent's earlier edit, so record the reversal too.
		for (const rel of [...entry.handed.keys()]) {
			if (seen.has(rel)) {
				continue;
			}
			entry.handed.delete(rel);
			const absolutePath = join(provider.workspaceRoot, rel);
			const revision = log.record(
				absolutePath,
				await readIfPresent(absolutePath),
				by,
				{ intent: "reverted by delegated agent — held as a revision" },
			);
			if (revision) {
				handed.push({ rel, index: revision.index, kind: "reverted" });
			}
		}
		return handed;
	};

	const closeEntry = (
		entry: Entry,
		agentName?: string,
	): Promise<HandedRevision[]> => {
		if (entries.get(entry.key) === entry) {
			entries.delete(entry.key);
		}
		if (entry.closed) {
			return Promise.resolve([]);
		}
		entry.closed = true;
		return enqueue(entry, async () => {
			try {
				return await handBackEntry(
					entry,
					agentName ?? entry.agentName ?? "agent",
				);
			} catch {
				// A failed hand-back must not fail teardown.
				return [];
			} finally {
				await entry.workspace.sandbox.dispose().catch(() => {});
			}
		});
	};

	return {
		workspaceRoot: provider.workspaceRoot,
		async open(key) {
			const setup = await setUpDelegatedSandbox({
				workspaceRoot: provider.workspaceRoot,
				overlayRoot: overlayRootFor(key),
				...(provider.binaries ? { binaries: provider.binaries } : {}),
			});
			return register(key, setup).workspace;
		},
		openSync(key) {
			const setup = setUpDelegatedSandboxSync({
				workspaceRoot: provider.workspaceRoot,
				overlayRoot: overlayRootFor(key),
				...(provider.binaries ? { binaries: provider.binaries } : {}),
			});
			return register(key, setup).workspace;
		},
		has: (key) => entries.has(key),
		handBack(key, agentName) {
			const entry = entries.get(key);
			if (!entry) {
				return Promise.resolve([]);
			}
			entry.agentName = agentName;
			return enqueue(entry, () =>
				handBackEntry(entry, agentName).catch(() => []),
			);
		},
		close(key, agentName) {
			const entry = entries.get(key);
			return entry ? closeEntry(entry, agentName) : Promise.resolve([]);
		},
		async closeAll() {
			await Promise.all([
				...[...entries.values()].map((entry) => closeEntry(entry)),
				...detached,
			]);
		},
	};
}

function fingerprint(body: Buffer | undefined): string {
	return body === undefined
		? "deleted"
		: createHash("sha256").update(body).digest("hex");
}

async function readIfPresent(
	absolutePath: string,
): Promise<Buffer | undefined> {
	try {
		return await readFile(absolutePath);
	} catch {
		// Absent or unreadable is "no content at this revision" — a real answer.
		return undefined;
	}
}

/**
 * The note that tells the lead where an agent's work went, to append to the
 * agent's answer. Without it the lead reads or runs its own on-disk copy --
 * unchanged, because the agent worked on a private overlay -- sees no fix, and
 * calls the agent a liar (pandorum 2026-09-24).
 *
 * `text` is the agent's answer before the note, read to tell whether it gave
 * one: an empty answer is the tell that the run ended without the agent saying
 * what it did, and the usual cause is a final turn that produced no text and no
 * *readable* tool call -- a tool call emitted inside the reasoning channel is
 * swallowed, so the loop sees "no more tool calls" and finishes as "completed".
 * The lead must not read that silence as success, and if the agent handed
 * changes back it must be told they are unvetted (pandorum 2026-09-24, agent
 * "fix-manic-miner").
 */
export function handbackNote(
	text: string,
	finishReason: string | undefined,
	agentName: string,
	handed: readonly HandedRevision[],
): string {
	const answered = text.trim().length > 0;
	const noAnswerNote =
		finishReason === "completed"
			? `\n\n---\nThis agent ended without an answer of its own: its final turn produced no text and no readable tool call. That usually means an action it attempted could not be read — for example a tool call emitted inside its reasoning — so it may not have finished. Do not treat its run as successful.`
			: `\n\n---\nThis agent ended early (${finishReason}) without an answer of its own, so it may not have finished. Do not treat its run as successful.`;
	if (handed.length === 0) {
		return answered
			? `\n\n---\nThis agent worked on a private copy of the workspace and left your files unchanged; it recorded no file changes to hand back.`
			: noAnswerNote;
	}
	const verb = (kind: string): string =>
		kind === "deleted"
			? "deleted"
			: kind === "created"
				? "created"
				: kind === "reverted"
					? "reverted"
					: "changed";
	const lines = handed
		.map(
			(h) =>
				`  - ${h.rel} — revision #${h.index} (${verb(h.kind)} by "${agentName}")`,
		)
		.join("\n");
	const first = handed[0]?.index ?? 1;
	if (!answered) {
		// Changes handed back by an agent that never said whether they work: make
		// the lead inspect them rather than adopt them on faith.
		return (
			noAnswerNote +
			`\n\nIt did leave changes on its private copy, held for you as revisions (NOT written to disk). Because it gave no summary, these are UNVETTED and may be an unfinished or non-working edit:\n${lines}\n` +
			`Inspect one before trusting it: \`read_files\` with \`revision: "#${first}"\`, then run your own check. To apply it: \`restore_file\` with the same \`revision\`. Do not verify by reading your current copy — it does not contain these changes yet.`
		);
	}
	return (
		`\n\n---\nThe agent worked on a private copy of the workspace, so your own files are UNCHANGED. Its changes are held for you as revisions, not written to disk:\n${lines}\n` +
		`To see a version: \`read_files\` with \`revision: "#${first}"\`. To apply it to your workspace: \`restore_file\` with the same \`revision\`. ` +
		`Do not verify the agent's work by reading or running your current copy of these files — it does not contain these changes yet.`
	);
}
