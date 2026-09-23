import { describe, expect, it } from "vitest";
import { buildClineSystemPrompt } from "./cline";
import {
	flattenPromptEnvironment,
	hasPromptEnvironment,
	hoistPromptEnvironment,
	markPromptEnvironment,
} from "./environment";

describe("environment spans", () => {
	it("lift out of the text into one block, in order", () => {
		const text = `Static head.\n\n${markPromptEnvironment("Date", "9/23/2026")}Static tail.${markPromptEnvironment("Rules", "Use tabs.")}`;
		const hoisted = hoistPromptEnvironment(text);
		expect(hoisted?.system).toBe("Static head.\n\nStatic tail.");
		expect(hoisted?.environment).toBe(
			"<environment>\n## Date\n9/23/2026\n\n## Rules\nUse tabs.\n</environment>",
		);
	});

	it("mark nothing for an empty value", () => {
		expect(markPromptEnvironment("Rules", "  ")).toBe("");
		expect(markPromptEnvironment("Rules", undefined)).toBe("");
	});

	it("flatten to the static text followed by the block", () => {
		const text = `Head.${markPromptEnvironment("IDE", "VS Code")}`;
		expect(flattenPromptEnvironment(text)).toBe(
			"Head.\n\n<environment>\n## IDE\nVS Code\n</environment>",
		);
		expect(flattenPromptEnvironment("plain")).toBe("plain");
		expect(hoistPromptEnvironment("plain")).toBeUndefined();
	});
});

describe("a system prompt built with an environment turn", () => {
	const build = (cwd: string, rules?: string, mode: "act" | "plan" = "act") =>
		buildClineSystemPrompt({
			ide: "VS Code",
			workspaceRoot: cwd,
			platform: "win32",
			providerId: "opencoti",
			mode,
			...(rules ? { rules } : {}),
			environmentTurn: true,
		});

	// The whole point: two conversations in different workspaces, with
	// different rules and modes, open with the same system turn.
	it("has the same static text for every session", () => {
		const one = hoistPromptEnvironment(build("c:/work/one", "Use tabs."));
		const two = hoistPromptEnvironment(build("d:/other", undefined, "plan"));
		expect(one?.system).toBe(two?.system);
		expect(one?.system).not.toContain("c:/work/one");
		expect(one?.system).not.toContain("Use tabs.");
		expect(one?.system).toContain("Working Directory: see <environment>");
	});

	it("carries every per-session value in the environment", () => {
		const hoisted = hoistPromptEnvironment(
			build("c:/work/one", "Use tabs.", "plan"),
		);
		expect(hoisted?.environment).toContain("## Working Directory\nc:/work/one");
		expect(hoisted?.environment).toContain("## Platform\nwin32");
		expect(hoisted?.environment).toContain("## Rules\nUse tabs.");
		expect(hoisted?.environment).toContain("## Mode");
	});

	it("reads as one prompt when a provider does not split it", () => {
		const flat = flattenPromptEnvironment(build("c:/work/one"));
		expect(hasPromptEnvironment(flat)).toBe(false);
		expect(flat).toContain("<environment>");
		expect(flat).toContain("c:/work/one");
	});

	it("is unchanged without the option", () => {
		const plain = buildClineSystemPrompt({
			workspaceRoot: "c:/work/one",
			providerId: "opencoti",
		});
		expect(hasPromptEnvironment(plain)).toBe(false);
		expect(plain).toContain("Working Directory: c:/work/one");
	});
});
