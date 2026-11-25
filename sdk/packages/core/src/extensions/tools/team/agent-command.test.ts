import { describe, expect, it } from "vitest";
import { isAgentCommand, planAgentCommand } from "./agent-command";

const context = {
	agents: [
		{ name: "reviewer", skills: ["review-website", "lint"] },
		{ name: "qa" },
	],
	skillNames: ["review-website", "lint", "deploy"],
	agentsEnabled: true,
};

describe("/agent", () => {
	it("recognises the command and nothing that only starts like it", () => {
		expect(isAgentCommand("/agent reviewer go")).toBe(true);
		expect(isAgentCommand("/agent")).toBe(true);
		expect(isAgentCommand("/agents list")).toBe(false);
		expect(isAgentCommand("run /agent")).toBe(false);
	});

	it("delegates to an agent named first, with the rest as its task", () => {
		expect(
			planAgentCommand(
				"/agent reviewer inspect the source code of the game",
				context,
			),
		).toEqual({
			kind: "delegate",
			agentName: "reviewer",
			prompt: "inspect the source code of the game",
		});
	});

	it("matches the agent's name in any case and uses its own spelling", () => {
		expect(planAgentCommand("/agent Reviewer go", context)).toMatchObject({
			kind: "delegate",
			agentName: "reviewer",
		});
	});

	it("hands an agent a skill it may load as its task", () => {
		expect(
			planAgentCommand("/agent reviewer /review-website", context),
		).toEqual({
			kind: "delegate",
			agentName: "reviewer",
			prompt: "/review-website",
		});
		// No skills list: every skill.
		expect(planAgentCommand("/agent qa /deploy now", context)).toMatchObject({
			kind: "delegate",
			prompt: "/deploy now",
		});
	});

	// Without this the agent gets `/deploy` as text, cannot load it, and
	// nothing says why.
	it("refuses a skill the agent's file does not allow, naming the ones it does", () => {
		const plan = planAgentCommand("/agent reviewer /deploy", context);
		expect(plan.kind).toBe("refused");
		expect(plan).toMatchObject({
			reason: expect.stringContaining(
				'cannot load the "deploy" skill: its agent file allows only "review-website", "lint"',
			),
		});
	});

	it("does not take a path at the start of a task for a skill", () => {
		expect(
			planAgentCommand("/agent reviewer /src/game.js has a bug", context),
		).toMatchObject({ kind: "delegate", prompt: "/src/game.js has a bug" });
	});

	it("refuses an agent with no task", () => {
		expect(planAgentCommand("/agent reviewer", context)).toMatchObject({
			kind: "refused",
			reason: expect.stringContaining('Say what the "reviewer" agent is to do'),
		});
		expect(planAgentCommand("/agent", context).kind).toBe("refused");
	});

	it("asks the lead to hand off free text, and keeps the text whole", () => {
		const plan = planAgentCommand(
			"/agent launch an agent to inspect the source code of the game",
			context,
		);
		expect(plan.kind).toBe("lead");
		expect(plan).toMatchObject({
			message: expect.stringMatching(
				/^Hand the following to an agent instead of doing it yourself.*\n\nlaunch an agent to inspect the source code of the game$/s,
			),
		});
	});

	// Named without the slash: `/deploy` in the lead's message reads as the
	// user invoking the skill there, and the lead would load it itself.
	it("asks the lead for an agent to run a skill named first", () => {
		for (const typed of [
			"/agent /deploy the staging stack",
			"/agent deploy the staging stack",
		]) {
			const plan = planAgentCommand(typed, context);
			expect(plan).toMatchObject({ kind: "lead" });
			const message = (plan as { message: string }).message;
			expect(message).toContain(
				'The agent is to load and follow the "deploy" skill.',
			);
			expect(message.endsWith("\n\nthe staging stack")).toBe(true);
			expect(message).not.toContain("/deploy");
		}
	});

	it("refuses to ask the lead for an agent when agents are off", () => {
		expect(
			planAgentCommand("/agent inspect the game", {
				...context,
				agentsEnabled: false,
			}),
		).toMatchObject({
			kind: "refused",
			reason: expect.stringContaining("Agents are turned off"),
		});
		// A named agent still runs: delegation is the user's say-so, and the
		// host refuses it on its own terms if the agent is unavailable.
		expect(
			planAgentCommand("/agent reviewer go", {
				...context,
				agentsEnabled: false,
			}),
		).toMatchObject({ kind: "delegate" });
	});
});
