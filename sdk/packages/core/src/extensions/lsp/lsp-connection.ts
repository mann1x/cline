import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { HostDiagnostic } from "../diagnostics/types";

/**
 * A language server, spoken to over stdio.
 *
 * The extension's `ask_lsp`, `check_file` and post-edit diagnostics ask VS
 * Code, which already runs a server for every language in the workspace. A
 * host without an editor -- the CLI, automaticum's runner -- has no such
 * thing, so this is the part it brings itself: spawn the server, complete the
 * handshake, keep the documents it was asked about in sync with the disk,
 * answer what the server asks of its client, and keep the diagnostics it
 * publishes the way an editor keeps them.
 *
 * Kept to what those three tools need. Not a general LSP client.
 */

/** LSP frames a message with a `Content-Length` header and a blank line. */
const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * How long one request gets before the answer is called absent.
 *
 * A language server that is still indexing answers slowly rather than wrongly,
 * and the tools' contract is that an unanswered question returns nothing rather
 * than failing the turn. Generous, because the first request after start-up
 * pays for the whole workspace being read.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** How long the server gets to complete `initialize`. */
const INITIALIZE_TIMEOUT_MS = 30_000;

export interface LspServerSpec {
	/** How the server is named in status and errors. Defaults to `command`. */
	name?: string;
	/** The executable: a name looked up on PATH, or a full path. */
	command: string;
	args: string[];
	/** Languages this server answers for, as LSP language ids. */
	languages: string[];
	/**
	 * The file whose existence says the server is installed. Defaults to
	 * `command` (looked up on PATH when it has no directory in it). A server
	 * started as `node <script>` names its script here.
	 */
	probe?: string;
	/** Added to the environment the server starts with. */
	env?: Record<string, string>;
	/**
	 * Server-specific `initializationOptions`.
	 *
	 * Needed because a server is not always self-sufficient:
	 * `typescript-language-server` refuses to start unless it can find a
	 * TypeScript installation, and it looks in the workspace. A workspace with
	 * no `node_modules` -- which is most of the ones a model is asked to fix --
	 * gets "Could not find a valid TypeScript installation. Exiting."
	 */
	initializationOptions?:
		| Record<string, unknown>
		| (() => Record<string, unknown> | undefined);
	/**
	 * The settings an editor would hold for this server: sent once with
	 * `workspace/didChangeConfiguration` and read back for every
	 * `workspace/configuration` the server asks. A section nobody set answers
	 * an empty object, never null -- see `LspConnection.setting`.
	 */
	settings?: Record<string, unknown>;
	/**
	 * A diagnostic's producer as the editor names it, by what the server
	 * reports: VS Code labels what tsserver reports "ts", where the server
	 * says "typescript".
	 */
	sources?: Record<string, string>;
}

/** The name a spec goes by. */
export function serverName(spec: LspServerSpec): string {
	return spec.name ?? spec.command;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface HeldDocument {
	version: number;
	text: string;
}

export function fileUri(filePath: string): string {
	return pathToFileURL(filePath).toString();
}

export function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}
	try {
		return decodeURIComponent(new URL(uri).pathname);
	} catch {
		return uri;
	}
}

const SEVERITY_NAMES = ["error", "warning", "information", "hint"] as const;

/**
 * A diagnostic as the editor keeps it, from what a server sent: a position,
 * a named severity, the message and the producer. LSP leaves the severity
 * to the client when it is absent; VS Code treats that as an error.
 */
export function normalizeLspDiagnostic(raw: unknown): HostDiagnostic {
	const entry = (raw ?? {}) as {
		range?: {
			start?: { line?: number; character?: number };
			end?: { line?: number; character?: number };
		};
		severity?: unknown;
		message?: unknown;
		source?: unknown;
	};
	const start = {
		line: entry.range?.start?.line ?? 0,
		character: entry.range?.start?.character ?? 0,
	};
	const end = {
		line: entry.range?.end?.line ?? start.line,
		character: entry.range?.end?.character ?? start.character,
	};
	const severity =
		typeof entry.severity === "number" &&
		entry.severity >= 1 &&
		entry.severity <= 4
			? SEVERITY_NAMES[entry.severity - 1]
			: "error";
	return {
		range: { start, end },
		severity,
		message: String(entry.message ?? ""),
		...(entry.source ? { source: String(entry.source) } : {}),
	};
}

