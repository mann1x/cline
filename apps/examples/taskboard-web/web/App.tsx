import { BoardViewer } from "@cline/ui/components/board-viewer";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ChatLine, DialogRequest, ServerMessage } from "../shared/wire";
import { Dialog } from "./Dialog";
import { connect } from "./socket";

interface ChatState {
	conversation: string;
	lines: ChatLine[];
	running: boolean;
	seeded: boolean;
	model: string;
}

interface Notice {
	id: number;
	level: "info" | "error";
	text: string;
}

const NOTICE_MS = 6000;

export function App() {
	// One connection for the page's lifetime; the Board tab's transport rides on it.
	const connection = useMemo(() => connect(), []);
	const [chat, setChat] = useState<ChatState>({
		conversation: "",
		lines: [],
		running: false,
		seeded: false,
		model: "",
	});
	const [streaming, setStreaming] = useState("");
	const [dialogs, setDialogs] = useState<({ id: number } & DialogRequest)[]>(
		[],
	);
	const [notices, setNotices] = useState<Notice[]>([]);
	const [draft, setDraft] = useState("");
	const log = useRef<HTMLOListElement>(null);

	useEffect(
		() =>
			connection.listen((message: ServerMessage) => {
				if (message.channel === "chat" && message.type === "state") {
					setChat(message);
					// A finished answer arrives as a line: the streamed text was its preview.
					if (!message.running) setStreaming("");
				} else if (message.channel === "chat" && message.type === "delta") {
					setStreaming((text) => text + message.text);
				} else if (message.channel === "dialog") {
					const { channel: _channel, ...request } = message;
					setDialogs((open) => [...open, request]);
				} else if (message.channel === "notice") {
					const notice = {
						id: Date.now() + Math.random(),
						level: message.level,
						text: message.text,
					};
					setNotices((shown) => [...shown, notice]);
					setTimeout(
						() =>
							setNotices((shown) =>
								shown.filter((entry) => entry.id !== notice.id),
							),
						NOTICE_MS,
					);
				}
			}),
		[connection],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: follows the log down when a line or streamed text arrives
	useEffect(() => {
		log.current?.lastElementChild?.scrollIntoView({ block: "end" });
	}, [chat.lines.length, streaming]);

	const send = (event: FormEvent) => {
		event.preventDefault();
		const text = draft.trim();
		if (!text || chat.running) return;
		setStreaming("");
		connection.send({ channel: "chat", type: "send", text });
		setDraft("");
	};

	const dialog = dialogs[0];

	return (
		<div className="app">
			<aside className="chat" aria-label="Conversation">
				<header className="chat-header">
					<div>
						<h1>Task board example</h1>
						<p className="muted">{chat.model}</p>
					</div>
					<button
						disabled={chat.running || !chat.conversation}
						onClick={() => connection.send({ channel: "chat", type: "new" })}
						type="button"
					>
						New conversation
					</button>
				</header>
				<ol className="chat-log" ref={log}>
					{chat.lines.length === 0 && !streaming && (
						<li className="chat-empty">
							{chat.seeded
								? "Your next message starts a conversation from the board you made."
								: "Ask for something that takes a few steps. The agent plans it on the board at the right, and you can change the plan there while it works."}
						</li>
					)}
					{chat.lines.map((line, index) => (
						<li
							className={`line line-${line.role}`}
							key={`${index}-${line.role}`}
						>
							{line.role === "tool" ? `→ ${line.text}` : line.text}
						</li>
					))}
					{streaming && (
						<li className="line line-assistant line-streaming">{streaming}</li>
					)}
				</ol>
				<form className="chat-input" onSubmit={send}>
					<textarea
						aria-label="Message"
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) send(event);
						}}
						placeholder="Message the agent"
						rows={3}
						value={draft}
					/>
					{chat.running ? (
						<button
							onClick={() => connection.send({ channel: "chat", type: "stop" })}
							type="button"
						>
							Stop
						</button>
					) : (
						<button className="primary" disabled={!draft.trim()} type="submit">
							Send
						</button>
					)}
				</form>
			</aside>
			<main className="board" aria-label="Board">
				<BoardViewer transport={connection.board} />
			</main>
			{notices.length > 0 && (
				<output className="notices">
					{notices.map((notice) => (
						<p className={`notice notice-${notice.level}`} key={notice.id}>
							{notice.text}
						</p>
					))}
				</output>
			)}
			{dialog && (
				<Dialog
					key={dialog.id}
					onAnswer={(answer) => {
						connection.send({ channel: "dialog", id: dialog.id, answer });
						setDialogs((open) => open.slice(1));
					}}
					request={dialog}
				/>
			)}
		</div>
	);
}
