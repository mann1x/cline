import type { Message } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	agentMessagesToMessages,
	messagesToAgentMessages,
} from "../../runtime/config/agent-message-codec";
import { MessageBuilder } from "./message-builder";

// Faithful replay of the measured session: read whole file -> edit -> read
// whole file -> edit ... with the file's content CHANGING every time, because
// the edits in between actually change it.
function turn(n: number, body: string): Message[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: `read_${n}`,
					name: "read_files",
					input: { files: [{ path: "manic_miner.html" }] },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `read_${n}`,
					name: "read_files",
					content: JSON.stringify([
						{ query: "manic_miner.html", result: body, success: true },
					]),
				},
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: `edit_${n}`,
					name: "editor",
					input: {
						path: "manic_miner.html",
						start_line: 94,
						end_line: 96,
						new_text: "x",
					},
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `edit_${n}`,
					name: "editor",
					content: JSON.stringify([
						{
							query: "edit:manic_miner.html",
							result: `Replaced lines 94-96 (rev ${n})`,
							success: true,
						},
					]),
				},
			],
		},
	];
}

function countFullCopies(built: Message[]): number {
	let copies = 0;
	for (const m of built) {
		if (!Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if ((b as { type: string }).type !== "tool_result") continue;
			const c = (b as { content: unknown }).content;
			if (typeof c === "string" && c.length > 10_000) copies++;
		}
	}
	return copies;
}

describe("repeated whole-file reads with edits in between", () => {
	it("collapses superseded copies even though the file changed each time", () => {
		const messages: Message[] = [];
		// Each read returns DIFFERENT bytes — the edits changed the file.
		for (let i = 0; i < 12; i++)
			messages.push(...turn(i, `rev${i}-${"X".repeat(15_000)}`));

		const builder = new MessageBuilder();
		const roundTripped = agentMessagesToMessages(
			messagesToAgentMessages(messages) as never,
		) as Message[];
		const built = builder.buildForApi(roundTripped) as Message[];

		const copies = countFullCopies(built);
		const placeholders = (JSON.stringify(built).match(/outdated/g) || [])
			.length;
		console.log(`full copies still present: ${copies} of 12`);
		console.log(`outdated placeholders    : ${placeholders}`);
		console.log(
			`total built chars        : ${JSON.stringify(built).length.toLocaleString()}`,
		);

		expect(copies).toBe(1);
	});
});
