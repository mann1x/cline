/**
 * What the page and the server say over their one WebSocket. Three channels:
 *
 * - `board`: the Board tab's own messages (`@cline/taskboard/protocol`),
 *   passed through untouched in both directions.
 * - `chat`: the conversation: what the person sends, what the agent says.
 * - `dialog`: the board backend asking the person something. A server
 *   cannot open a dialog, so it asks the page and waits for the answer.
 */

import type { ViewerRequest } from "@cline/taskboard/protocol";

export interface ChatLine {
	role: "user" | "assistant" | "tool" | "error";
	text: string;
}

export type DialogRequest =
	| {
			kind: "pick";
			placeholder: string;
			items: { label: string; description?: string; detail?: string }[];
	  }
	| {
			kind: "input";
			title?: string;
			prompt: string;
			value?: string;
			/** Why the last answer was refused. */
			error?: string;
	  }
	| { kind: "confirm"; question: string; buttons: string[] };

/** From the page. */
export type ClientMessage =
	| { channel: "board"; message: ViewerRequest }
	| { channel: "chat"; type: "send"; text: string }
	| { channel: "chat"; type: "new" }
	| { channel: "chat"; type: "stop" }
	/** `answer`: the picked index, the text, the button; null when dismissed. */
	| { channel: "dialog"; id: number; answer: number | string | null };

/** From the server. */
export type ServerMessage =
	| { channel: "board"; message: unknown }
	| {
			channel: "chat";
			type: "state";
			conversation: string;
			lines: ChatLine[];
			running: boolean;
			/** The next new conversation starts from a board the person made. */
			seeded: boolean;
			model: string;
	  }
	| { channel: "chat"; type: "delta"; text: string }
	| ({ channel: "dialog"; id: number } & DialogRequest)
	| { channel: "notice"; level: "info" | "error"; text: string };
