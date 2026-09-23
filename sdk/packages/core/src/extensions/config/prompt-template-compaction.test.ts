import { describe, expect, it } from "vitest";
import {
	auditCompactionSections,
	BUILTIN_COMPACTION_PROMPTS,
	buildCompactionTranslationRequest,
	NEAR_COPY_SIMILARITY,
	resolveCompactionPromptSources,
	stripCompactionSections,
	wordSimilarity,
} from "./prompt-template-compaction";
import { parsePromptTemplate } from "./prompt-template-parser";
import { generatePromptTemplate } from "./prompt-template-review";

const CRITIC =
	"You own the {{half}} half; the {{other_half}} half is someone else's. Stay near {{half_length}} characters. Keep every path, every error, every decision.";

const TEMPLATE = (compaction: string) =>
	[
		"---",
		"name: sample",
		"match:",
		'  family: ["sample*"]',
		"---",
		"",
		"# system",
		"",
		"System words.",
		"",
		"# tool: grep",
		"",
		"Grep words.",
		"",
		compaction,
	].join("\n");

describe("the compaction sources", () => {
	it("are the user's prompt where set and the built-in one elsewhere", () => {
		const sources = resolveCompactionPromptSources({
			"council-critic": "  mine  ",
			replay: "   ",
		});
		expect(sources["council-critic"]).toBe("mine");
		expect(sources.replay).toBe(BUILTIN_COMPACTION_PROMPTS.replay);
		expect(Object.keys(sources)).toHaveLength(6);
	});

	it("ask for nothing when none are given", () => {
		expect(buildCompactionTranslationRequest({})).toBe("");
		const asked = buildCompactionTranslationRequest({
			"council-critic": CRITIC,
		});
		expect(asked).toContain("=== council-critic ===");
		expect(asked).toContain(CRITIC);
		expect(asked).not.toContain("=== replay ===");
	});
});

describe("auditing a translated compaction prompt", () => {
	const sources = { "council-critic": CRITIC };

	it("passes a rewrite that keeps the placeholders and most of the length", () => {
		const result = auditCompactionSections(
			{
				"council-critic":
					"Rewrite the {{half}} half only; {{other_half}} belongs to another writer. Aim for {{half_length}} characters and keep every path and error.",
			},
			sources,
		);
		expect(result.problems).toEqual([]);
		expect(result.failing.size).toBe(0);
	});

	it("fails a dropped placeholder, naming it", () => {
		const result = auditCompactionSections(
			{
				"council-critic":
					"Rewrite the {{half}} half only; the other one belongs to another writer. Keep every path, every error and every decision you made.",
			},
			sources,
		);
		expect([...result.failing]).toEqual(["council-critic"]);
		expect(result.problems.join("\n")).toContain("`{{other_half}}`");
	});

	it("fails a collapse, however well it reads", () => {
		const result = auditCompactionSections(
			{ "council-critic": "{{half}} {{other_half}} {{half_length}}" },
			sources,
		);
		expect(result.problems.join("\n")).toContain("under half the length");
	});

	it("fails a section that is missing, and one nobody asked for", () => {
		const result = auditCompactionSections(
			{ replay: "x".repeat(500) },
			sources,
		);
		expect([...result.failing].sort()).toEqual(["council-critic", "replay"]);
	});
});

describe("a copy that is not quite a copy", () => {
	const LONG = Array.from(
		{ length: 12 },
		(_, i) =>
			`Rule ${i}: keep every path, every error and every decision made in step ${i}.`,
	).join(" ");

	// qwen3.5:397b, 2026-09-23: "being deleted" became "being deleting".
	it("reads a one-word change as unchanged", () => {
		const result = auditCompactionSections(
			{
				replay: LONG.replace(
					"every decision made in step 3",
					"every decisions made in step 3",
				),
			},
			{ replay: LONG },
		);
		expect([...result.unchanged]).toEqual(["replay"]);
		expect(result.problems).toEqual([]);
	});

	// glm-5.3-flash, 2026-09-23: one block moved up, nothing else.
	it("reads the same sentences in another order as unchanged", () => {
		const sentences = LONG.split(/(?<=\.)\s+/);
		const moved = [
			sentences[5],
			...sentences.slice(0, 5),
			...sentences.slice(6),
		].join(" ");
		expect(wordSimilarity(moved, LONG)).toBeLessThan(NEAR_COPY_SIMILARITY);
		expect([
			...auditCompactionSections({ replay: moved }, { replay: LONG }).unchanged,
		]).toEqual(["replay"]);
	});

	it("keeps a rewrite that restates the rules", () => {
		const restated = LONG.replace(
			/keep every path, every error and every decision made in/g,
			"hold on to the paths, errors and decisions of",
		);
		const result = auditCompactionSections(
			{ replay: restated },
			{ replay: LONG },
		);
		expect(result.unchanged.size).toBe(0);
		expect(result.failing.size).toBe(0);
	});
});

