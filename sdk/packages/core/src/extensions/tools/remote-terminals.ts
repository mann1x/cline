import { imageSize, screenshotSizeNote } from "./image-size";
import { openPortForward, type PortForward } from "./remote-port-forward";
/**
 * Remote terminals: Open Terminal machines, reached through Open WebUI.
 *
 * Open Terminal (open-webui/open-terminal) is a Linux container with a REST
 * API for commands and files. Cerebriline does not talk to it directly: Open
 * WebUI already proxies every registered machine at
 * `/api/v1/machines/<id>/<path>`, adds the terminal's own key, and keeps the
 * terminal off the network. Cerebriline signs in to Open WebUI with the user's
 * Open WebUI API key and names the machine by its connection id. No model runs
 * on that path: Open WebUI forwards the request, nothing more, and the session's
 * own model decides what runs.
 *
 * Each session gets a workspace of its own on each machine,
 * `~/cerebriline/<session id>`. Every command runs there with `HOME` pointed at
 * it, so pip, npm, git config and caches stay inside it, and two conversations
 * can share a machine without seeing each other's files. It is a separation,
 * not a boundary: through Open WebUI every conversation of one Open WebUI user
 * is the same Linux account (the proxy fixes `X-User-Id` to that user).
 *
 * Three tools, split by what they do so each answers to the auto-approve box
 * that already governs the same action locally: `remote_run` (commands),
 * `remote_read` (reads), `remote_write` (writes).
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
	type AgentTool,
	type AgentToolContext,
	createTool,
} from "@cline/shared";
import {
	DEFAULT_UPLOAD_EXCLUDES,
	MAX_TRANSFER_BYTES,
	packFolder,
	resolveLocalPath,
	unpackArchive,
	writeLocalFile,
} from "./remote-copy-local";

export interface RemoteTerminal {
	/** What the user and the model call it, e.g. `bench-app`. */
	name: string;
	/** The connection id in Open WebUI (Admin Settings → Integrations → Open Terminal). */
	machineId: string;
	/** What the machine is for; shown to the model. */
	description?: string;
}

export interface RemoteTerminalsConfig {
	/** Where Open WebUI is, e.g. `http://192.168.1.10:3000`. */
	openWebUiUrl?: string;
	/** The user's Open WebUI API key (`sk-…`). */
	apiKey?: string;
	terminals: RemoteTerminal[];
	/** Offer `remote_browser`: a Chrome tab on the terminal, read and driven by the model. */
	browser?: boolean;
	/** Offer `remote_desktop`: the account's Linux desktop on the terminal, seen and driven by the model. */
	desktop?: boolean;
}

export const REMOTE_TERMINAL_TOOL_NAMES = {
	RUN: "remote_run",
	READ: "remote_read",
	WRITE: "remote_write",
	COPY: "remote_copy",
	BROWSER: "remote_browser",
	DESKTOP: "remote_desktop",
} as const;

/** The environment variable that marks every process a `remote_run` command starts. */
export const RUN_MARKER_VARIABLE = "CEREBRILINE_RUN";

/**
 * A POSIX shell command that kills every process carrying `marker`, other
 * than itself: TERM first, then KILL for whatever is left after 2 s.
 */
export function stopCommand(marker: string): string {
	if (!/^[A-Za-z0-9]+$/.test(marker))
		throw new Error(`unexpected run marker: ${marker}`);
	return [
		`m='${RUN_MARKER_VARIABLE}=${marker}';`,
		"for s in TERM KILL; do",
		"found=;",
		'for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue;',
		`if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "$m"; then kill -$s "\${p#/proc/}" 2>/dev/null && found=1; fi;`,
		"done;",
		'[ -z "$found" ] && break; [ "$s" = TERM ] && sleep 2;',
		"done; echo stopped",
	].join(" ");
}

/** Where a session's workspace lives under the account's home. */
export const REMOTE_WORKSPACE_ROOT = "cerebriline";

/** One wait per request, well inside Open WebUI's 300 s proxy limit. */
const POLL_WAIT_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_CHARS = 20_000;
const OUTPUT_HEAD_CHARS = 4_000;

export interface RemoteWorkspaceRecord {
	terminal: string;
	machineId: string;
	workspaceId: string;
	path: string;
}

export interface CreateRemoteTerminalToolsOptions {
	/** Read at session start for the tool list, and again on every call. */
	getConfig: () => RemoteTerminalsConfig | undefined;
	fetchImpl?: typeof fetch;
	/** Called when a session first uses a machine, so the host can clean up later. */
	onWorkspace?: (record: RemoteWorkspaceRecord) => void;
	onError?: (message: string, error: unknown) => void;
	log?: (message: string) => void;
	/**
	 * The session's local workspace folder. With it, `remote_copy` is offered
	 * too, and copies only inside this folder; without it, it is not.
	 */
	getLocalRoot?: () => string | undefined;
	/**
	 * Asks Open WebUI again for the machines this user can reach, for a name
	 * the session's list does not know; returns the usable list.
	 */
	discover?: () => Promise<RemoteTerminal[]>;
	/**
	 * What the tools do on each machine, as it happens: for a host that shows
	 * it (VS Code mirrors it into a read-only terminal per machine).
	 */
	onActivity?: (event: RemoteActivity) => void;
}

/** One step of what the remote tools do on a machine. */
export type RemoteActivity =
	| {
			type: "command";
			terminal: string;
			sessionId: string;
			cwd: string;
			command: string;
	  }
	| { type: "output"; terminal: string; sessionId: string; data: string }
	| {
			type: "exit";
			terminal: string;
			sessionId: string;
			exitCode: number | null | undefined;
			seconds: number;
	  }
	| {
			type: "running";
			terminal: string;
			sessionId: string;
			processId: string;
			seconds: number;
	  }
	| { type: "note"; terminal: string; sessionId: string; text: string };

/** Why a configuration offers no remote tools, or `undefined` when it does. */
export function remoteTerminalsUnavailable(
	config: RemoteTerminalsConfig | undefined,
): string | undefined {
	if (!config) return "remote terminals are off";
	if (!config.openWebUiUrl?.trim()) return "no Open WebUI URL is set";
	if (!config.apiKey?.trim()) return "no Open WebUI API key is set";
	if (usableTerminals(config).length === 0) return "no terminal is configured";
	return undefined;
}

