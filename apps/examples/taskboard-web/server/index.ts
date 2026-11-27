/**
 * The example's server: the agent, its task board, and the Board tab's
 * backend, for the page in `web/`.
 *
 *   bun run server/index.ts [workspace]
 *
 * Settings come from the environment: PROVIDER (default `ollama`), MODEL,
 * BASE_URL, API_KEY, PORT (default 3477). The workspace is the folder the
 * agent works in (default: the current one); its `.cerebriline/` holds the
 * pipelines, the conversations' board logs, drafts and saved boards.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	BOARD_VIEWER_DATA,
	type BoardBackend,
	createBoardBackend,
	EXPRESSION_FUNCTIONS,
	sessionBoardSlots,
	type TaskGraphSeed,
} from "@cline/taskboard";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "../shared/wire";
import { Conversation, type ModelSettings } from "./conversation";
import { type PageDialogs, pageDialogs } from "./dialogs";

const workspaceRoot = resolve(
	process.argv[2] ?? process.env.WORKSPACE ?? process.cwd(),
);
const logDir = join(workspaceRoot, ".cerebriline", "conversations");
const model: ModelSettings = {
	providerId: process.env.PROVIDER ?? "ollama",
	modelId: process.env.MODEL ?? "qwen3:8b",
	...(process.env.BASE_URL ? { baseUrl: process.env.BASE_URL } : {}),
	...(process.env.API_KEY ? { apiKey: process.env.API_KEY } : {}),
};
const port = Number(process.env.PORT ?? 3477);
const webRoot = resolve(import.meta.dir, "..", "dist", "web");

interface Page {
	socket: ServerWebSocket<unknown>;
	backend: BoardBackend;
	dialogs: PageDialogs;
}
const pages = new Set<Page>();

const sendTo = (page: Page, message: ServerMessage) =>
	page.socket.send(JSON.stringify(message));
const broadcast = (message: ServerMessage) => {
	for (const page of pages) sendTo(page, message);
};

// The conversation on screen. None until the person's first message: the
// Board tab can start the next conversation from a draft only while none is
// open, and its board is then handed to the conversation the message starts.
let conversation: Conversation | undefined;
let nextStart: { seed: TaskGraphSeed; onTaken: () => void } | undefined;

const boards = sessionBoardSlots({
	workspaceRoot: () => workspaceRoot,
	conversation: () =>
		conversation
			? { board: conversation.board, running: conversation.running }
			: undefined,
	logDir: () => logDir,
	startConversation: (seed, onTaken) => {
		nextStart = { seed, onTaken };
		broadcastChat();
	},
});

function startConversation(): Conversation {
	const start = nextStart;
	nextStart = undefined;
	const created = new Conversation({
		workspaceRoot,
		logDir,
		model,
		...(start ? { seed: start.seed } : {}),
		onChat: broadcastChat,
		onDelta: (text) => broadcast({ channel: "chat", type: "delta", text }),
		onBoard: boardChanged,
		requestApproval: async (request) => {
			const page = pages.values().next().value as Page | undefined;
			if (!page) return false;
			const answer = await page.dialogs.ui.confirm(
				`A pipeline step wants to run ${request.toolName}. Allow it?`,
				"Allow",
				"Deny",
			);
			return answer === "Allow";
		},
	});
	start?.onTaken();
	return created;
}

function broadcastChat(): void {
	broadcast({
		channel: "chat",
		type: "state",
		conversation: conversation?.id ?? "",
		lines: conversation?.lines ?? [],
		running: conversation?.running === true,
		seeded: nextStart !== undefined,
		model: `${model.providerId}/${model.modelId}`,
	});
}

/** Send a page the Board tab's data: at once from what is read, then fresh when the recent list was stale. */
async function sendBoard(page: Page): Promise<void> {
	const send = async (cachedOnly: boolean) => {
		const data = await page.backend.data({ cachedOnly });
		sendTo(page, {
			channel: "board",
			message: { type: BOARD_VIEWER_DATA, data },
		});
	};
	await send(true);
	if (!page.backend.recentIsFresh()) await send(false);
}

