import { describe, expect, it } from "vitest";
import {
	getCoreBuiltinToolCatalog,
	getCoreDefaultEnabledToolIds,
	getCoreHeadlessToolNames,
	resolveCoreSelectedToolIds,
} from "./runtime";

describe("builtin tool catalog", () => {
	it("includes spawn and teams entries", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(catalog.some((entry) => entry.id === "spawn_agent")).toBe(true);
		expect(catalog.some((entry) => entry.id === "teams")).toBe(true);
	});

	it("includes the unified tasks tool outside yolo mode", () => {
		for (const mode of ["act", "plan"] as const) {
			const entry = getCoreBuiltinToolCatalog({ mode }).find(
				(candidate) => candidate.id === "tasks",
			);
			expect(entry).toMatchObject({
				defaultEnabled: true,
				headlessToolNames: ["tasks"],
			});
		}
		expect(
			getCoreBuiltinToolCatalog({ mode: "yolo" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
		expect(
			getCoreBuiltinToolCatalog({ mode: "act", clientType: "cli" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
		expect(
			getCoreBuiltinToolCatalog({ mode: "act", clientType: "vscode" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
	});

	it("marks teams enabled by default in act mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(catalog.find((entry) => entry.id === "teams")?.defaultEnabled).toBe(
			true,
		);
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(true);
	});

	it("marks teams and spawn disabled by default in yolo mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "yolo" });
		expect(catalog.find((entry) => entry.id === "teams")?.defaultEnabled).toBe(
			false,
		);
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(false);
	});

	it("expands grouped headless tool names for selected entries", () => {
		const names = getCoreHeadlessToolNames(new Set(["teams", "read_files"]), {
			mode: "act",
		});
		expect(names).toContain("read_files");
		expect(names).toContain("team_status");
		expect(names).toContain("team_run_task");
	});

	// The lead's tools over its agents came with the delegation work, and a
	// session selecting `spawn_agent` by name (the CLI's --tools, the hub's
	// toggles) left them all out: a background round nobody could collect.
	it("selects the lead's agent tools with spawn_agent, and the report tools with teams", () => {
		const lead = [
			"agents_status",
			"await_agents",
			"requeue_agent",
			"restart_agent",
			"resume_agent",
			"retry_failed",
			"message_agents",
			"stop_agents",
			"read_agent_report",
		];
		const spawn = getCoreHeadlessToolNames(new Set(["spawn_agent"]), {
			mode: "act",
		});
		expect(spawn).toEqual(expect.arrayContaining(["spawn_agent", ...lead]));
		const swarm = getCoreHeadlessToolNames(new Set(["spawn_swarm"]), {
			mode: "act",
		});
		expect(swarm).toEqual(expect.arrayContaining(["spawn_swarm", ...lead]));
		const teams = getCoreHeadlessToolNames(new Set(["teams"]), {
			mode: "act",
		});
		expect(teams).toEqual(
			expect.arrayContaining(["agents_status", "read_agent_report"]),
		);
		// Selected twice over, named once.
		const both = getCoreHeadlessToolNames(
			new Set(["spawn_agent", "spawn_swarm", "teams"]),
			{ mode: "act" },
		);
		expect(new Set(both).size).toBe(both.length);
	});

	it("uses a single editor catalog entry and maps to apply_patch when routed", () => {
		const actCatalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(actCatalog.some((entry) => entry.id === "apply_patch")).toBe(false);
		expect(
			actCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["editor"]);

		const gptCatalog = getCoreBuiltinToolCatalog({
			mode: "act",
			modelId: "openai/gpt-5.4",
			providerId: "openai",
		});
		expect(
			gptCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["apply_patch"]);
		expect(gptCatalog.some((entry) => entry.id === "submit_and_exit")).toBe(
			false,
		);
	});

	it("resolves default selected ids from the catalog", () => {
		const selected = resolveCoreSelectedToolIds({
			enabled: true,
			availabilityContext: { mode: "act" },
		});
		expect(selected.has("teams")).toBe(true);
		expect(selected.has("spawn_agent")).toBe(true);
		expect(getCoreDefaultEnabledToolIds({ mode: "act" })).toContain("teams");
	});

	it("surfaces native web search only for supported model selections", () => {
		const anthropic = getCoreBuiltinToolCatalog({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		expect(
			anthropic.find((entry) => entry.id === "web_search")?.defaultEnabled,
		).toBe(false);

		const enabled = getCoreBuiltinToolCatalog({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			enabledModelToolIds: new Set(["web_search"]),
		});
		expect(
			enabled.find((entry) => entry.id === "web_search")?.defaultEnabled,
		).toBe(true);

		const unsupported = getCoreBuiltinToolCatalog({
			providerId: "ollama",
			modelId: "llama3",
		});
		expect(unsupported.some((entry) => entry.id === "web_search")).toBe(false);
	});
});