export interface LspConnectionOptions {
	onError?: (message: string, error: unknown) => void;
	/** Every `textDocument/publishDiagnostics`, the path decoded. */
	onDiagnostics?: (filePath: string, diagnostics: HostDiagnostic[]) => void;
}

/**
 * One server process and the conversation with it.
 *
 * Requests are correlated by id. A message with a `method` is the server's,
 * whether or not it has an id: with one it is a request and is answered, and
 * only a message without a `method` is a response to one of ours. A server
 * that dies takes its pending requests with it rather than leaving them
 * hanging until the timeout.
 */
export class LspConnection {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	/** What the server holds open, by URI: the text it was last sent. */
	private readonly documents = new Map<string, HeldDocument>();
	private initializing: Promise<void> | undefined;
	private failure: Error | undefined;
	private pullRefused = false;
	/** What the server said it can do, from its `initialize` answer. */
	capabilities: Record<string, unknown> = {};

	private readonly onError?: (message: string, error: unknown) => void;
	private readonly onDiagnostics?: (
		filePath: string,
		diagnostics: HostDiagnostic[],
	) => void;

	constructor(
		readonly spec: LspServerSpec,
		private readonly rootPath: string,
		options?:
			| LspConnectionOptions
			| ((message: string, error: unknown) => void),
	) {
		const resolved =
			typeof options === "function" ? { onError: options } : options;
		this.onError = resolved?.onError;
		this.onDiagnostics = resolved?.onDiagnostics;
	}

	/** Whether the server has been started and is still running. */
	get started(): boolean {
		return this.child !== undefined && this.failure === undefined;
	}

	/** Why the server is not available, once it has failed. */
	get failed(): Error | undefined {
		return this.failure;
	}

	/** Started once, on the first question, and shared by every one after it. */
	async ready(): Promise<void> {
		if (this.failure) {
			throw this.failure;
		}
		if (!this.initializing) {
			this.initializing = this.start().catch((error: unknown) => {
				this.failure =
					error instanceof Error ? error : new Error(String(error));
				throw this.failure;
			});
		}
		return this.initializing;
	}

	private async start(): Promise<void> {
		const child = spawn(this.spec.command, this.spec.args, {
			cwd: this.rootPath,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...(this.spec.env ?? {}) },
		});
		this.child = child;
		// Never a reason for the host to stay alive. A language server outliving
		// the question it was asked would hold a finished CLI run open, which is
		// exactly how a run that has printed its answer still appears to hang.
		//
		// The pipes have to be unreferenced as well as the process: `unref` on
		// the child releases its handle, while its stdio sockets keep their own,
		// and three live sockets are enough on their own to keep the loop from
		// draining.
		child.unref();
		for (const stream of [child.stdin, child.stdout, child.stderr]) {
			(stream as unknown as { unref?: () => void }).unref?.();
		}
		child.on("error", (error) => this.fail(error));
		child.on("exit", (code) =>
			this.fail(new Error(`${serverName(this.spec)} exited with code ${code}`)),
		);
		// A write to a server that has just died raises EPIPE here, not on the
		// child, and unhandled it takes the host down with it.
		child.stdin.on("error", (error) => this.fail(error));
		child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
		// Drained rather than inherited: a server that writes progress to stderr
		// would otherwise interleave with the host's own output.
		child.stderr.on("data", () => {});

