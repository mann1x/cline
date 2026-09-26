import { describe, expect, it } from "vitest";
import { getShippedToolCallSignatures } from "./shipped-tool-signatures";

describe("the shipped tools' call signatures", () => {
	// A template generator audits its example calls against these; a tool
	// missing here is a tool whose examples nobody checks.
	it("include the lead's tools over its agents", () => {
		const names = getShippedToolCallSignatures().map(
			(signature) => signature.name,
		);
		expect(names).toEqual(
			expect.arrayContaining([
				"agents_status",
				"await_agents",
				"requeue_agent",
				"restart_agent",
				"resume_agent",
				"retry_failed",
				"message_agents",
				"stop_agents",
				"read_agent_report",
			]),
		);
	});
});
