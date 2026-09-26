import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TeamRuntimeState, TeamTeammateSpec } from "@cline/shared";
import { resolveTeamDataDir } from "@cline/shared/storage";
import type { TeamEvent } from "../../extensions/tools/team";
import { reviveTeamStateDates } from "../../extensions/tools/team/team-state-dates";
import type { TeamStore } from "../../types/storage";

function nowIso(): string {
	return new Date().toISOString();
}

function sanitizeTeamName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

interface PersistedTeamEnvelope {
	version: 1;
	updatedAt: string;
	teamState: TeamRuntimeState;
	teammates: TeamTeammateSpec[];
}

export interface FileTeamStoreOptions {
	teamDir?: string;
}

export interface TeamRuntimeLoadResult {
	state?: TeamRuntimeState;
	teammates: TeamTeammateSpec[];
	interruptedRunIds: string[];
}

export class FileTeamStore implements TeamStore {
	private readonly teamDirPath: string;

	constructor(options: FileTeamStoreOptions = {}) {
		this.teamDirPath = options.teamDir ?? resolveTeamDataDir();
	}

	init(): void {
		this.ensureTeamDir();
	}

	listTeamNames(): string[] {
		if (!existsSync(this.teamDirPath)) {
			return [];
		}
		return readdirSync(this.teamDirPath, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.filter((entry) => existsSync(this.statePath(entry.name)))
			.map((entry) => entry.name)
			.sort();
	}

	readState(teamName: string): TeamRuntimeState | undefined {
		const envelope = this.readEnvelope(teamName);
		return envelope?.teamState
			? reviveTeamStateDates(envelope.teamState)
			: undefined;
	}

	readHistory(teamName: string, limit = 200): unknown[] {
		const historyPath = this.historyPath(teamName);
		if (!existsSync(historyPath)) {
			return [];
		}
		return readFileSync(historyPath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as unknown;
				} catch {
					return undefined;
				}
			})
			.filter((item): item is unknown => item !== undefined)
			.reverse()
			.slice(0, limit);
	}

	loadRuntime(teamName: string): TeamRuntimeLoadResult {
		const envelope = this.readEnvelope(teamName);
		return {
			state: envelope?.teamState
				? reviveTeamStateDates(envelope.teamState)
				: undefined,
			teammates: envelope?.teammates ?? [],
			interruptedRunIds: [],
		};
	}

	handleTeamEvent(teamName: string, event: TeamEvent): void {
		this.ensureTeamSubdir(teamName);
		appendFileSync(
			this.historyPath(teamName),
			`${JSON.stringify({ ts: nowIso(), eventType: event.type, payload: event })}\n`,
			"utf8",
		);
	}

	persistRuntime(
		teamName: string,
		state: TeamRuntimeState,
		teammates: TeamTeammateSpec[],
	): void {
		this.ensureTeamSubdir(teamName);
		const envelope: PersistedTeamEnvelope = {
			version: 1,
			updatedAt: nowIso(),
			teamState: state,
			teammates,
		};
		const path = this.statePath(teamName);
		const tempPath = `${path}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		renameSync(tempPath, path);
	}

	markInProgressRunsInterrupted(teamName: string, reason: string): string[] {
		const envelope = this.readEnvelope(teamName);
		if (!envelope?.teamState?.runs?.length) {
			return [];
		}
		const interrupted = envelope.teamState.runs
			.filter((run) => run.status === "queued" || run.status === "running")
			.map((run) => run.id);
		if (interrupted.length === 0) {
			return [];
		}
		const endedAt = new Date();
		envelope.teamState = {
			...envelope.teamState,
			runs: envelope.teamState.runs.map((run) =>
				run.status === "queued" || run.status === "running"
					? {
							...run,
							status: "interrupted",
							error: reason,
							endedAt,
						}
					: run,
			),
		};
		this.persistRuntime(teamName, envelope.teamState, envelope.teammates);
		return interrupted;
	}

	private ensureTeamDir(): string {
		if (!existsSync(this.teamDirPath)) {
			mkdirSync(this.teamDirPath, { recursive: true });
		}
		return this.teamDirPath;
	}

	private ensureTeamSubdir(teamName: string): string {
		const path = join(this.ensureTeamDir(), sanitizeTeamName(teamName));
		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
		return path;
	}

	private statePath(teamName: string): string {
		return join(this.ensureTeamDir(), sanitizeTeamName(teamName), "state.json");
	}

	private historyPath(teamName: string): string {
		return join(
			this.ensureTeamDir(),
			sanitizeTeamName(teamName),
			"task-history.jsonl",
		);
	}

	private readEnvelope(teamName: string): PersistedTeamEnvelope | undefined {
		const path = this.statePath(teamName);
		if (!existsSync(path)) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(
				readFileSync(path, "utf8"),
			) as PersistedTeamEnvelope;
			if (parsed?.version === 1 && parsed.teamState) {
				return parsed;
			}
		} catch {
			// Ignore invalid persistence and fall back to undefined.
		}
		return undefined;
	}
}