// Board changes come in bursts (a plan is several events): draw once per burst.
let boardTimer: ReturnType<typeof setTimeout> | undefined;
function boardChanged(): void {
	clearTimeout(boardTimer);
	boardTimer = setTimeout(() => {
		for (const page of pages) void sendBoard(page);
	}, 100);
}

async function receive(page: Page, message: ClientMessage): Promise<void> {
	switch (message.channel) {
		case "board": {
			const answer = await page.backend.handle(message.message);
			if (answer.reply)
				sendTo(page, { channel: "board", message: answer.reply });
			if (answer.ready) await sendBoard(page);
			else if (answer.refresh) boardChanged();
			return;
		}
		case "chat":
			if (message.type === "send" && message.text.trim()) {
				conversation ??= startConversation();
				broadcastChat();
				void conversation.send(message.text.trim());
			} else if (message.type === "new") {
				if (conversation?.running) {
					sendTo(page, {
						channel: "notice",
						level: "error",
						text: "Stop the agent first.",
					});
					return;
				}
				// The old conversation's board stays in its log: the Board tab lists it as recent.
				conversation = undefined;
				broadcastChat();
				boardChanged();
			} else if (message.type === "stop") {
				conversation?.stop();
			}
			return;
		case "dialog":
			page.dialogs.answer(message.id, message.answer);
			return;
	}
}

function staticFile(pathname: string): Response {
	const file = resolve(
		webRoot,
		`.${pathname === "/" ? "/index.html" : pathname}`,
	);
	if (
		!file.startsWith(webRoot + sep) ||
		!existsSync(file) ||
		!statSync(file).isFile()
	) {
		return existsSync(webRoot)
			? new Response("Not found", { status: 404 })
			: new Response("Build the page first: bun run build:web", {
					status: 503,
				});
	}
	return new Response(Bun.file(file));
}

const sockets = new WeakMap<ServerWebSocket<unknown>, Page>();

Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(request, server) {
		const url = new URL(request.url);
		if (url.pathname === "/socket") {
			return server.upgrade(request)
				? undefined
				: new Response("Upgrade failed", { status: 400 });
		}
		return staticFile(url.pathname);
	},
	websocket: {
		open(socket) {
			const page: Page = {
				socket,
				backend: undefined as never,
				dialogs: undefined as never,
			};
			page.dialogs = pageDialogs(
				(message) => sendTo(page, message),
				() => workspaceRoot,
			);
			page.backend = createBoardBackend({
				workspaceRoot: () => workspaceRoot,
				boards,
				ui: page.dialogs.ui,
				catalog: () => ({
					tools: ["list_files", "read_file", "write_to_file"],
					agents: [],
					functions: [...EXPRESSION_FUNCTIONS],
				}),
				runAction: (action) =>
					conversation?.board.pipelineControl?.act(action) ?? {
						ok: false,
						lines: [
							"Runs are acted on through the conversation that started them; open it first.",
						],
					},
				onError: (what, error) => console.error(`[board] ${what}:`, error),
			});
			pages.add(page);
			sockets.set(socket, page);
			broadcastChat();
		},
		message(socket, raw) {
			const page = sockets.get(socket);
			if (!page) return;
			let message: ClientMessage;
			try {
				message = JSON.parse(String(raw)) as ClientMessage;
			} catch {
				return;
			}
			receive(page, message).catch((error) => {
				console.error(error);
				sendTo(page, {
					channel: "notice",
					level: "error",
					text: String(error),
				});
			});
		},
		close(socket) {
			const page = sockets.get(socket);
			if (!page) return;
			page.dialogs.close();
			pages.delete(page);
		},
	},
});

console.log(`Task board example on http://127.0.0.1:${port}`);
console.log(`  workspace ${workspaceRoot}`);
console.log(
	`  model     ${model.providerId}/${model.modelId}${model.baseUrl ? ` at ${model.baseUrl}` : ""}`,
);