describe("stripping compaction sections", () => {
	it("removes only the named ones and leaves the rest of the file alone", () => {
		const raw = TEMPLATE(
			"# compaction: council-critic\n\nCritic.\n\n# compaction: replay\n\nReplay.\n",
		);
		const stripped = stripCompactionSections(raw, new Set(["council-critic"]));
		expect(stripped).not.toContain("Critic.");
		expect(stripped).toContain("# compaction: replay\n\nReplay.");
		expect(stripped).toContain(
			"# tool: grep\n\nGrep words.\n\n# compaction: replay",
		);
		const parsed = parsePromptTemplate({
			raw: stripped,
			source: "global",
			fileName: "s.md",
		});
		expect(parsed.template?.compaction).toEqual({ replay: "Replay." });
	});
});

describe("the generator with compaction prompts", () => {
	const run = (reply: string, compactionPrompts?: Record<string, string>) =>
		generatePromptTemplate({
			defaultTemplate: TEMPLATE(""),
			providerId: "ollama",
			modelId: "sample:cloud",
			family: "sample",
			knownToolNames: ["grep"],
			attempts: 1,
			fileName: "sample.md",
			...(compactionPrompts ? { compactionPrompts } : {}),
			complete: async (messages) => {
				seen.push(messages[0]?.content ?? "");
				return reply;
			},
		});
	let seen: string[] = [];

	it("asks for them, keeps a good one and reports it", async () => {
		seen = [];
		const good =
			"Rewrite the {{half}} half only; {{other_half}} belongs to another writer. Aim for {{half_length}} characters and keep every path and error.";
		const result = await run(
			TEMPLATE(`# compaction: council-critic\n\n${good}\n`),
			{
				"council-critic": CRITIC,
			},
		);
		expect(seen[0]).toContain("# compaction: <id>");
		expect(result.compaction).toEqual({
			kept: ["council-critic"],
			removed: [],
			unchanged: [],
		});
		expect(result.raw).toContain(good);
	});

	// The one outcome that must never happen is a broken compaction prompt
	// written to disk as the best attempt.
	it("removes one that still fails, and says so", async () => {
		const result = await run(
			TEMPLATE("# compaction: council-critic\n\nShort {{half}}.\n"),
			{ "council-critic": CRITIC },
		);
		expect(result.raw).not.toContain("# compaction:");
		expect(result.compaction).toEqual({
			kept: [],
			removed: ["council-critic"],
			unchanged: [],
		});
		expect(result.audit.template?.compaction).toBeUndefined();
		expect(result.audit.problems.join("\n")).toContain(
			"Removed '# compaction: council-critic'",
		);
	});

	// Measured on qwen3.5:397b-cloud, 2026-09-23: all six came back
	// byte-identical. Kept, they would freeze today's built-in text into the
	// template and stop following it.
	it("leaves a verbatim copy out of the file, without calling it a failure", async () => {
		const result = await run(
			TEMPLATE(`# compaction: council-critic\n\n${CRITIC}\n`),
			{ "council-critic": CRITIC },
		);
		expect(result.raw).not.toContain("# compaction:");
		expect(result.compaction).toEqual({
			kept: [],
			removed: [],
			unchanged: ["council-critic"],
		});
		expect(result.audit.problems.join("\n")).not.toContain("compaction");
	});

	it("does not ask, and strips any it is sent, when not opted in", async () => {
		seen = [];
		const result = await run(
			TEMPLATE(`# compaction: replay\n\n${"Keep everything. ".repeat(40)}\n`),
		);
		expect(seen[0]).not.toContain("# compaction: <id>");
		expect(result.raw).not.toContain("# compaction:");
		expect(result.compaction).toBeUndefined();
	});

	it("refuses to combine them with a section rewrite", async () => {
		await expect(
			generatePromptTemplate({
				defaultTemplate: TEMPLATE(""),
				familyTemplate: TEMPLATE(""),
				providerId: "ollama",
				modelId: "sample:cloud",
				knownToolNames: ["grep"],
				onlyTools: ["grep"],
				compactionPrompts: { "council-critic": CRITIC },
				complete: async () => "",
			}),
		).rejects.toThrow("cannot also translate");
	});
});
