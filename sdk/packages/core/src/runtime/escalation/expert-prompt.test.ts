import { describe, expect, it } from "vitest";
import { buildExpertPrompt } from "./expert-prompt";

describe("buildExpertPrompt", () => {
	// Who it is talking to is the whole difference between this and every other
	// prompt in the product. A model that believes it is answering a user writes
	// an explanation and stops; this one is expected to do the work.
	it("says the caller is a model, not a user, and that the work is the deliverable", () => {
		const prompt = buildExpertPrompt({});

		expect(prompt).toMatch(/model/i);
		expect(prompt).toMatch(/not a user|is not a user/i);
	});

	// It has the same tools and the same workspace. Said explicitly because the
	// alternative reading -- that it is being asked for advice -- produces a
	// paragraph of guidance and no edit, which is the failure mode a cheap
	// second opinion already had before this feature existed.
	it("grants edit rights and says the approval rules are the session's own", () => {
		const prompt = buildExpertPrompt({});

		expect(prompt).toMatch(/edit/i);
		expect(prompt).toMatch(/approval|approve/i);
	});

	// The exchange is multi-turn on purpose. An expert that treats a pushback as
	// a fresh question restates its first answer; one that treats it as a review
	// answers the objection.
	it("says the caller will check the work and push back", () => {
		const prompt = buildExpertPrompt({});

		expect(prompt).toMatch(/push back|pushes back|challenge/i);
	});

	// A cloud expert is metered. It does not need to be told to be terse -- that
	// costs correctness -- but it does need to be told not to spend the budget
	// re-reading what it was already given.
	it("tells it not to re-derive what the brief already carries", () => {
		const prompt = buildExpertPrompt({});

		expect(prompt).toMatch(/brief/i);
	});

	// The workspace root, where the host knows it. Without it a model with file
	// tools guesses at paths on its first call.
	it("names the workspace root when it is known", () => {
		const prompt = buildExpertPrompt({ workspaceRoot: "/work/manic" });

		expect(prompt).toContain("/work/manic");
	});

	// Host instructions -- a project's own rules, the ones the base model is
	// working under. An expert editing the same files under different rules
	// produces a change the base model then has to undo.
	it("carries the session's own instructions when the host supplies them", () => {
		const prompt = buildExpertPrompt({
			sessionInstructions: "Never edit files under vendor/.",
		});

		expect(prompt).toContain("Never edit files under vendor/.");
	});

	it("emits nothing about instructions when the host supplies none", () => {
		const prompt = buildExpertPrompt({});

		expect(prompt).not.toContain("undefined");
		expect(prompt.trim()).toBe(prompt.trim().replace(/\n{3,}/g, "\n\n"));
	});
});
