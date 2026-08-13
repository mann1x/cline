import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * A language server, spoken to over stdio.
 *
 * The extension's `code_intel` asks VS Code, which already runs a server for
 * every language in the workspace and answers in a single `executeCommand`. A
 * terminal has no such thing, so this is the part the CLI has to bring itself:
 * spawn the server, complete the LSP handshake, keep the documents it has been
 * asked about open, and turn ten questions into JSON-RPC.
 *
 * Kept to exactly what `CodeIntelProvider` needs. This is not a general LSP
 * client and should not grow into one: every method here exists because a
 * `code_intel` operation calls it.
 */

/** LSP frames a message with a `Content-Length` header and a blank line. */
const HEADER_SEPARATOR = "\r\n\r\n";

/**
 * How long one request gets before the answer is called absent.
 *
 * A language server that is still indexing answers slowly rather than wrongly,
 * and the tool's contract is that an unanswered question returns nothing rather
 * than failing the turn. Generous, because the first request after start-up
 * pays for the whole workspace being read.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** How long the server gets to complete `initialize`. */
const INITIALIZE_TIMEOUT_MS = 30_000;

export interface LspServerSpec {
	/** The executable, as it would be typed. */
	command: string;
	args: string[];
	/** Languages this server answers for, as LSP language ids. */
	languages: string[];
	/**
	 * Server-specific `initializationOptions`.
	 *
	 * Needed because a server is not always self-sufficient:
	 * `typescript-language-server` refuses to start unless it can find a
	 * TypeScript installation, and it looks in the workspace. A workspace with
	 * no `node_modules` -- which is most of the ones a model is asked to fix --
	 * gets "Could not find a valid TypeScript installation. Exiting."
	 */
	initializationOptions?: () => Record<string, unknown> | undefined;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
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

/**
 * One server process and the conversation with it.
 *
 * Requests are correlated by id, notifications are ignored unless they are the
 * ones that matter, and a server that dies takes its pending requests with it
 * rather than leaving them hanging until the timeout.
 */
export class LspConnection {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly openDocuments = new Set<string>();
	private initializing: Promise<void> | undefined;
	private failed: Error | undefined;

	constructor(
		private readonly spec: LspServerSpec,
		private readonly rootPath: string,
		private readonly onError?: (message: string, error: unknown) => void,
	) {}

	/** Started once, on the first question, and shared by every one after it. */
	async ready(): Promise<void> {
		if (this.failed) {
			throw this.failed;
		}
		if (!this.initializing) {
			this.initializing = this.start().catch((error: unknown) => {
				this.failed =
					error instanceof Error ? error : new Error(String(error));
				throw this.failed;
			});
		}
		return this.initializing;
	}

	private async start(): Promise<void> {
		const child = spawn(this.spec.command, this.spec.args, {
			cwd: this.rootPath,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		// Never a reason for the host to stay alive. A language server outliving
		// the question it was asked would hold a finished CLI run open, which is
		// exactly how a run that has printed its answer still appears to hang.
		//
		// The pipes have to be unreferenced as well as the process: `unref` on
		// the child releases its handle, while its stdio sockets keep their own,
		// and three live sockets are enough on their own to keep the loop from
		// draining. Measured -- with only the child unreferenced, a probe that
		// had printed every answer sat until it was killed.
		child.unref();
		for (const stream of [child.stdin, child.stdout, child.stderr]) {
			(stream as unknown as { unref?: () => void }).unref?.();
		}
		child.on("error", (error) => this.fail(error));
		child.on("exit", (code) =>
			this.fail(new Error(`${this.spec.command} exited with code ${code}`)),
		);
		child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
		// Drained rather than inherited: a server that writes progress to stderr
		// would otherwise interleave with the CLI's own output.
		child.stderr.on("data", () => {});

		await this.request(
			"initialize",
			{
				processId: process.pid,
				initializationOptions: this.spec.initializationOptions?.(),
				rootUri: fileUri(this.rootPath),
				workspaceFolders: [
					{ uri: fileUri(this.rootPath), name: "workspace" },
				],
				capabilities: {
					textDocument: {
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						hover: { contentFormat: ["plaintext", "markdown"] },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: {},
					},
					workspace: { symbol: {}, workspaceFolders: true },
				},
			},
			INITIALIZE_TIMEOUT_MS,
		);
		this.notify("initialized", {});
	}

	private fail(error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		this.failed = failure;
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
		let message: { id?: number; result?: unknown; error?: { message?: string } };
		try {
			message = JSON.parse(body);
		} catch (error) {
			this.onError?.("[lsp] unparseable message", error);
			return;
		}
		if (typeof message.id !== "number") {
			// A notification, or a server-to-client request. Neither is needed for
			// the questions this client asks.
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

	private send(payload: Record<string, unknown>): void {
		const body = JSON.stringify({ jsonrpc: "2.0", ...payload });
		const length = Buffer.byteLength(body, "utf8");
		this.child?.stdin.write(`Content-Length: ${length}${HEADER_SEPARATOR}${body}`);
	}

	notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (this.failed) {
			return Promise.reject(this.failed);
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
	 * Tell the server about a file before asking about it.
	 *
	 * Every position-addressed request is against an open document, and a server
	 * asked about one it has never seen answers nothing at all. Sent once per
	 * file per session; the content is read fresh each time it is first opened.
	 */
	async openDocument(
		filePath: string,
		text: string,
		languageId: string,
	): Promise<void> {
		const uri = fileUri(filePath);
		if (this.openDocuments.has(uri)) {
			return;
		}
		this.openDocuments.add(uri);
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	/** A file that changed under us has to be re-sent, or answers go stale. */
	reopenDocument(filePath: string): void {
		this.openDocuments.delete(fileUri(filePath));
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
