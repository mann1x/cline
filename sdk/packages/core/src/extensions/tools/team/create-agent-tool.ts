/**
 * `create_agent` -- the model writes an agent file.
 *
 * "Create an agent for software engineering and one for network
 * troubleshooting" is a reasonable thing to ask for and, until this tool, an
 * impossible one: the format is documented nowhere the model can read, the
 * directory is not somewhere it would guess, and the VS Code editor that knows
 * both is reachable only by a human with a mouse.
 *
 * A tool rather than a skill because skills have to be installed by hand --
 * `resolveSkillsConfigSearchPaths` looks only in the workspace and the Cline
 * data directory -- so a skill that teaches this would need the user to already
 * know the thing it was going to tell them.
 */

import { access } from "node:fs/promises";
import { type AgentTool, createTool, zodToJsonSchema } from "@cline/shared";
import { resolveAgentConfigSearchPaths } from "@cline/shared/storage";
import { z } from "zod";
import { type AgentFileFields, writeAgentFile } from "./agent-file";

const CreateAgentInputSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1)
		.describe(
			"Short identifier for the agent, e.g. 'network-troubleshooting'. Becomes the file name and the name the lead model refers to it by.",
		),
	description: z
		.string()
		.trim()
		.min(1)
		.describe(
			"One line saying what this agent is for. This is the only thing read when choosing which agent to hand work to, so say when to use it, not just what it is.",
		),
	systemPrompt: z
		.string()
		.trim()
		.min(1)
		.describe(
			"The agent's own system prompt: who it is, how it works, what it must not do. Written to the body of the file.",
		),
	scope: z
		.enum(["workspace", "global"])
		.optional()
		.describe(
			"'workspace' writes to .cline/agents in this project (default); 'global' writes to the Cline data directory so every project sees it.",
		),
	profile: z
		.string()
		.trim()
		.optional()
		.describe(
			"A saved API configuration profile the agent runs on, by name. Use this to run an agent on a different model from the session's.",
		),
	providerId: z.string().trim().optional(),
	modelId: z.string().trim().optional(),
	tools: z
		.array(z.string())
		.optional()
		.describe(
			"Restrict the agent to these tools. Omit to give it the session's toolset.",
		),
	skills: z
		.array(z.string())
		.optional()
		.describe(
			"Restrict the agent to these skills, by name. Omit to give it all of them.",
		),
	maxIterations: z.number().int().positive().optional(),
	overwrite: z
		.boolean()
		.optional()
		.describe(
			"Replace an agent of the same name. Without this, an existing agent is left alone and an error says so.",
		),
});

export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export interface CreateAgentOutput {
	path: string;
	name: string;
	scope: "workspace" | "global";
	overwritten: boolean;
	/** What the caller still has to do for the agent to be reachable. */
	note: string;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function createCreateAgentTool(options: {
	workspaceRoot?: string;
}): AgentTool {
	const tool = createTool<CreateAgentInput, CreateAgentOutput>({
		name: "create_agent",
		description:
			"Create a Cline agent the user can delegate work to. Agents are markdown files with YAML frontmatter; " +
			"each one becomes a subagent_<name> tool and can run on its own model. " +
			"Use this when the user asks for an agent, a specialist, or a helper for a kind of task.",
		inputSchema: zodToJsonSchema(CreateAgentInputSchema),
		execute: async (input) => {
			const scope = input.scope ?? "workspace";
			const searchPaths = resolveAgentConfigSearchPaths(options.workspaceRoot);
			// resolveAgentConfigSearchPaths puts the workspace directory first when
			// there is one, and the global directory last. With no workspace there
			// is only the global one, and asking for a workspace agent there would
			// write a "project" agent every project could see.
			const workspaceDirectory =
				options.workspaceRoot && searchPaths.length > 1
					? searchPaths[0]
					: undefined;
			const globalDirectory = searchPaths[searchPaths.length - 1];
			const directory =
				scope === "global" ? globalDirectory : workspaceDirectory;
			if (!directory) {
				throw new Error(
					"There is no workspace open, so a workspace agent has nowhere to go. Use scope 'global' instead.",
				);
			}

			const agent: AgentFileFields = {
				name: input.name,
				description: input.description,
				systemPrompt: input.systemPrompt,
				profile: input.profile,
				providerId: input.providerId,
				modelId: input.modelId,
				tools: input.tools,
				skills: input.skills,
				maxIterations: input.maxIterations,
			};
			const result = await writeAgentFile({
				directory,
				agent,
				overwrite: input.overwrite,
				fileExists,
			});
			return {
				path: result.path,
				name: input.name.trim(),
				scope,
				overwritten: result.overwritten,
				// Said plainly because the alternative is a model reporting success
				// and a user finding no new tool: agent files are read when a
				// session is built, so this one is not live yet.
				note: "Agent files are loaded when a session starts, so this agent becomes available in the next session rather than this one.",
			};
		},
		timeoutMs: 15000,
		retryable: false,
	});
	return tool as unknown as AgentTool;
}
