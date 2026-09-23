import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSubagentLayout,
	pinConversationHead,
	SUBAGENT_BASE_PROMPT,
} from "./subagent-layout";

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-layout-"));
	writeFileSync(
		join(dir, "game.html"),
		"<html>\n<script>let x = 1;</script>\n</html>\n",
	);
	return dir;
}

describe("a pooled sub-agent's layout", () => {
	// Each shared part is its own turn, in the order the pool tree nests.
	it("puts knowledge, role and task in separate turns under a fixed system prompt", async () => {
		const cwd = workspace();
		const layout = await buildSubagentLayout({
			instructions: "You are a js-brace-fixer.",
			task: "Check lines 1-3.",
			knowledge: { files: ["game.html"], text: "The game does not start." },
			pooled: true,
			cwd,
		});
		expect(layout.systemPrompt).toBe(SUBAGENT_BASE_PROMPT);
		expect(layout.layers).toBe(2);
		expect(layout.pinnedHead[0]).toContain("The game does not start.");
		// Inlined once, so no agent needs to read its own copy.
		expect(layout.pinnedHead[0]).toContain('<file path="game.html">');
		expect(layout.pinnedHead[0]).toContain("let x = 1;");
		expect(layout.pinnedHead[1]).toContain("js-brace-fixer");
		expect(layout.task).toContain("Check lines 1-3.");
		expect(layout.task).not.toContain("js-brace-fixer");
	});

	// A layer shares only if it is byte-identical across the agents given it.
	it("gives every agent with the same knowledge and role the same head", async () => {
		const cwd = workspace();
		const build = (task: string) =>
			buildSubagentLayout({
				instructions: "role",
				task,
				knowledge: { files: ["game.html"] },
				pooled: true,
				cwd,
			});
		const [first, second] = await Promise.all([build("a"), build("b")]);
		expect(first.pinnedHead).toEqual(second.pinnedHead);
		expect(first.task).not.toEqual(second.task);
	});

	it("names a file it cannot read instead of inlining nothing", async () => {
		const layout = await buildSubagentLayout({
			instructions: "role",
			task: "t",
			knowledge: { files: ["missing.txt"] },
			pooled: true,
			cwd: workspace(),
		});
		expect(layout.pinnedHead[0]).toContain("- missing.txt");
	});
});

describe("an unpooled sub-agent's layout", () => {
	// Nothing to dedupe against: the role stays the system prompt, and files
	// are passed by name for the agent to read with its tools.
	it("keeps the role as the system prompt and references files by name", async () => {
		const layout = await buildSubagentLayout({
			instructions: "You are a js-brace-fixer.",
			task: "Check lines 1-3.",
			knowledge: { files: ["game.html"] },
			pooled: false,
			cwd: workspace(),
		});
		expect(layout.systemPrompt).toBe("You are a js-brace-fixer.");
		expect(layout.pinnedHead).toEqual([]);
		expect(layout.task).toContain("- game.html");
		expect(layout.task).not.toContain("let x = 1;");
		expect(layout.task).toContain("Check lines 1-3.");
	});

	it("is exactly the task when there is no knowledge", async () => {
		const layout = await buildSubagentLayout({
			instructions: "role",
			task: "just this",
			pooled: false,
		});
		expect(layout.task).toBe("just this");
	});
});

describe("the pinned head", () => {
	const turn = (text: string) => ({
		role: "user",
		content: [{ type: "text", text }],
	});

	// Compaction must never rewrite the head: it is the pool every later
	// request attaches to.
	it("hides the shared turns from compaction and restores them verbatim", async () => {
		let seen: unknown[] = [];
		const prepare = pinConversationHead(
			async (input: {
				messages: readonly unknown[];
				apiMessages?: readonly unknown[];
			}) => {
				seen = [...input.messages];
				return { messages: [turn("summary")] };
			},
			["K", "R"],
		);
		const result = await prepare?.({
			messages: [turn("K"), turn("R"), turn("task"), turn("work")],
			apiMessages: [turn("K"), turn("R"), turn("task"), turn("work")],
		});
		expect(seen).toEqual([turn("task"), turn("work")]);
		expect(result?.messages).toEqual([turn("K"), turn("R"), turn("summary")]);
	});

	it("passes a conversation whose head has already changed through untouched", async () => {
		let seen: unknown[] = [];
		const prepare = pinConversationHead(
			async (input: { messages: readonly unknown[] }) => {
				seen = [...input.messages];
				return undefined;
			},
			["K"],
		);
		await prepare?.({ messages: [turn("other"), turn("task")] });
		expect(seen).toEqual([turn("other"), turn("task")]);
	});
});