		const initializationOptions =
			typeof this.spec.initializationOptions === "function"
				? this.spec.initializationOptions()
				: this.spec.initializationOptions;
		const result = (await this.request(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "cerebriline" },
				initializationOptions,
				rootUri: fileUri(this.rootPath),
				rootPath: this.rootPath,
				workspaceFolders: [{ uri: fileUri(this.rootPath), name: "workspace" }],
				capabilities: {
					textDocument: {
						synchronization: { didSave: true, dynamicRegistration: false },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						hover: { contentFormat: ["plaintext", "markdown"] },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: {},
						publishDiagnostics: {
							relatedInformation: false,
							versionSupport: true,
						},
						diagnostic: { dynamicRegistration: false },
					},
					workspace: {
						symbol: {},
						workspaceFolders: true,
						configuration: true,
					},
					window: { workDoneProgress: false },
				},
			},
			INITIALIZE_TIMEOUT_MS,
		)) as { capabilities?: Record<string, unknown> } | undefined;
		this.capabilities = result?.capabilities ?? {};
		this.notify("initialized", {});
		if (this.spec.settings) {
			this.notify("workspace/didChangeConfiguration", {
				settings: this.spec.settings,
			});
		}
	}

	private fail(error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!this.failure) {
			this.onError?.(`[lsp] ${serverName(this.spec)} failed`, failure);
		}
		this.failure = failure;
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			request.reject(failure);
			this.pending.delete(id);
		}
	}

	private consume(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
			if (headerEnd === -1) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const length = /content-length:\s*(\d+)/i.exec(header)?.[1];
			if (!length) {
				// Unparseable header: drop it rather than stall forever on it.
				this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
				continue;
			}
			const start = headerEnd + HEADER_SEPARATOR.length;
			const end = start + Number(length);
			if (this.buffer.length < end) {
				return;
			}
			const body = this.buffer.subarray(start, end).toString("utf8");
			this.buffer = this.buffer.subarray(end);
			this.dispatch(body);
		}
	}

	private dispatch(body: string): void {
		let message: {
			id?: number | string;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { message?: string };
		};
		try {
			message = JSON.parse(body);
		} catch (error) {
			this.onError?.("[lsp] unparseable message", error);
			return;
		}
		if (message.method !== undefined) {
			// The server's own message. With an id it is a request, and its ids
			// are its own: looked up among ours it would resolve whichever of our
			// requests happened to share the number, with the wrong answer.
			if (message.id !== undefined) {
				this.answer(message.id, message.method, message.params);
			} else if (message.method === "textDocument/publishDiagnostics") {
				const params = (message.params ?? {}) as {
					uri?: string;
					diagnostics?: unknown[];
				};
				this.onDiagnostics?.(
					uriToPath(params.uri ?? ""),
					(params.diagnostics ?? []).map((entry) =>
						this.label(normalizeLspDiagnostic(entry)),
					),
				);
			}
			return;
		}
		if (typeof message.id !== "number") {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message ?? "LSP error"));
			return;
		}
		pending.resolve(message.result);
	}

	/**
	 * A request of the server's own, answered as an editor answers it.
	 *
	 * Left unanswered, some servers wait for the answer before doing anything
	 * else.
	 */
	private answer(id: number | string, method: string, params: unknown): void {
		let result: unknown = null;
		switch (method) {
			case "workspace/configuration": {
				const items =
					(params as { items?: Array<{ section?: string }> } | undefined)
						?.items ?? [];
				result = items.map((item) => this.setting(item.section));
				break;
			}
			case "workspace/workspaceFolders":
				result = [{ uri: fileUri(this.rootPath), name: "workspace" }];
				break;
			default:
				// client/registerCapability, window/workDoneProgress/create,
				// window/showMessageRequest, workspace/*/refresh: acknowledged.
				result = null;
		}
		this.send({ id, result });
	}

	/**
	 * A section of the settings, as an editor answers: an object, empty for a
	 * section nobody set. Never null: the CSS validator reads properties off
	 * what it is given ("Cannot read properties of null (reading
	 * 'validProperties')"), and the HTML server validates a page's `<style>`
	 * through it, so a null aborts the whole page's validation -- and a page
	 * whose script does not parse then reports no diagnostics at all.
	 */
	setting(section: string | undefined): unknown {
		let value: unknown = this.spec.settings ?? {};
		for (const part of (section ?? "").split(".").filter(Boolean)) {
			value =
				value !== null && typeof value === "object"
					? (value as Record<string, unknown>)[part]
					: undefined;
		}
		return value ?? {};
	}

	private send(payload: Record<string, unknown>): void {
		if (!this.child || this.failure) {
			return;
		}
		const body = JSON.stringify({ jsonrpc: "2.0", ...payload });
		const length = Buffer.byteLength(body, "utf8");
		this.child.stdin.write(
			`Content-Length: ${length}${HEADER_SEPARATOR}${body}`,
		);
	}

	notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.send({ id, method, params });
		});
	}

	/**
	 * Make the server hold the file as it is now.
	 *
	 * Opened the first time; after that, sent whole as a change, with the next
	 * version, when it differs from what the server holds. A second `didOpen`
	 * for a document already open is a protocol error that servers answer by
	 * ignoring it -- and then answering from the old text, which is exactly
	 * the "the model edits, then asks" case. Returns whether the server was
	 * told anything.
	 */
	syncDocument(filePath: string, text: string, languageId: string): boolean {
		const uri = fileUri(filePath);
		const held = this.documents.get(uri);
		if (!held) {
			this.documents.set(uri, { version: 1, text });
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			});
			return true;
		}
		if (held.text === text) {
			return false;
		}
		held.version += 1;
		held.text = text;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: held.version },
			contentChanges: [{ text }],
		});
		return true;
	}

	/**
	 * Tell the server the file was written. Some servers check only on save:
	 * rust-analyzer's type errors come from `cargo check` on `didSave`.
	 */
	documentSaved(filePath: string): void {
		const uri = fileUri(filePath);
		const held = this.documents.get(uri);
		if (held) {
			this.notify("textDocument/didSave", {
				textDocument: { uri },
				text: held.text,
			});
		}
	}

	/** Whether this server answers `textDocument/diagnostic` when asked. */
	get pullsDiagnostics(): boolean {
		return Boolean(this.capabilities.diagnosticProvider) && !this.pullRefused;
	}

	/**
	 * Diagnostics asked for, from a server that answers only when asked
	 * (csharp-ls). Undefined when the server does not pull, or answered with
	 * something other than a full report.
	 */
	async pullDiagnostics(
		filePath: string,
	): Promise<HostDiagnostic[] | undefined> {
		if (!this.pullsDiagnostics) {
			return undefined;
		}
		let report: { kind?: string; items?: unknown[] } | undefined;
		try {
			report = (await this.request("textDocument/diagnostic", {
				textDocument: { uri: fileUri(filePath) },
			})) as typeof report;
		} catch (error) {
			// Servers built on vscode-languageserver announce the provider and
			// still push to a client that does not ask; once refused, the
			// server is not asked again.
			if (
				/unhandled method|method not found/i.test(
					error instanceof Error ? error.message : String(error),
				)
			) {
				this.pullRefused = true;
				return undefined;
			}
			throw error;
		}
		if (report?.kind !== "full" || !Array.isArray(report.items)) {
			return undefined;
		}
		return report.items.map((entry) =>
			this.label(normalizeLspDiagnostic(entry)),
		);
	}

	private label(diagnostic: HostDiagnostic): HostDiagnostic {
		const renamed = diagnostic.source
			? this.spec.sources?.[diagnostic.source]
			: undefined;
		return renamed ? { ...diagnostic, source: renamed } : diagnostic;
	}

	async dispose(): Promise<void> {
		if (!this.child) {
			return;
		}
		try {
			await this.request("shutdown", null, 2_000);
			this.notify("exit", null);
		} catch {
			// A server that will not shut down politely gets killed below.
		}
		this.child.kill();
		this.child = undefined;
	}
}
