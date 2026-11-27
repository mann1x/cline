/**
 * The page's one connection to the server, and the Board tab's transport
 * over it: the tab sends its requests on the `board` channel and hears only
 * that channel's messages.
 */

import type { BoardViewerTransport } from "@cline/ui/components/board-viewer";
import type { ClientMessage, ServerMessage } from "../shared/wire";

type Listener = (message: ServerMessage) => void;

export interface Connection {
	send(message: ClientMessage): void;
	listen(listener: Listener): () => void;
	/** The Board tab's side of it. */
	board: BoardViewerTransport;
}

export function connect(): Connection {
	const listeners = new Set<Listener>();
	const queue: string[] = [];
	const url = new URL("/socket", location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url);
	socket.addEventListener("open", () => {
		for (const raw of queue.splice(0)) socket.send(raw);
	});
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as ServerMessage;
		for (const listener of listeners) listener(message);
	});

	const send = (message: ClientMessage) => {
		const raw = JSON.stringify(message);
		if (socket.readyState === WebSocket.OPEN) socket.send(raw);
		else queue.push(raw);
	};
	const listen = (listener: Listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		send,
		listen,
		board: {
			send: (request) => send({ channel: "board", message: request }),
			subscribe: (listener) =>
				listen((message) => {
					if (message.channel === "board") listener(message.message);
				}),
		},
	};
}
