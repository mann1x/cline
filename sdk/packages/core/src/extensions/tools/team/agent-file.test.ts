import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	agentFileName,
	renderAgentFile,
	validateAgentFields,
	writeAgentFile,
} from "./agent-file";
import { loadConfiguredAgentConfigs } from "./configured-agent-config";

const base = {
	name: "network-troubleshooting",
	description: "Diagnoses network faults",
	systemPrompt: "You diagnose networks.",
};

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

describe("agentFileName", () => {
	it("slugs a name into something that cannot escape the directory", () => {
		expect(agentFileName("Network Troubleshooting")).toBe(
			"network-troubleshooting.md",
		);
		expect(agentFileName("../../etc/passwd")).toBe("etc-passwd.md");
		expect(agentFileName("  ??  ")).toBe("agent.md");
	});
});

describe("renderAgentFile", () => {
	it("quotes every scalar, so ordinary prose stays a string", () => {
		// Unquoted, `Reviews code: carefully` is a YAML mapping and `yes` is a
		// boolean -- both are things a person writes without thinking.
		const file = renderAgentFile({
			...base,
			description: "Reviews code: carefully",
		});
		expect(file).toContain('description: "Reviews code: carefully"');
	});

	it("escapes quotes and backslashes rather than breaking the block", () => {
		const file = renderAgentFile({
			...base,
			description: 'Handles "quoted" C:\\paths',
		});
		expect(file).toContain('description: "Handles \\"quoted\\" C:\\\\paths"');
	});

	it("omits every optional key that was not set", () => {
		const file = renderAgentFile(base);
		for (const key of ["profile", "providerId", "modelId", "tools", "skills"]) {
			expect(file).not.toContain(`${key}:`);
		}
	});

	it("round-trips through the loader that reads it", async () => {
		// The renderer and the parser are the two halves of one format, and a
		// file that only one of them accepts is the failure worth catching.
		const dir = await mkdtemp(join(tmpdir(), "agent-file-"));
		await writeFile(
			join(dir, "qa.md"),
			renderAgentFile({
				name: "qa",
				description: 'Runs QA: thoroughly, with "care"',
				systemPrompt: "You are QA.",
				profile: "local-qwen",
				skills: ["qa", "review"],
				maxIterations: 40,
			}),
			"utf-8",
		);
		const loaded = loadConfiguredAgentConfigs({ searchPaths: [dir] });
		expect(loaded.errors).toEqual([]);
		expect(loaded.configs[0]).toMatchObject({
			name: "qa",
			description: 'Runs QA: thoroughly, with "care"',
			profile: "local-qwen",
			skills: ["qa", "review"],
			maxIterations: 40,
		});
		expect(loaded.configs[0].systemPrompt.trim()).toBe("You are QA.");
	});
});

describe("validateAgentFields", () => {
	it("insists on a description, which is what picks the agent", () => {
		expect(() => validateAgentFields({ ...base, description: "  " })).toThrow(
			/description/,
		);
	});

	it("insists on a name and a prompt", () => {
		expect(() => validateAgentFields({ ...base, name: "" })).toThrow(/name/);
		expect(() => validateAgentFields({ ...base, systemPrompt: "" })).toThrow(
			/prompt/,
		);
	});
});

describe("writeAgentFile", () => {
	it("writes the file and reports where it went", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-write-"));
		const result = await writeAgentFile({
			directory: dir,
			agent: base,
			fileExists: exists,
		});
		expect(result.path).toBe(join(dir, "network-troubleshooting.md"));
		expect(result.overwritten).toBe(false);
		expect(await readFile(result.path, "utf-8")).toContain(
			"You diagnose networks.",
		);
	});

	it("creates the directory when it is not there yet", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "agent-mk-")), "agents");
		const result = await writeAgentFile({
			directory: dir,
			agent: base,
			fileExists: exists,
		});
		expect(await exists(result.path)).toBe(true);
	});

	it("refuses to replace an existing agent unless told to", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agent-clobber-"));
		await writeAgentFile({ directory: dir, agent: base, fileExists: exists });
		await expect(
			writeAgentFile({
				directory: dir,
				agent: { ...base, systemPrompt: "different" },
				fileExists: exists,
			}),
		).rejects.toThrow(/already exists/);

		// Asked twice, the second answer must not quietly discard what the user
		// tuned in the first.
		const kept = await readFile(
			join(dir, "network-troubleshooting.md"),
			"utf-8",
		);
		expect(kept).toContain("You diagnose networks.");

		const replaced = await writeAgentFile({
			directory: dir,
			agent: { ...base, systemPrompt: "different" },
			overwrite: true,
			fileExists: exists,
		});
		expect(replaced.overwritten).toBe(true);
		expect(await readFile(replaced.path, "utf-8")).toContain("different");
	});
});