function usableTerminals(config: RemoteTerminalsConfig): RemoteTerminal[] {
	const seen = new Set<string>();
	return config.terminals.filter((terminal) => {
		const name = terminal.name.trim();
		const key = name.toLowerCase();
		if (!name || !terminal.machineId.trim() || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function squash(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The terminal a name means: its name, then its machine ID (ignoring case),
 * then the only one whose name or ID contains it ignoring case and
 * punctuation, so "open-terminal" finds `solidpc-open-terminal`.
 */
export function matchRemoteTerminal(
	terminals: readonly RemoteTerminal[],
	name: unknown,
): RemoteTerminal | undefined {
	const wanted = typeof name === "string" ? name.trim().toLowerCase() : "";
	if (!wanted) return undefined;
	const exact =
		terminals.find((entry) => entry.name.trim().toLowerCase() === wanted) ??
		terminals.find((entry) => entry.machineId.trim().toLowerCase() === wanted);
	if (exact) return exact;
	const part = squash(wanted);
	if (!part) return undefined;
	const partial = terminals.filter(
		(entry) =>
			squash(entry.name).includes(part) ||
			squash(entry.machineId).includes(part),
	);
	return partial.length === 1 ? partial[0] : undefined;
}

/**
 * The machines this Open WebUI user may use (`GET /api/v1/machines/`), as
 * terminals named by their Open WebUI name. Machine templates (a terminal
 * orchestrator's) are left out: they need a template chosen per chat.
 */
export async function listRemoteMachines(
	config: Pick<RemoteTerminalsConfig, "openWebUiUrl" | "apiKey">,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<RemoteTerminal[]> {
	const root = (config.openWebUiUrl ?? "").trim().replace(/\/+$/, "");
	if (!root || !config.apiKey?.trim()) return [];
	const response = await fetchImpl(`${root}/api/v1/machines/`, {
		headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
		signal,
	});
	if (!response.ok) {
		throw new RemoteTerminalError(
			response.status === 401
				? "Open WebUI refused the API key (401): wrong or revoked key, or API keys are disabled (Admin Settings → General)."
				: `Open WebUI answered HTTP ${response.status} listing machines.`,
		);
	}
	const body = (await response.json()) as unknown;
	if (!Array.isArray(body)) return [];
	return body.flatMap((entry) => {
		const item = entry as {
			id?: unknown;
			name?: unknown;
			template_id?: unknown;
		};
		const machineId = typeof item.id === "string" ? item.id.trim() : "";
		if (!machineId || item.template_id) return [];
		const name =
			typeof item.name === "string" && item.name.trim()
				? item.name.trim()
				: machineId;
		return [{ name, machineId }];
	});
}

/** A session id as a folder name: kept readable, stripped to what is safe in a path. */
export function remoteWorkspaceId(
	context: Pick<AgentToolContext, "sessionId" | "conversationId" | "agentId">,
): string {
	const raw =
		context.sessionId || context.conversationId || context.agentId || "session";
	const cleaned = raw
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/^[.]+/, "_")
		.slice(0, 80);
	return cleaned || "session";
}

/** Long output keeps its start and its end; the middle is what a model needs least. */
export function trimRemoteOutput(text: string, max = MAX_OUTPUT_CHARS): string {
	if (text.length <= max) return text;
	const head = text.slice(0, OUTPUT_HEAD_CHARS);
	const tail = text.slice(text.length - (max - OUTPUT_HEAD_CHARS));
	const dropped = text.length - head.length - tail.length;
	return `${head}\n\n[... ${dropped} characters left out ...]\n\n${tail}`;
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ExecResponse {
	id: string;
	status: string;
	exit_code?: number | null;
	next_offset?: number;
	output?: Array<{ type?: string; data?: string }>;
	truncated?: boolean;
}

class RemoteTerminalError extends Error {}

/** What a remote tool returns: text, or text and an image the model can see. */
type RemoteToolOutput =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mediaType: string }
	  >;

/** Images up to this size go to the model as they are. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A one-line summary of `/system/info`. */
export function summarizeSystemInfo(info: unknown): string {
	const data = (info ?? {}) as {
		os?: string;
		arch?: string;
		environment?: string;
		cpu?: { cores?: number };
		memory?: { total?: number; used?: number };
		disk?: { free?: number; total?: number };
	};
	const gb = (bytes?: number) =>
		typeof bytes === "number" ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "?";
	const parts = [
		typeof data.cpu?.cores === "number" ? `${data.cpu.cores} cores` : undefined,
		data.memory?.total
			? `${gb(data.memory.total)} memory (${gb(data.memory.used)} used)`
			: undefined,
		data.disk?.free !== undefined
			? `${gb(data.disk.free)} disk free of ${gb(data.disk.total)}`
			: undefined,
		[data.os, data.arch].filter(Boolean).join(" ") || undefined,
		data.environment,
	].filter(Boolean);
	return parts.join(", ");
}

/**
 * Open Terminal's port proxy puts a script of its own into every HTML page,
 * for its in-browser preview (it rewrites links and reports navigation).
 * It is not the page, so it is taken out before the model reads it.
 */
export function withoutProxyScript(html: string): string {
	return html.replace(
		/<script>(?:(?!<\/script>)[\s\S])*terminal-browser-state(?:(?!<\/script>)[\s\S])*<\/script>/,
		"",
	);
}

/** Process ids become file names in the run records: only these characters. */
function safeProcessId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

/** One machine, through Open WebUI's proxy. */
class OpenTerminalClient {
	constructor(
		private readonly config: RemoteTerminalsConfig,
		private readonly terminal: RemoteTerminal,
		private readonly fetchImpl: typeof fetch,
	) {}

	private get base(): string {
		const root = (this.config.openWebUiUrl ?? "").trim().replace(/\/+$/, "");
		return `${root}/api/v1/machines/${encodeURIComponent(this.terminal.machineId.trim())}`;
	}

	/** One request through the proxy; a non-2xx answer becomes a readable error. */
	private async send(
		method: "GET" | "POST" | "DELETE" | "PATCH",
		path: string,
		options: {
			query?: Record<string, string | number | boolean | undefined>;
			body?: RequestInit["body"];
			contentType?: string;
			signal?: AbortSignal;
			/** Hand back any HTTP status instead of turning a non-2xx into an error. */
			anyStatus?: boolean;
		},
	): Promise<Response> {
		const url = new URL(`${this.base}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${(this.config.apiKey ?? "").trim()}`,
		};
		if (options.contentType) headers["Content-Type"] = options.contentType;
		// No X-Session-Id: Open WebUI reads it as one of its own chat ids and
		// refuses any other ("Chat access denied"). The workspace travels as
		// `cwd` and `HOME` on every call instead.
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				body: options.body,
				signal: options.signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new RemoteTerminalError(
				`Open WebUI at ${this.config.openWebUiUrl} did not answer: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok && !options.anyStatus) {
			throw new RemoteTerminalError(
				this.describeFailure(response.status, await response.text()),
			);
		}
		return response;
	}

	/** A JSON POST whose answer may be bytes (a screenshot). */
	async postRaw(
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
		const response = await this.send("POST", path, {
			body: JSON.stringify(body),
			contentType: "application/json",
			signal,
		});
		return {
			status: response.status,
			contentType: response.headers.get("content-type") ?? "",
			bytes: new Uint8Array(await response.arrayBuffer()),
		};
	}

	/** A GET whose answer may be JSON or bytes (an image, a web page). */
	async getRaw(
		path: string,
		query: Record<string, string | number | boolean | undefined>,
		signal?: AbortSignal,
		anyStatus = false,
	): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
		const response = await this.send("GET", path, { query, signal, anyStatus });
		return {
			status: response.status,
			contentType: response.headers.get("content-type") ?? "",
			bytes: new Uint8Array(await response.arrayBuffer()),
		};
	}

	async request<T>(
		method: "GET" | "POST" | "DELETE" | "PATCH",
		path: string,
		options: {
			query?: Record<string, string | number | boolean | undefined>;
			body?: unknown;
			signal?: AbortSignal;
		} = {},
	): Promise<T> {
		const response = await this.send(method, path, {
			query: options.query,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			contentType: options.body === undefined ? undefined : "application/json",
			signal: options.signal,
		});
		const text = await response.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new RemoteTerminalError(
				`"${this.terminal.name}" answered with something that is not JSON (HTTP ${response.status}).`,
			);
		}
	}

	/** Streams `data` into `directory` as `filename` (Open Terminal's multipart upload). */
	async upload(
		directory: string,
		filename: string,
		data: Uint8Array,
		signal?: AbortSignal,
	): Promise<{ path: string; size: number }> {
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(data)]), filename);
		const response = await this.send("POST", "/files/upload", {
			query: { directory },
			body: form,
			signal,
		});
		return (await response.json()) as { path: string; size: number };
	}

	/** A file's bytes, as stored (Open Terminal's raw view). */
	async download(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const response = await this.send("GET", "/files/view", {
			query: { path },
			signal,
		});
		return new Uint8Array(await response.arrayBuffer());
	}

	private describeFailure(status: number, body: string): string {
		// A browser or desktop batch that stopped part-way answers with what ran.
		try {
			const parsed = JSON.parse(body) as {
				detail?: {
					completed_actions?: number;
					failed_action_index?: number | null;
					error?: string;
				};
			};
			const batch = parsed.detail;
			if (
				batch &&
				typeof batch === "object" &&
				typeof batch.completed_actions === "number"
			) {
				const failed =
					typeof batch.failed_action_index === "number"
						? `step ${batch.failed_action_index + 1} failed`
						: "the steps ran but the final view could not be taken";
				return `On "${this.terminal.name}" ${failed}: ${batch.error?.trim() || "it timed out"}. ${batch.completed_actions} step(s) before it took effect and are not undone. Look again (snapshot or screenshot) before retrying.`;
			}
		} catch {}
		const detail = body.slice(0, 300).trim();
		const name = `"${this.terminal.name}"`;
		switch (status) {
			case 401:
				return `Open WebUI refused the API key (401). The key is wrong or revoked, or API keys are disabled in Open WebUI (Admin Settings → General). Fix it in Cerebriline's Remote terminals settings.`;
			case 403:
				return /tool servers are disabled/i.test(detail)
					? "Open WebUI has tool servers turned off (403); an admin has to turn them back on."
					: `Open WebUI refused the request to ${name} (403): ${detail}`;
			case 404:
				return /machine .* not found/i.test(detail)
					? `Open WebUI has no machine "${this.terminal.machineId}" for this user (404). Check the machine ID in the Remote terminals settings against Admin Settings → Integrations → Open Terminal.`
					: `Not found on ${name} (404): ${detail}`;
			case 502:
			case 503:
			case 504:
				return `Open WebUI could not reach ${name} (${status}). The container may be stopped. ${detail}`;
			default:
				return `${name} answered HTTP ${status}: ${detail}`;
		}
	}
}

function outputText(response: ExecResponse): string {
	return (response.output ?? [])
		.map((chunk) => chunk.data ?? "")
		.join("")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

export function createRemoteTerminalTools(
	options: CreateRemoteTerminalToolsOptions,
): AgentTool[] {
	const initial = options.getConfig();
	const unavailable = remoteTerminalsUnavailable(initial);
	if (unavailable || !initial) {
		options.log?.(`remote terminals omitted: ${unavailable}`);
		return [];
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const names = usableTerminals(initial).map((terminal) =>
		terminal.name.trim(),
	);
	options.log?.(`remote terminals offered: ${names.join(", ")}`);

	// One workspace per machine and session, created on first use.
	const workspaces = new Map<string, Promise<string>>();
	// The marker each started command carries, by Open Terminal's process id.
	const runMarkers = new Map<string, string>();
	// How far each still-running command's output has been read, so waiting
	// for it again continues instead of repeating what was already returned.
	const readOffsets = new Map<string, number>();
	// Local forwards of remote ports, one per machine and port.
	const forwards = new Map<string, Promise<PortForward>>();
	// The browser tab each conversation is working in, per machine.
	const browserTabs = new Map<string, string>();
	// The machine summary, said once per machine and session on first use.
	const machineNotes = new Map<string, string>();

	/** Where a session keeps its run records on the machine. */
	const runsFolder = (workspace: string) => `${workspace}/.cerebriline/runs`;

	/**
	 * A long-running command's marker, kept in the session's folder on the
	 * machine as well as here: after a reload this process has forgotten it,
	 * and without it the command cannot be stopped under multi-user sudo.
	 * The same records tell `processes` which commands are this session's.
	 */
	const rememberRun = async (
		client: OpenTerminalClient,
		workspace: string,
		processId: string,
		marker: string,
	) => {
		if (!safeProcessId(processId)) return;
		await client
			.request("POST", "/files/write", {
				body: {
					path: `${runsFolder(workspace)}/${processId}`,
					content: marker,
				},
			})
			.catch((error) =>
				options.onError?.(`Could not record process ${processId}`, error),
			);
	};
	const recallMarker = async (
		client: OpenTerminalClient,
		workspace: string,
		processId: string,
	) => {
		if (!safeProcessId(processId)) return undefined;
		try {
			const file = await client.request<{ content?: string }>(
				"GET",
				"/files/read",
				{
					query: { path: `${runsFolder(workspace)}/${processId}` },
				},
			);
			const marker = file.content?.trim();
			return marker && /^[A-Za-z0-9]+$/.test(marker) ? marker : undefined;
		} catch {
			return undefined;
		}
	};

	const emit = (event: RemoteActivity) => {
		try {
			options.onActivity?.(event);
		} catch {
			// A display must never break the tool.
		}
	};
	const note = (
		terminal: RemoteTerminal,
		context: AgentToolContext,
		text: string,
	) =>
		emit({
			type: "note",
			terminal: terminal.name.trim(),
			sessionId: remoteWorkspaceId(context),
			text,
		});
	const shown = (
		terminal: RemoteTerminal,
		context: AgentToolContext,
		data: string,
	) => {
		if (data)
			emit({
				type: "output",
				terminal: terminal.name.trim(),
				sessionId: remoteWorkspaceId(context),
				data,
			});
	};

	/**
	 * Stops a command and everything it started. Not `DELETE /execute/<id>`:
	 * in multi-user mode the command runs under a root `sudo`, and the server,
	 * not being root, is refused when it signals that process group, so the
	 * command runs on. Every command started here carries its own marker in
	 * its environment, inherited by all its children; this kills, as the
	 * account itself, each process that has it (TERM, then KILL after 2 s).
	 */
	const stopRun = async (
		client: OpenTerminalClient,
		processId: string,
		knownMarker?: string,
		workspace?: string,
	): Promise<void> => {
		const marker =
			knownMarker ??
			runMarkers.get(processId) ??
			(workspace
				? await recallMarker(client, workspace, processId)
				: undefined);
		if (!marker) {
			// Started before this session's tools existed: all that is left is
			// Open Terminal's own stop, which may be refused.
			await client.request(
				"DELETE",
				`/execute/${encodeURIComponent(processId)}`,
				{
					query: { force: true },
				},
			);
			return;
		}
		const done = await client.request<ExecResponse>("POST", "/execute", {
			query: { wait: POLL_WAIT_SECONDS },
			body: { command: stopCommand(marker) },
		});
		if (done.exit_code !== 0) {
			throw new RemoteTerminalError(
				`Could not stop process ${processId}: ${outputText(done).trim() || `exit ${done.exit_code}`}`,
			);
		}
		runMarkers.delete(processId);
	};

	const resolve = async (name: unknown) => {
		const config = options.getConfig();
		const why = remoteTerminalsUnavailable(config);
		if (why || !config)
			throw new RemoteTerminalError(
				`Remote terminals are not available: ${why}.`,
			);
		let terminal = matchRemoteTerminal(usableTerminals(config), name);
		let known = usableTerminals(config);
		if (!terminal && options.discover) {
			// A machine added in Open WebUI since the session started.
			known = await options.discover().catch(() => known);
			terminal = matchRemoteTerminal(known, name);
		}
		if (!terminal) {
			throw new RemoteTerminalError(
				`There is no remote terminal called "${String(name ?? "")}". Available: ${known.map((entry) => `${entry.name.trim()} (${entry.machineId.trim()})`).join(", ")}.`,
			);
		}
		return {
			terminal,
			client: new OpenTerminalClient(config, terminal, fetchImpl),
		};
	};

	const workspaceFor = (
		terminal: RemoteTerminal,
		client: OpenTerminalClient,
		context: AgentToolContext,
	): Promise<string> => {
		const workspaceId = remoteWorkspaceId(context);
		const key = `${terminal.machineId.trim()}\u0000${terminal.name.trim().toLowerCase()}\u0000${workspaceId}`;
		let pending = workspaces.get(key);
		if (!pending) {
			pending = (async () => {
				const relative = `${REMOTE_WORKSPACE_ROOT}/${workspaceId}`;
				const created = await client.request<ExecResponse>("POST", "/execute", {
					query: { wait: POLL_WAIT_SECONDS },
					body: {
						command: `mkdir -p "$HOME"/${quoteShell(relative)} && cd "$HOME"/${quoteShell(relative)} && pwd`,
					},
					signal: context.signal,
				});
				const path = outputText(created).trim().split("\n").pop()?.trim() ?? "";
				if (created.exit_code !== 0 || !path.startsWith("/")) {
					throw new RemoteTerminalError(
						`Could not create the workspace on "${terminal.name}": ${outputText(created).trim() || `exit ${created.exit_code}`}`,
					);
				}
				options.onWorkspace?.({
					terminal: terminal.name.trim(),
					machineId: terminal.machineId.trim(),
					workspaceId,
					path,
				});
				try {
					const info = await client.request<unknown>("GET", "/system/info", {
						signal: context.signal,
					});
					const summary = summarizeSystemInfo(info);
					if (summary)
						machineNotes.set(key, `(${terminal.name.trim()}: ${summary})`);
				} catch {
					// Older Open Terminal, or the system feature is off: no summary.
				}
				return path;
			})();
			workspaces.set(key, pending);
			// A failure is not remembered: the next call tries again.
			pending.catch(() => workspaces.delete(key));
		}
		return pending;
	};

	const sessionKey = (terminal: RemoteTerminal, context: AgentToolContext) =>
		`${terminal.machineId.trim()}\u0000${terminal.name.trim().toLowerCase()}\u0000${remoteWorkspaceId(context)}`;
	/** The machine summary for this session's first call on it, then nothing. */
	const firstUseNote = (
		terminal: RemoteTerminal,
		context: AgentToolContext,
	): string => {
		const key = sessionKey(terminal, context);
		const text = machineNotes.get(key);
		if (!text) return "";
		machineNotes.delete(key);
		return `\n${text}`;
	};
	const withNote = (
		output: RemoteToolOutput,
		terminal: RemoteTerminal,
		context: AgentToolContext,
	): RemoteToolOutput => {
		const extra = firstUseNote(terminal, context);
		if (!extra) return output;
		if (typeof output === "string") return output + extra;
		return output.map((part, index) =>
			index === 0 && part.type === "text"
				? { ...part, text: part.text + extra }
				: part,
		);
	};

	const inside = (workspace: string, path: unknown): string => {
		const given = typeof path === "string" && path.trim() ? path.trim() : ".";
		if (given.startsWith("/")) return given;
		if (given === ".") return workspace;
		return `${workspace}/${given.replace(/^\.\//, "")}`;
	};

	const terminalList = usableTerminals(initial)
		.map(
			(terminal) =>
				`- ${terminal.name.trim()}${terminal.machineId.trim() !== terminal.name.trim() ? ` (machine ${terminal.machineId.trim()})` : ""}${terminal.description?.trim() ? `: ${terminal.description.trim()}` : ""}`,
		)
		.join("\n");
	const terminalProperty = {
		type: "string",
		description:
			"Which remote terminal: its name from the list (its machine ID works too).",
	};
	const workspaceNote = `Each conversation has its own workspace folder on each terminal (~/${REMOTE_WORKSPACE_ROOT}/<session>); relative paths start there, and HOME points at it. The terminals are Linux containers, separate from the user's machine: nothing here touches local files.`;

	const run = createTool<
		{
			terminal: string;
			command?: string;
			cwd?: string;
			timeout_seconds?: number;
			process_id?: string;
			kill?: boolean;
			input?: string;
		},
		RemoteToolOutput
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.RUN,
		description: [
			"Run a shell command on a remote terminal and return its output and exit code.",
			"Remote terminals:",
			terminalList,
			workspaceNote,
			"A `cd` does not carry over to the next call: pass `cwd` instead. A command still running when `timeout_seconds` is reached keeps running; call again with its `process_id` to wait for it, with `process_id` and `input` to type into it (answer a prompt; end lines with \\n), or with `process_id` and `kill: true` to stop it. `remote_read` with action `processes` lists this conversation's commands. To start a server or GUI program and return at once, use `setsid -f <command> >log 2>&1 </dev/null`: a plain `nohup ... &` keeps this call waiting until timeout_seconds.",
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				command: {
					type: "string",
					description: "The shell command. Pipes, && and redirections work.",
				},
				cwd: {
					type: "string",
					description:
						"Working directory, relative to the workspace or absolute. Default: the workspace.",
				},
				timeout_seconds: {
					type: "number",
					description: `How long to wait for it, in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}).`,
				},
				process_id: {
					type: "string",
					description:
						"A command that is still running, from an earlier call: wait for it instead of starting one.",
				},
				kill: {
					type: "boolean",
					description: "With process_id: stop that command.",
				},
				input: {
					type: "string",
					description:
						'With process_id: text to send to the command\'s standard input, e.g. "y\\n". Then waits for more output as usual.',
				},
			},
			required: ["terminal"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			const workspace = await workspaceFor(terminal, client, context);
			const timeout = Math.min(
				Math.max(Number(input.timeout_seconds) || DEFAULT_TIMEOUT_SECONDS, 1),
				MAX_TIMEOUT_SECONDS,
			);
			const started = Date.now();
			let response: ExecResponse;
			let collected = "";
			if (input.process_id?.trim()) {
				const id = input.process_id.trim();
				if (input.kill) {
					await stopRun(client, id, undefined, workspace);
					readOffsets.delete(id);
					note(terminal, context, `stopped process ${id}`);
					return `[${terminal.name}] stopped process ${id}.`;
				}
				if (typeof input.input === "string" && input.input !== "") {
					await client.request(
						"POST",
						`/execute/${encodeURIComponent(id)}/input`,
						{
							body: { input: input.input },
							signal: context.signal,
						},
					);
					note(
						terminal,
						context,
						`typed into process ${id}: ${JSON.stringify(input.input)}`,
					);
				} else {
					note(terminal, context, `waiting again for process ${id}`);
				}
				response = await client.request<ExecResponse>(
					"GET",
					`/execute/${encodeURIComponent(id)}/status`,
					{
						query: {
							wait: Math.min(POLL_WAIT_SECONDS, timeout),
							offset: readOffsets.get(id) ?? 0,
						},
						signal: context.signal,
					},
				);
			} else {
				if (!input.command?.trim()) {
					throw new RemoteTerminalError(
						"Give a `command` to run, or a `process_id` to wait for.",
					);
				}
				const marker = randomUUID().replace(/-/g, "");
				emit({
					type: "command",
					terminal: terminal.name.trim(),
					sessionId: remoteWorkspaceId(context),
					cwd: inside(workspace, input.cwd),
					command: input.command,
				});
				try {
					response = await client.request<ExecResponse>("POST", "/execute", {
						query: { wait: Math.min(POLL_WAIT_SECONDS, timeout) },
						body: {
							command: input.command,
							cwd: inside(workspace, input.cwd),
							env: { HOME: workspace, [RUN_MARKER_VARIABLE]: marker },
						},
						signal: context.signal,
					});
				} catch (error) {
					// Stopped while the start request was still waiting: the command
					// may be running, and its process id never arrived. The marker is
					// enough to find it.
					if (context.signal?.aborted) {
						await stopRun(client, "(starting)", marker).catch((stopError) =>
							options.onError?.(
								`Could not stop a command on "${terminal.name}"`,
								stopError,
							),
						);
					}
					throw error;
				}
				if (response.status === "running") {
					runMarkers.set(response.id, marker);
					await rememberRun(client, workspace, response.id, marker);
				}
			}
			collected += outputText(response);
			shown(terminal, context, outputText(response));
			try {
				while (
					response.status === "running" &&
					Date.now() - started < timeout * 1000
				) {
					const left = timeout - (Date.now() - started) / 1000;
					response = await client.request<ExecResponse>(
						"GET",
						`/execute/${encodeURIComponent(response.id)}/status`,
						{
							query: {
								wait: Math.max(1, Math.min(POLL_WAIT_SECONDS, Math.ceil(left))),
								offset: response.next_offset ?? 0,
							},
							signal: context.signal,
						},
					);
					collected += outputText(response);
					shown(terminal, context, outputText(response));
				}
			} catch (error) {
				if (context.signal?.aborted && response.status === "running") {
					// The user stopped the run: stop the command too, not just the wait.
					await stopRun(client, response.id, undefined, workspace).catch(
						(stopError) =>
							options.onError?.(
								`Could not stop process ${response.id} on "${terminal.name}"`,
								stopError,
							),
					);
				}
				throw error;
			}
			if (response.status !== "running") {
				runMarkers.delete(response.id);
				readOffsets.delete(response.id);
			} else {
				readOffsets.set(response.id, response.next_offset ?? 0);
			}
			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			const output = trimRemoteOutput(collected.trimEnd());
			emit(
				response.status === "running"
					? {
							type: "running",
							terminal: terminal.name.trim(),
							sessionId: remoteWorkspaceId(context),
							processId: response.id,
							seconds: Number(seconds),
						}
					: {
							type: "exit",
							terminal: terminal.name.trim(),
							sessionId: remoteWorkspaceId(context),
							exitCode: response.exit_code,
							seconds: Number(seconds),
						},
			);
			if (response.status === "running") {
				return withNote(
					`[${terminal.name}] still running after ${seconds} s as process ${response.id}. Call ${REMOTE_TERMINAL_TOOL_NAMES.RUN} with process_id "${response.id}" to keep waiting, with input to type into it, or with kill: true to stop it.\n${output}`,
					terminal,
					context,
				);
			}
			return withNote(
				`[${terminal.name}] exit ${response.exit_code ?? "?"} after ${seconds} s\n${output || "(no output)"}`,
				terminal,
				context,
			);
		},
	});

	const read = createTool<
		{
			terminal: string;
			action:
				| "read"
				| "list"
				| "grep"
				| "glob"
				| "processes"
				| "info"
				| "ports"
				| "fetch"
				| "forward";
			path?: string;
			start_line?: number;
			end_line?: number;
			query?: string;
			pattern?: string;
			max_results?: number;
			port?: number;
		},
		RemoteToolOutput
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.READ,
		readOnly: true,
		description: [
			"Look at a remote terminal without changing it: read a file (a line range of text, or an image, which you see), list a directory, search file contents (grep), find files by name (glob), list this conversation's commands and whether they still run (processes), the machine's cores, memory and disk (info), the ports programs listen on (ports), GET a page from one of them (fetch: `port` and `path`), or open one of those ports on the user's machine so the local `browser` tool can load it (forward: `port`; answers with a http://127.0.0.1:… address, plain HTTP only).",
			"Remote terminals:",
			terminalList,
			workspaceNote,
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				action: {
					type: "string",
					enum: [
						"read",
						"list",
						"grep",
						"glob",
						"processes",
						"info",
						"ports",
						"fetch",
						"forward",
					],
				},
				port: {
					type: "number",
					description:
						"fetch and forward: the port a program on the terminal listens on.",
				},
				path: {
					type: "string",
					description:
						"File or directory, relative to the workspace or absolute. Default: the workspace. fetch: the URL path, e.g. /api/health.",
				},
				start_line: {
					type: "number",
					description: "read: first line (1-based).",
				},
				end_line: { type: "number", description: "read: last line." },
				query: {
					type: "string",
					description: "grep: the regular expression to search for.",
				},
				pattern: {
					type: "string",
					description: "glob: the file name pattern, e.g. **/*.py.",
				},
				max_results: {
					type: "number",
					description: "grep and glob: at most this many results (default 50).",
				},
			},
			required: ["terminal", "action"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			const workspace = await workspaceFor(terminal, client, context);
			const path = inside(workspace, input.path);
			const common = { signal: context.signal };
			switch (input.action) {
				case "read": {
					const raw = await client.getRaw(
						"/files/read",
						{ path, start_line: input.start_line, end_line: input.end_line },
						context.signal,
					);
					if (raw.contentType.startsWith("image/")) {
						const kind = raw.contentType.split(";")[0].trim();
						const label = `[${terminal.name}] ${path}: ${kind} image, ${(raw.bytes.length / 1024).toFixed(1)} KB`;
						if (context.metadata?.modelSupportsImages !== true) {
							return withNote(
								`${label}. This model cannot see images; copy it with remote_copy to look at it locally.`,
								terminal,
								context,
							);
						}
						if (raw.bytes.length > MAX_IMAGE_BYTES) {
							return withNote(
								`${label}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB, not shown. Scale it down on the terminal first.`,
								terminal,
								context,
							);
						}
						return withNote(
							[
								{ type: "text", text: label },
								{
									type: "image",
									data: Buffer.from(raw.bytes).toString("base64"),
									mediaType: kind,
								},
							],
							terminal,
							context,
						);
					}
					let file: { path: string; content: string; total_lines?: number };
					try {
						file = JSON.parse(new TextDecoder().decode(raw.bytes));
					} catch {
						return withNote(
							`[${terminal.name}] ${path} is a ${raw.contentType || "binary"} file that cannot be shown as text; copy it with remote_copy.`,
							terminal,
							context,
						);
					}
					const range =
						input.start_line || input.end_line
							? ` lines ${input.start_line ?? 1}-${input.end_line ?? file.total_lines ?? "end"}`
							: "";
					return withNote(
						`[${terminal.name}] ${file.path}${range} (${file.total_lines ?? "?"} lines)\n${trimRemoteOutput(file.content)}`,
						terminal,
						context,
					);
				}
				case "processes": {
					const records = await client
						.request<{ entries: Array<{ name: string; type: string }> }>(
							"GET",
							"/files/list",
							{
								...common,
								query: { directory: runsFolder(workspace) },
							},
						)
						.catch(() => ({
							entries: [] as Array<{ name: string; type: string }>,
						}));
					const mine = records.entries
						.filter((entry) => entry.type !== "directory")
						.map((entry) => entry.name);
					if (mine.length === 0) {
						return withNote(
							`[${terminal.name}] no long-running commands from this conversation.`,
							terminal,
							context,
						);
					}
					const tracked = await client.request<
						Array<{
							id: string;
							command: string;
							status: string;
							exit_code?: number | null;
						}>
					>("GET", "/execute", common);
					const byId = new Map(tracked.map((entry) => [entry.id, entry]));
					const lines = mine.map((id) => {
						const entry = byId.get(id);
						if (!entry) return `${id}  finished (no longer tracked)`;
						const state =
							entry.status === "running"
								? "running"
								: `${entry.status}${entry.exit_code !== undefined && entry.exit_code !== null ? `, exit ${entry.exit_code}` : ""}`;
						return `${id}  ${state}  ${entry.command.length > 120 ? `${entry.command.slice(0, 117)}...` : entry.command}`;
					});
					return withNote(
						`[${terminal.name}] this conversation's long-running commands:\n${lines.join("\n")}`,
						terminal,
						context,
					);
				}
				case "info": {
					const info = await client.request<unknown>(
						"GET",
						"/system/info",
						common,
					);
					machineNotes.delete(sessionKey(terminal, context));
					return `[${terminal.name}] ${summarizeSystemInfo(info) || "no system information"}`;
				}
				case "ports": {
					const listed = await client.request<{
						ports?: Array<Record<string, unknown>>;
					}>("GET", "/ports", common);
					const ports = listed.ports ?? [];
					const lines = ports.map((entry) =>
						Object.entries(entry)
							.map(
								([key, value]) =>
									`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
							)
							.join("  "),
					);
					return withNote(
						`[${terminal.name}] ${ports.length} listening port${ports.length === 1 ? "" : "s"}${lines.length ? `\n${lines.join("\n")}` : ""}`,
						terminal,
						context,
					);
				}
				case "forward": {
					const port = Number(input.port);
					if (!Number.isInteger(port) || port < 1 || port > 65535) {
						throw new RemoteTerminalError("forward needs a `port` (1-65535).");
					}
					const listed = await client.request<{
						ports?: Array<{ port?: number }>;
					}>("GET", "/ports", common);
					if (!(listed.ports ?? []).some((entry) => entry.port === port)) {
						throw new RemoteTerminalError(
							`Nothing of this account listens on port ${port} on "${terminal.name}"; see action ports. Start the server first.`,
						);
					}
					const key = `${terminal.machineId.trim()}:${port}`;
					let pending = forwards.get(key);
					if (!pending) {
						pending = openPortForward(
							{
								machineId: terminal.machineId.trim(),
								port,
								getConnection: () => {
									const current = options.getConfig() ?? initial;
									return {
										openWebUiUrl: current.openWebUiUrl,
										apiKey: current.apiKey,
									};
								},
							},
							fetchImpl,
						);
						forwards.set(key, pending);
						pending.catch(() => forwards.delete(key));
					}
					const forward = await pending;
					return withNote(
						`[${terminal.name}] port ${port} is open on the user's machine at ${forward.url} (through Open WebUI). Load it with the \`browser\` tool. Plain HTTP only: WebSockets do not pass. It closes after an hour without requests.`,
						terminal,
						context,
					);
				}
				case "fetch": {
					const port = Number(input.port);
					if (!Number.isInteger(port) || port < 1 || port > 65535) {
						throw new RemoteTerminalError("fetch needs a `port` (1-65535).");
					}
					const target = (
						typeof input.path === "string" ? input.path.trim() : ""
					).replace(/^\/+/, "");
					const [route, search] = target.split("?", 2);
					const query = Object.fromEntries(new URLSearchParams(search ?? ""));
					const raw = await client.getRaw(
						`/proxy/${port}/${route.split("/").map(encodeURIComponent).join("/")}`,
						query,
						context.signal,
						true,
					);
					const kind = raw.contentType.split(";")[0].trim();
					const head = `[${terminal.name}] GET :${port}/${target} -> HTTP ${raw.status}${kind ? ` (${kind})` : ""}`;
					if (
						raw.status === 404 &&
						/Port not found/.test(new TextDecoder().decode(raw.bytes))
					) {
						throw new RemoteTerminalError(
							`Nothing of this account listens on port ${port} on "${terminal.name}"; see action ports.`,
						);
					}
					if (
						kind.startsWith("image/") &&
						context.metadata?.modelSupportsImages === true &&
						raw.bytes.length <= MAX_IMAGE_BYTES
					) {
						return [
							{ type: "text", text: head },
							{
								type: "image",
								data: Buffer.from(raw.bytes).toString("base64"),
								mediaType: kind,
							},
						];
					}
					const textual =
						!kind || /^text\/|json|xml|javascript|html/.test(kind);
					return withNote(
						textual
							? `${head}\n${trimRemoteOutput(withoutProxyScript(new TextDecoder().decode(raw.bytes)))}`
							: `${head}, ${raw.bytes.length} bytes of ${kind}`,
						terminal,
						context,
					);
				}
				case "list": {
					const listing = await client.request<{
						dir: string;
						entries: Array<{ name: string; type: string; size?: number }>;
					}>("GET", "/files/list", { ...common, query: { directory: path } });
					const lines = listing.entries.map((entry) =>
						entry.type === "directory"
							? `${entry.name}/`
							: `${entry.name}${entry.size !== undefined ? ` (${entry.size} B)` : ""}`,
					);
					return `[${terminal.name}] ${listing.dir}\n${lines.join("\n") || "(empty)"}`;
				}
				case "grep": {
					if (!input.query)
						throw new RemoteTerminalError("grep needs a `query`.");
					const found = await client.request<{
						matches: Array<{ file: string; line: number; content: string }>;
						truncated?: boolean;
					}>("GET", "/files/grep", {
						...common,
						query: {
							query: input.query,
							path,
							max_results: input.max_results ?? 50,
						},
					});
					const lines = found.matches.map(
						(match) => `${match.file}:${match.line}: ${match.content}`,
					);
					return `[${terminal.name}] ${lines.length} match${lines.length === 1 ? "" : "es"}${found.truncated ? " (more not shown)" : ""}\n${trimRemoteOutput(lines.join("\n"))}`;
				}
				case "glob": {
					if (!input.pattern)
						throw new RemoteTerminalError("glob needs a `pattern`.");
					const found = await client.request<{
						path: string;
						matches: Array<{ path: string; type: string }>;
						truncated?: boolean;
					}>("GET", "/files/glob", {
						...common,
						query: {
							pattern: input.pattern,
							path,
							max_results: input.max_results ?? 50,
						},
					});
					const lines = found.matches.map((match) =>
						match.type === "directory" ? `${match.path}/` : match.path,
					);
					return `[${terminal.name}] ${lines.length} under ${found.path}${found.truncated ? " (more not shown)" : ""}\n${lines.join("\n")}`;
				}
				default:
					throw new RemoteTerminalError(
						`Unknown action "${String(input.action)}": use read, list, grep, glob, processes, info, ports, fetch or forward.`,
					);
			}
		},
	});

	const write = createTool<
		{
			terminal: string;
			action: "write" | "replace";
			path: string;
			content?: string;
			edits?: Array<{
				old_text: string;
				new_text: string;
				replace_all?: boolean;
			}>;
		},
		string
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.WRITE,
		description: [
			"Write files on a remote terminal: create or overwrite a file with `content`, or change part of one with `edits` (exact text to find and its replacement).",
			"Remote terminals:",
			terminalList,
			workspaceNote,
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				action: { type: "string", enum: ["write", "replace"] },
				path: {
					type: "string",
					description:
						"The file, relative to the workspace or absolute. Missing folders are created.",
				},
				content: {
					type: "string",
					description: "write: the whole new content.",
				},
				edits: {
					type: "array",
					description:
						"replace: each old_text must appear in the file exactly as given.",
					items: {
						type: "object",
						properties: {
							old_text: { type: "string" },
							new_text: { type: "string" },
							replace_all: {
								type: "boolean",
								description: "Replace every occurrence, not only one.",
							},
						},
						required: ["old_text", "new_text"],
					},
				},
			},
			required: ["terminal", "action", "path"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			const workspace = await workspaceFor(terminal, client, context);
			const path = inside(workspace, input.path);
			if (input.action === "write") {
				if (typeof input.content !== "string")
					throw new RemoteTerminalError("write needs `content`.");
				const written = await client.request<{
					path: string;
					size: number;
					created?: boolean;
				}>("POST", "/files/write", {
					body: { path, content: input.content },
					signal: context.signal,
				});
				return `[${terminal.name}] ${written.created ? "created" : "wrote"} ${written.path} (${written.size} B)`;
			}
			if (input.action === "replace") {
				if (!input.edits?.length)
					throw new RemoteTerminalError("replace needs `edits`.");
				const replaced = await client.request<{ path: string; patch?: string }>(
					"POST",
					"/files/replace",
					{
						body: {
							path,
							replacements: input.edits.map((edit) => ({
								target: edit.old_text,
								replacement: edit.new_text,
								allow_multiple: edit.replace_all === true,
							})),
						},
						signal: context.signal,
					},
				);
				return `[${terminal.name}] changed ${replaced.path}\n${trimRemoteOutput(replaced.patch ?? "")}`;
			}
			throw new RemoteTerminalError(
				`Unknown action "${String(input.action)}": use write or replace.`,
			);
		},
	});

	/** A short command on the machine, waited for to the end (packing can take a while). */
	const execToEnd = async (
		client: OpenTerminalClient,
		command: string,
		signal?: AbortSignal,
	): Promise<{ exitCode: number | null | undefined; output: string }> => {
		let response = await client.request<ExecResponse>("POST", "/execute", {
			query: { wait: POLL_WAIT_SECONDS },
			body: { command },
			signal,
		});
		let output = outputText(response);
		while (response.status === "running") {
			response = await client.request<ExecResponse>(
				"GET",
				`/execute/${encodeURIComponent(response.id)}/status`,
				{
					query: { wait: POLL_WAIT_SECONDS, offset: response.next_offset ?? 0 },
					signal,
				},
			);
			output += outputText(response);
		}
		return { exitCode: response.exit_code, output };
	};

	const megabytes = (bytes: number) =>
		bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MB`;

	const copy = createTool<
		{
			terminal: string;
			direction: "upload" | "download";
			from: string;
			to?: string;
			exclude?: string[];
			overwrite?: boolean;
		},
		string
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.COPY,
		description: [
			"Copy a file or a whole folder between the local workspace and a remote terminal, without the contents passing through the conversation. Any file type, binaries included.",
			"Remote terminals:",
			terminalList,
			`upload: \`from\` is a local path (relative to the local workspace, and inside it), \`to\` a path on the terminal (relative to this conversation's workspace there; default: the same name in it). download: the other way round; default \`to\` is the same name in the local workspace.`,
			`A folder is copied with its contents into \`to\`. On upload, ${DEFAULT_UPLOAD_EXCLUDES.join(" and ")} are left out unless \`exclude\` names its own list (pass [] to send everything). Existing local files are not replaced unless \`overwrite\` is true. At most ${MAX_TRANSFER_BYTES / 1024 / 1024 / 1024} GB per copy.`,
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				direction: { type: "string", enum: ["upload", "download"] },
				from: { type: "string", description: "The file or folder to copy." },
				to: {
					type: "string",
					description:
						"Where it goes. For a folder, the folder that receives its contents.",
				},
				exclude: {
					type: "array",
					items: { type: "string" },
					description:
						"Paths to leave out of a folder: a name or glob matches any path segment (`*.log`), one with / matches from the folder (`build/**`).",
				},
				overwrite: {
					type: "boolean",
					description: "Replace local files that already exist (download).",
				},
			},
			required: ["terminal", "direction", "from"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			const root = options.getLocalRoot?.();
			if (!root)
				throw new RemoteTerminalError(
					"There is no local workspace to copy to or from.",
				);
			const workspace = await workspaceFor(terminal, client, context);
			const signal = context.signal;
			const started = Date.now();
			const tag = randomUUID().replace(/-/g, "").slice(0, 12);
			const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
			if (typeof input.from !== "string" || !input.from.trim())
				throw new RemoteTerminalError("Name what to copy in `from`.");

			if (input.direction === "upload") {
				const local = await resolveLocalPath(root, input.from.trim());
				const info = await stat(local).catch(() => undefined);
				if (!info)
					throw new RemoteTerminalError(
						`${input.from} does not exist in the local workspace.`,
					);
				const target = inside(workspace, input.to?.trim() || basename(local));
				if (info.isFile()) {
					if (info.size > MAX_TRANSFER_BYTES)
						throw new RemoteTerminalError(
							`${input.from} is larger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB.`,
						);
					const data = new Uint8Array(await readFile(local));
					const slash = target.lastIndexOf("/");
					const sent = await client.upload(
						target.slice(0, slash) || "/",
						target.slice(slash + 1),
						data,
						signal,
					);
					return `[${terminal.name}] uploaded ${input.from} to ${sent.path} (${megabytes(sent.size)}, ${took()})`;
				}
				if (!info.isDirectory())
					throw new RemoteTerminalError(
						`${input.from} is neither a file nor a folder.`,
					);
				const packed = await packFolder(
					local,
					input.exclude ?? DEFAULT_UPLOAD_EXCLUDES,
				);
				const archiveName = `.cerebriline-upload-${tag}.tar.gz`;
				await client.upload(
					workspace,
					archiveName,
					new Uint8Array(packed.archive),
					signal,
				);
				const archivePath = `${workspace}/${archiveName}`;
				const unpacked = await execToEnd(
					client,
					`mkdir -p ${quoteShell(target)} && tar -xzf ${quoteShell(archivePath)} -C ${quoteShell(target)} --no-same-owner; status=$?; rm -f ${quoteShell(archivePath)}; exit $status`,
					signal,
				);
				if (unpacked.exitCode !== 0) {
					throw new RemoteTerminalError(
						`Unpacking on "${terminal.name}" failed: ${unpacked.output.trim() || `exit ${unpacked.exitCode}`}`,
					);
				}
				const left = packed.excluded
					? `; left out ${packed.excluded} path${packed.excluded === 1 ? "" : "s"} matching ${(input.exclude ?? DEFAULT_UPLOAD_EXCLUDES).join(", ")}`
					: "";
				return `[${terminal.name}] uploaded ${input.from} to ${target}: ${packed.files} file${packed.files === 1 ? "" : "s"}, ${megabytes(packed.bytes)} (${megabytes(packed.archive.length)} packed), ${took()}${left}`;
			}

			if (input.direction === "download") {
				const remote = inside(workspace, input.from.trim());
				const name = remote.replace(/\/+$/, "").split("/").pop() || "download";
				const local = await resolveLocalPath(root, input.to?.trim() || name);
				const kind = await execToEnd(
					client,
					`if [ -d ${quoteShell(remote)} ]; then echo dir; elif [ -f ${quoteShell(remote)} ]; then stat -c 'file %s' ${quoteShell(remote)}; else echo missing; fi`,
					signal,
				);
				const answer = kind.output.trim().split("\n").pop() ?? "";
				if (answer === "missing" || kind.exitCode !== 0)
					throw new RemoteTerminalError(
						`${remote} does not exist on "${terminal.name}".`,
					);
				if (answer.startsWith("file")) {
					const size = Number(answer.split(" ")[1]);
					if (size > MAX_TRANSFER_BYTES)
						throw new RemoteTerminalError(
							`${remote} is larger than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB.`,
						);
					const data = await client.download(remote, signal);
					const written = await writeLocalFile(
						local,
						data,
						input.overwrite === true,
					);
					return `[${terminal.name}] downloaded ${remote} to ${local} (${megabytes(data.length)}${written.replaced ? ", replaced the existing file" : ""}, ${took()})`;
				}
				const archivePath = `${workspace}/.cerebriline-download-${tag}.tar.gz`;
				const excludes = (input.exclude ?? [])
					.map((pattern) => `--exclude=${quoteShell(pattern)}`)
					.join(" ");
				const packed = await execToEnd(
					client,
					`tar -czf ${quoteShell(archivePath)} ${excludes} -C ${quoteShell(remote)} . && stat -c %s ${quoteShell(archivePath)}`,
					signal,
				);
				try {
					if (packed.exitCode !== 0) {
						throw new RemoteTerminalError(
							`Packing ${remote} on "${terminal.name}" failed: ${packed.output.trim() || `exit ${packed.exitCode}`}`,
						);
					}
					const size = Number(packed.output.trim().split("\n").pop());
					if (size > MAX_TRANSFER_BYTES) {
						throw new RemoteTerminalError(
							`${remote} packs to more than ${MAX_TRANSFER_BYTES / 1024 / 1024} MB; copy a smaller folder or leave more out with \`exclude\`.`,
						);
					}
					const archive = await client.download(archivePath, signal);
					const result = await unpackArchive(archive, local, {
						overwrite: input.overwrite === true,
					});
					const notes = [
						result.replaced
							? `replaced ${result.replaced} existing file${result.replaced === 1 ? "" : "s"}`
							: "",
						result.skipped
							? `skipped ${result.skipped} link${result.skipped === 1 ? "" : "s"} or special file${result.skipped === 1 ? "" : "s"}`
							: "",
					].filter(Boolean);
					return `[${terminal.name}] downloaded ${remote} to ${local}: ${result.files} file${result.files === 1 ? "" : "s"}, ${megabytes(result.bytes)} (${megabytes(archive.length)} packed), ${took()}${notes.length ? `; ${notes.join("; ")}` : ""}`;
				} finally {
					await execToEnd(client, `rm -f ${quoteShell(archivePath)}`).catch(
						() => undefined,
					);
				}
			}
			throw new RemoteTerminalError(
				`Unknown direction "${String(input.direction)}": use upload or download.`,
			);
		},
	});

	// Reads, writes and copies show as one line each in the host's display:
	// the first line of what the tool returns, or why it failed.
	const announced = (tool: AgentTool): AgentTool => ({
		...tool,
		execute: async (input, context) => {
			const name = (input as { terminal?: unknown } | undefined)?.terminal;
			try {
				const result = await tool.execute(input, context);
				const text = Array.isArray(result)
					? ((result as Array<{ type?: string; text?: string }>).find(
							(part) => part.type === "text",
						)?.text ?? "")
					: String(result);
				const line = text.split("\n")[0] ?? "";
				const match = /^\[([^\]]+)\] (.*)$/.exec(line);
				if (match) {
					emit({
						type: "note",
						terminal: match[1],
						sessionId: remoteWorkspaceId(context),
						text: `${tool.name}: ${match[2]}`,
					});
				}
				return result;
			} catch (error) {
				if (typeof name === "string") {
					emit({
						type: "note",
						terminal:
							matchRemoteTerminal(
								usableTerminals(options.getConfig() ?? initial),
								name,
							)?.name.trim() ?? name,
						sessionId: remoteWorkspaceId(context),
						text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
				throw error;
			}
		},
	});

	/** A screenshot as the model gets it: the image for a model that sees, a note otherwise. */
	const screenshotOutput = (
		text: string,
		raw: { contentType: string; bytes: Uint8Array },
		context: AgentToolContext,
	): RemoteToolOutput => {
		const kind = raw.contentType.split(";")[0].trim() || "image/png";
		if (context.metadata?.modelSupportsImages !== true) {
			return `${text}\n(A screenshot was taken; this model cannot see images.)`;
		}
		const sizeNote = screenshotSizeNote(imageSize(raw.bytes));
		return [
			{ type: "text", text: sizeNote ? `${text}\n${sizeNote}` : text },
			{
				type: "image",
				data: Buffer.from(raw.bytes).toString("base64"),
				mediaType: kind,
			},
		];
	};

	const actionItemSchema = (kinds: string[], withRefs: boolean) => ({
		type: "object",
		properties: {
			action: { type: "string", enum: kinds },
			...(withRefs
				? {
						ref: {
							type: "string",
							description:
								"An element ref from the snapshot, e.g. @e3 (instead of x and y).",
						},
						url: { type: "string", description: "navigate: the URL." },
					}
				: {}),
			x: { type: "number", description: "Pixels in the last screenshot." },
			y: { type: "number" },
			to_x: { type: "number", description: "drag: where to." },
			to_y: { type: "number" },
			button: { type: "string", enum: ["left", "middle", "right"] },
			direction: { type: "string", enum: ["up", "down", "left", "right"] },
			amount: { type: "number", description: "scroll: how far." },
			text: { type: "string", description: "type: the text." },
			key: {
				type: "string",
				description:
					"key: a key or combination, e.g. Enter, Tab, ctrl+a, alt+F2.",
			},
		},
		required: ["action"],
	});

	// Where each machine's desktop pointer is, as far as this process moved it.
	// Open Terminal's `xdotool mousemove --sync` waits forever (10 s, then
	// fails) when the pointer is already at the target, and a new desktop
	// starts with it in the middle of the screen. Measured on bench-app
	// 2026-11-28: the same position twice -> 502 after 10.0 s; elsewhere 0.6 s.
	const pointers = new Map<string, { x: number; y: number }>();
	const avoidPointerHang = (
		machine: string,
		actions: Array<Record<string, unknown>>,
	) => {
		let at = pointers.get(machine) ?? { x: 640, y: 400 };
		for (const item of actions) {
			if (typeof item.x === "number" && typeof item.y === "number") {
				if (item.x === at.x && item.y === at.y)
					item.x = item.x > 0 ? item.x - 1 : item.x + 1;
				at = { x: item.x as number, y: item.y as number };
			}
			if (typeof item.to_x === "number" && typeof item.to_y === "number") {
				if (item.to_x === at.x && item.to_y === at.y)
					item.to_x = item.to_x > 0 ? item.to_x - 1 : item.to_x + 1;
				at = { x: item.to_x as number, y: item.to_y as number };
			}
		}
		pointers.set(machine, at);
		return actions;
	};

	const cleanActions = (actions: unknown): Array<Record<string, unknown>> => {
		if (!Array.isArray(actions) || actions.length === 0) {
			throw new RemoteTerminalError(
				"act needs `actions`: a list of 1-50 steps.",
			);
		}
		return actions
			.slice(0, 50)
			.map((item) =>
				Object.fromEntries(
					Object.entries((item ?? {}) as Record<string, unknown>).filter(
						([, value]) =>
							value !== undefined && value !== null && value !== "",
					),
				),
			);
	};

	const remoteBrowser = createTool<
		{
			terminal: string;
			action: "open" | "snapshot" | "screenshot" | "act" | "tabs" | "close";
			url?: string;
			actions?: Array<Record<string, unknown>>;
			session_id?: string;
		},
		RemoteToolOutput
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.BROWSER,
		description: [
			"A real Chrome tab running on a remote terminal: open a page, read it, click and type in it. URLs are as the terminal sees them, so http://localhost:<port> reaches a server you started there with remote_run.",
			"open: a new tab at `url` (it becomes this conversation's tab). snapshot: the page as an accessibility tree, with refs like @e3 for the elements you can use. act: `actions`, 1-50 steps run in order (click, double_click, move, drag, scroll, type, key, navigate, back, forward, reload), each on a `ref` from the latest snapshot or on x,y pixels of the latest screenshot; answers with a fresh snapshot. Refs can expire after the page changes: take a new snapshot. screenshot: an image of the tab. tabs: the open tabs. close: close a tab.",
			"Remote terminals:",
			terminalList,
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				action: {
					type: "string",
					enum: ["open", "snapshot", "screenshot", "act", "tabs", "close"],
				},
				url: { type: "string", description: "open: an http(s) URL." },
				actions: {
					type: "array",
					description: "act: the steps, in order.",
					items: actionItemSchema(
						[
							"click",
							"double_click",
							"move",
							"drag",
							"scroll",
							"type",
							"key",
							"navigate",
							"back",
							"forward",
							"reload",
						],
						true,
					),
				},
				session_id: {
					type: "string",
					description: "A tab from `tabs`. Default: this conversation's tab.",
				},
			},
			required: ["terminal", "action"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			const tabKey = `${terminal.machineId.trim()}\u0000${remoteWorkspaceId(context)}`;
			const common = { signal: context.signal };
			const tab = () => {
				const id = input.session_id?.trim() || browserTabs.get(tabKey);
				if (!id) {
					throw new RemoteTerminalError(
						`No browser tab yet on "${terminal.name}": use action open with a url first.`,
					);
				}
				return id;
			};
			const describe = (page: {
				session_id?: string;
				url?: string;
				title?: string;
				snapshot?: string;
			}) =>
				`[${terminal.name}] tab ${page.session_id ?? ""}${page.title ? ` "${page.title}"` : ""}${page.url ? ` ${page.url}` : ""}\n${trimRemoteOutput(page.snapshot ?? "")}`;
			const withScreenshot = async (text: string, id: string) => {
				if (context.metadata?.modelSupportsImages !== true) return text;
				try {
					const raw = await client.getRaw(
						"/browser/screenshot",
						{ session_id: id },
						context.signal,
					);
					return screenshotOutput(text, raw, context);
				} catch {
					return text;
				}
			};
			switch (input.action) {
				case "open": {
					if (!input.url?.trim()) {
						throw new RemoteTerminalError("open needs a `url`.");
					}
					const created = await client.request<{ id?: string }>(
						"POST",
						"/browser/sessions",
						{ ...common, body: { url: input.url.trim() } },
					);
					if (!created.id) {
						throw new RemoteTerminalError(
							`"${terminal.name}" did not open a browser tab.`,
						);
					}
					await client.request(
						"PATCH",
						`/browser/sessions/${encodeURIComponent(created.id)}`,
						{
							...common,
							body: { mode: "chrome", active: true },
						},
					);
					browserTabs.set(tabKey, created.id);
					const page = await client.request<Record<string, string>>(
						"GET",
						"/browser/snapshot",
						{ ...common, query: { session_id: created.id } },
					);
					return withScreenshot(describe(page), created.id);
				}
				case "snapshot": {
					const id = tab();
					const page = await client.request<Record<string, string>>(
						"GET",
						"/browser/snapshot",
						{ ...common, query: { session_id: id } },
					);
					return describe(page);
				}
				case "screenshot": {
					const id = tab();
					const raw = await client.getRaw(
						"/browser/screenshot",
						{ session_id: id },
						context.signal,
					);
					return screenshotOutput(`[${terminal.name}] tab ${id}`, raw, context);
				}
				case "act": {
					const id = tab();
					const page = await client.request<Record<string, string>>(
						"POST",
						"/browser/action",
						{
							...common,
							body: { session_id: id, actions: cleanActions(input.actions) },
						},
					);
					return withScreenshot(describe(page), id);
				}
				case "tabs": {
					const listed = await client.request<{
						tabs?: Array<{
							session_id: string;
							url?: string;
							title?: string;
							mode?: string;
							selected?: boolean;
						}>;
					}>("GET", "/browser/tabs", common);
					const lines = (listed.tabs ?? []).map(
						(entry) =>
							`${entry.session_id}${entry.session_id === browserTabs.get(tabKey) ? " (this conversation's)" : ""}  ${entry.mode ?? ""}  ${entry.title ?? ""}  ${entry.url ?? ""}`,
					);
					return `[${terminal.name}] ${lines.length} browser tab${lines.length === 1 ? "" : "s"}${lines.length ? `\n${lines.join("\n")}` : ""}`;
				}
				case "close": {
					const id = tab();
					await client.request(
						"DELETE",
						`/browser/sessions/${encodeURIComponent(id)}`,
						common,
					);
					if (browserTabs.get(tabKey) === id) browserTabs.delete(tabKey);
					return `[${terminal.name}] closed tab ${id}.`;
				}
				default:
					throw new RemoteTerminalError(
						`Unknown action "${String(input.action)}": use open, snapshot, screenshot, act, tabs or close.`,
					);
			}
		},
	});

	const remoteDesktop = createTool<
		{
			terminal: string;
			action: "screenshot" | "act";
			actions?: Array<Record<string, unknown>>;
		},
		RemoteToolOutput
	>({
		name: REMOTE_TERMINAL_TOOL_NAMES.DESKTOP,
		description: [
			"The Linux desktop of your account on a remote terminal (XFCE, 1280×800): see it and drive it with the mouse and keyboard. Needs a model that can see images.",
			"screenshot: an image of the desktop; the first one starts the desktop. Once it runs, programs you start with remote_run open on it (start them with `setsid -f <program> >/dev/null 2>&1 </dev/null` so the call returns). act: `actions`, 1-50 steps run in order (click, double_click, move, drag, scroll, type, key) on x,y pixels of the latest screenshot; answers with a fresh screenshot. Every conversation of this account shares the one desktop.",
			"Remote terminals:",
			terminalList,
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				terminal: terminalProperty,
				action: { type: "string", enum: ["screenshot", "act"] },
				actions: {
					type: "array",
					description: "act: the steps, in order.",
					items: actionItemSchema(
						["click", "double_click", "move", "drag", "scroll", "type", "key"],
						false,
					),
				},
			},
			required: ["terminal", "action"],
		},
		execute: async (input, context) => {
			const { terminal, client } = await resolve(input.terminal);
			switch (input.action) {
				case "screenshot": {
					const raw = await client.getRaw(
						"/desktop/screenshot",
						{},
						context.signal,
					);
					return screenshotOutput(
						`[${terminal.name}] desktop. Programs started with remote_run now open on it.`,
						raw,
						context,
					);
				}
				case "act": {
					const raw = await client.postRaw(
						"/desktop/action",
						{
							actions: avoidPointerHang(
								terminal.machineId.trim(),
								cleanActions(input.actions),
							),
						},
						context.signal,
					);
					return screenshotOutput(
						`[${terminal.name}] desktop after the steps`,
						raw,
						context,
					);
				}
				default:
					throw new RemoteTerminalError(
						`Unknown action "${String(input.action)}": use screenshot or act.`,
					);
			}
		},
	});

	const tools: AgentTool[] = [
		run as unknown as AgentTool,
		announced(read as unknown as AgentTool),
		announced(write as unknown as AgentTool),
	];
	if (options.getLocalRoot) tools.push(announced(copy as unknown as AgentTool));
	if (initial.browser)
		tools.push(announced(remoteBrowser as unknown as AgentTool));
	if (initial.desktop)
		tools.push(announced(remoteDesktop as unknown as AgentTool));
	return tools;
}

/**
 * Removes a session's workspace on its machine: `rm -rf` of exactly
 * `~/cerebriline/<workspaceId>`, nothing else. For the host's retention sweep.
 */
export async function removeRemoteWorkspace(
	config: RemoteTerminalsConfig,
	record: Pick<RemoteWorkspaceRecord, "terminal" | "machineId" | "workspaceId">,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const id = record.workspaceId;
	if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) {
		throw new RemoteTerminalError(
			`Refusing to remove a workspace with an unexpected name: ${id}`,
		);
	}
	const terminal = { name: record.terminal, machineId: record.machineId };
	const client = new OpenTerminalClient(config, terminal, fetchImpl);
	const done = await client.request<ExecResponse>("POST", "/execute", {
		query: { wait: POLL_WAIT_SECONDS },
		body: {
			command: `rm -rf -- "$HOME"/${quoteShell(`${REMOTE_WORKSPACE_ROOT}/${id}`)}`,
		},
	});
	if (done.status !== "done" || done.exit_code !== 0) {
		throw new RemoteTerminalError(
			`Removing ${id} on "${record.terminal}" failed: ${outputText(done).trim() || `exit ${done.exit_code}`}`,
		);
	}
}
