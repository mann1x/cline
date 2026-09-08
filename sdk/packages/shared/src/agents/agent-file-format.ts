/**
 * The agent-file format: one renderer, shared by everything that writes one.
 *
 * The VS Code agent editor writes these files, and so does the `create_agent`
 * tool a model calls when the user asks for an agent by name. The format is
 * small enough to hand-write and easy enough to get subtly wrong -- unquoted,
 * `description: Reviews code: carefully` is a YAML mapping and `yes` is a
 * boolean -- so both go through here.
 *
 * In `@cline/shared` rather than `@cline/core` because it is pure string work
 * with no filesystem in it, and because the VS Code unit-test harness shadows
 * `@cline/core` with a stub: a renderer that lived there could only ever be
 * tested against the stub from that side. Writing the file, which does touch
 * the filesystem, stays in core.
 */

/** Frontmatter keys in the order they are written, so files stay comparable. */
const FRONTMATTER_ORDER = [
	"name",
	"description",
	"profile",
	"providerId",
	"modelId",
	"tools",
	"skills",
	"maxIterations",
] as const;

export interface AgentFileFields {
	name: string;
	description: string;
	systemPrompt: string;
	profile?: string;
	providerId?: string;
	modelId?: string;
	tools?: readonly string[];
	skills?: readonly string[];
	maxIterations?: number;
}

/**
 * A YAML scalar that cannot be read as anything but the string it is.
 *
 * Always quoted rather than quoted-when-necessary. A description is free text
 * a user typed, and the shapes that change meaning unquoted are the ordinary
 * ones, so guessing which need it is a bug waiting for the right sentence.
 * Double quotes with the two escapes YAML defines for them.
 */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A file name that cannot escape the agents directory or collide with the
 * shell. The agent's `name` is the identity the model sees; this is only where
 * it is kept.
 */
export function agentFileName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug || "agent"}.md`;
}

export function renderAgentFile(agent: AgentFileFields): string {
	const frontmatter: Record<string, unknown> = {
		name: agent.name.trim(),
		description: agent.description.trim(),
	};
	if (agent.profile) frontmatter.profile = agent.profile;
	if (agent.providerId) frontmatter.providerId = agent.providerId;
	if (agent.modelId) frontmatter.modelId = agent.modelId;
	if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
	if (agent.skills && agent.skills.length > 0)
		frontmatter.skills = agent.skills;
	if (agent.maxIterations && agent.maxIterations > 0) {
		frontmatter.maxIterations = agent.maxIterations;
	}

	const lines = FRONTMATTER_ORDER.filter((key) => key in frontmatter).map(
		(key) => {
			const value = frontmatter[key];
			if (Array.isArray(value)) {
				return [
					`${key}:`,
					...value.map((entry) => `  - ${yamlString(String(entry))}`),
				].join("\n");
			}
			return typeof value === "number"
				? `${key}: ${value}`
				: `${key}: ${yamlString(String(value))}`;
		},
	);
	return `---\n${lines.join("\n")}\n---\n\n${agent.systemPrompt.trim()}\n`;
}

/**
 * What an agent file must have before it is worth writing.
 *
 * The description is checked as hard as the name because it is not decoration:
 * it is the only thing the lead model reads when deciding which agent to hand
 * work to, so an agent without one is an agent that never gets chosen.
 */
export function validateAgentFields(agent: AgentFileFields): void {
	if (!agent.name.trim()) {
		throw new Error("An agent needs a name.");
	}
	if (!agent.description.trim()) {
		throw new Error(
			"An agent needs a description: it is what the lead model reads when it chooses one.",
		);
	}
	if (!agent.systemPrompt.trim()) {
		throw new Error("An agent needs a prompt saying what it does.");
	}
}
