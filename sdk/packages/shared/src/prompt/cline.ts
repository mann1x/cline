import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
import {
	markPromptEnvironment,
	PROMPT_ENVIRONMENT_REFERENCE,
} from "./environment";
import {
	DEFAULT_CLINE_SYSTEM_PROMPT,
	YOLO_CLINE_SYSTEM_PROMPT,
} from "./system";

const WORKSPACE_CONFIGURATION_MARKER = "# Workspace Configuration";

/**
 * Explains the <user_input mode="..."> wrapper and <mode_notice> elements the
 * runtime stamps on user messages (prepareTurnInput / formatUserInputBlock).
 * Every host that sends through the SDK runtime produces those tags, so every
 * host's system prompt must explain them: without this section the model has
 * no idea what the attribute means, and a mid-conversation mode switch is an
 * invisible system-prompt swap it cannot diff. Included for BOTH modes, since
 * after a switch the transcript still contains messages tagged with the other
 * mode.
 */
/**
 * That grep, sed and awk exist, said once to every template.
 *
 * They are described in their own tool sections, which reach the model as tool
 * schemas -- enough to use one it has already decided to use, and not enough to
 * make it think of one. The part of the prompt that decides WHICH tool gets
 * reached for is the system section, and that belongs to whichever family
 * template matched: measured across all ten shipped templates, awk is named in
 * the system section of none of them, and grep and sed only inside "never run
 * this through the shell" lists, which frames them as substitutes for something
 * forbidden rather than as tools worth choosing.
 *
 * What that cost, on pandorum session 1789276298025_l5yr9: asked to count
 * braces, the model reached for PowerShell (it failed on a binding error), and
 * found the awk tool ninety-eight messages later.
 *
 * It rides in the rules slot because that is the one thing appended to every
 * template, including one that never mentions these tools and one that forgets
 * the marker entirely. A family template can then say more; none of them has to
 * say this.
 */
export const POSIX_TOOL_AVAILABILITY = `# grep, sed and awk

Three POSIX tools run inside this process, and they are available in their own
right rather than as substitutes for anything: use them when they fit the
question, not only when a shell command has been ruled out.

- grep searches files for lines matching a pattern, with grep's own flags, once
  you know which files to look in. search_codebase is still the tool for finding
  out WHERE something is; grep answers questions about a file you have already
  located.
- sed applies a script to one or more files. It prints the result by default,
  which is a safe way to check a script before trusting it, and rewrites the
  files when in_place is true.
- awk runs a program over one or more files and is the right tool for questions
  about columns, fields and totals -- summing a column, counting occurrences per
  key, extracting a field from delimited text. It cannot write, and that is
  enforced.

None of the three goes through the shell, so none needs anything installed and
all three behave the same on every platform.`;

export const MODE_TAG_INSTRUCTIONS = `# Plan / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode the user was in when they sent that message: "plan" means plan-mode constraints applied (explore, analyze, and align on a plan -- no edits or state-changing commands), while "act" (or "yolo") means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode is what governs right now, regardless of what earlier messages allowed. A <mode_notice> block inside a message marks exactly when such a switch happened.`;

/**
 * Plan-mode behavioral contract, appended when the session mode is "plan".
 * run_commands intentionally stays available in plan mode -- it is essential
 * for read-only investigation -- so the contract must spell out that it is
 * inspection-only there. Prompting is the first line of defense; the
 * plan-mode command-guard hook (registered by the core runtime builder for
 * plan-mode sessions) is the hard backstop that rejects file-editing
 * run_commands calls with a tool error before approval or execution.
 */
const PLAN_MODE_INSTRUCTIONS_BASE = `# Plan Mode

You are in Plan mode. Your role is to explore, analyze, and plan -- not to execute.

- Read files, search the codebase, and gather context to understand the problem
- Ask clarifying questions when requirements are ambiguous
- Present your plan as a structured outline with clear steps
- Explain tradeoffs between different approaches when they exist
- Do NOT edit files, write code, run destructive commands, or make any changes
- Do NOT implement anything -- focus on understanding and alignment first

The run_commands tool remains available in plan mode strictly for read-only inspection -- listing files, reading configs, inspecting git history and diffs, checking tool versions, and the like. Searching is not among them: search_codebase and grep are tools of their own and neither goes through the shell. Never use it to change anything: no creating, modifying, or deleting files, no writing scripts that make changes, and no state-changing commands (installs, migrations, database or schema changes, container commands that mutate state, etc.). File-editing commands (rm/mv/cp, in-place edits like sed -i, output redirection to files outside /tmp, git commands that change the working tree, package installs) are hard-blocked in plan mode: they are not executed and return a tool error instead, so do not attempt them. The sed tool is blocked the same way when in_place is true, and for the same reason; without it the tool only prints what the script would produce, which is read-only and allowed. If the task requires a mutation, put it in the plan; it happens only after the user switches to act mode.`;

export const PLAN_MODE_INSTRUCTIONS = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once the user has reviewed your plan and explicitly approved it in a follow-up message, use the switch_to_act_mode tool to switch to act mode and begin implementation. Calling switch_to_act_mode immediately starts execution, so never call it in the same turn you present a plan and never treat the original task request as approval -- end your turn after presenting the plan and wait for the user's response.`;

/**
 * Plan-mode contract for hosts that do NOT expose the switch_to_act_mode tool
 * (the VS Code extension, matching the legacy extension's behavior). The model
 * must direct the user to flip the Plan/Act toggle instead of calling a tool
 * that does not exist in its toolset.
 */
export const PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once you have presented your plan, end your turn and wait for the user's response. You do NOT have the ability to switch to act mode yourself -- the user must do it manually with the Plan/Act toggle once they are satisfied with the plan. If the task requires tools that are only available in act mode, ask the user to "toggle to Act mode" (use those words).`;

function redactRemoteUrlCredentials(remote: string): string {
	const schemeEnd = remote.indexOf("://");
	if (schemeEnd < 1) return remote;

	const authorityStart = schemeEnd + 3;
	let authorityEnd = authorityStart;
	while (authorityEnd < remote.length) {
		const char = remote[authorityEnd];
		if (
			char === "/" ||
			char === "?" ||
			char === "#" ||
			char.charCodeAt(0) <= 32
		) {
			break;
		}
		authorityEnd++;
	}

	const userInfoEnd = remote.lastIndexOf("@", authorityEnd - 1);
	if (userInfoEnd < authorityStart) return remote;
	return remote.slice(0, authorityStart) + remote.slice(userInfoEnd + 1);
}

export function processWorkspaceInfo(info: WorkspaceInfo): string {
	return JSON.stringify(
		{
			workspaces: {
				[info.rootPath]: {
					hint: info.hint,
					associatedRemoteUrls: info.associatedRemoteUrls?.map(
						redactRemoteUrlCredentials,
					),
					latestGitCommitHash: info.latestGitCommitHash,
					latestGitBranchName: info.latestGitBranchName,
				},
			},
		},
		null,
		2,
	);
}

function buildWorkspaceMetadata(
	rootPath: string,
	workspaceName?: string,
	metadata?: string,
): string {
	if (metadata?.trim()?.includes(WORKSPACE_CONFIGURATION_MARKER)) {
		return metadata.trim();
	}
	const body =
		metadata ||
		JSON.stringify(
			{
				workspaces: {
					[rootPath]: {
						hint: workspaceName || rootPath.split("/").at(-1) || rootPath,
					},
				},
			},
			null,
			2,
		);
	return `\n${WORKSPACE_CONFIGURATION_MARKER}\n${body}`;
}

/**
 * Options for building the Cline system prompt.
 *
 * Extends WorkspaceContext so callers can spread an ExtensionContext.workspace
 * directly. `workspaceRoot` is accepted as an alias for `rootPath` to support
 * existing call sites that set it explicitly.
 */
export interface ClineSystemPromptOptions
	extends Omit<WorkspaceContext, "rootPath"> {
	/**
	 * Workspace root path. Accepts either `rootPath` (from WorkspaceContext/WorkspaceInfo)
	 * or `workspaceRoot` (legacy alias) — whichever is provided will be used.
	 */
	rootPath?: string;
	/** Alias for rootPath — kept for backwards compatibility with existing call sites */
	workspaceRoot?: string;
	/** Per-request system prompt override */
	overridePrompt?: string;
	/**
	 * System prompt supplied by a matching prompt template, used in place of the
	 * built-in one.
	 *
	 * Distinct from `overridePrompt`, and deliberately so: an override is
	 * returned as the caller wrote it, with no substitution, because the caller
	 * is handing over a finished prompt. A template is not finished — it is the
	 * same kind of thing as the built-in prompt, written by hand, and it needs
	 * the same `{{CWD}}` / `{{CLINE_RULES}}` treatment. Routing templates
	 * through `overridePrompt` would deliver `{{CWD}}` to the model as literal
	 * text.
	 */
	basePrompt?: string;
	/** Provider ID — used to gate Cline-specific metadata injection */
	providerId?: string;
	/**
	 * Whether the host exposes the switch_to_act_mode tool in plan mode.
	 * Defaults to true (CLI behavior). Hosts that require the user to flip the
	 * Plan/Act toggle themselves (the VS Code extension) set this to false so
	 * the plan-mode contract directs the model to ask the user instead of
	 * calling a tool that is not in its toolset.
	 */
	planModeSwitchTool?: boolean;
	/**
	 * Carry the per-session values as marked spans instead of in place.
	 *
	 * For an engine that shares one prefix across sessions: the date, working
	 * directory, platform, IDE, the caller's rules, the mode contract and the
	 * workspace metadata are lifted into an `<environment>` turn by the
	 * provider, so the system turn is the same for every conversation. See
	 * `./environment.ts`. Off, the prompt is exactly what it always was.
	 */
	environmentTurn?: boolean;
}

export function buildClineSystemPrompt(
	options: ClineSystemPromptOptions,
): string {
	const {
		ide = "Terminal Shell",
		mode,
		platform = "unknown",
		workspaceName,
		metadata,
		rules,
		overridePrompt,
		providerId,
		planModeSwitchTool = true,
	} = options;
	const workspaceRoot = options.workspaceRoot ?? options.rootPath ?? "";
	const isCline = isClineProvider(providerId || "");

	if (overridePrompt?.trim()) {
		const trimmed = overridePrompt.trim();
		if (
			isCline &&
			metadata?.trim() &&
			!trimmed.includes(WORKSPACE_CONFIGURATION_MARKER)
		) {
			return `${trimmed}\n\n${buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)}`.trim();
		}
		return trimmed;
	}

	const templatePrompt = options.basePrompt?.trim();
	// A hand-written template that forgets `{{CLINE_RULES}}` would silently drop
	// the plan-mode contract and the mode-tag explanation — the model would stop
	// being told it is in plan mode, and nothing in the pipeline would say so.
	// Appending is the recoverable failure; losing them is not.
	const basePrompt = templatePrompt
		? templatePrompt.includes("{{CLINE_RULES}}")
			? templatePrompt
			: `${templatePrompt}\n\n{{CLINE_RULES}}`
		: mode === "yolo"
			? YOLO_CLINE_SYSTEM_PROMPT
			: DEFAULT_CLINE_SYSTEM_PROMPT;

	// Mode semantics ride in the rules slot so every host emits them without
	// composing its own copy. Order matches what the CLI historically built by
	// hand (caller rules, then the mode-tag explanation, then the plan-mode
	// contract), keeping CLI output byte-identical after the promotion.
	const modeContract =
		mode === "plan"
			? planModeSwitchTool
				? PLAN_MODE_INSTRUCTIONS
				: PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH
			: undefined;
	const effectiveRules = [
		rules,
		POSIX_TOOL_AVAILABILITY,
		MODE_TAG_INSTRUCTIONS,
		modeContract,
	]
		.filter(Boolean)
		.join("\n\n");

	if (options.environmentTurn) {
		// The static rules stay in place; everything that differs between
		// sessions -- or between turns, as the mode does -- becomes a span.
		const staticRules = [POSIX_TOOL_AVAILABILITY, MODE_TAG_INSTRUCTIONS].join(
			"\n\n",
		);
		const metadataBlock = isCline
			? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
			: "";
		const spans = [
			markPromptEnvironment("Platform", platform),
			markPromptEnvironment("Date", new Date().toLocaleDateString()),
			markPromptEnvironment("IDE", ide),
			markPromptEnvironment("Working Directory", workspaceRoot),
			markPromptEnvironment("Rules", rules),
			markPromptEnvironment("Mode", modeContract),
			markPromptEnvironment("Workspace", metadataBlock),
		].join("");
		const staticPrompt = basePrompt
			.replace("{{PLATFORM_NAME}}", PROMPT_ENVIRONMENT_REFERENCE)
			.replace("{{CWD}}", PROMPT_ENVIRONMENT_REFERENCE)
			.replace("{{CURRENT_DATE}}", PROMPT_ENVIRONMENT_REFERENCE)
			.replace("{{IDE_NAME}}", PROMPT_ENVIRONMENT_REFERENCE)
			.replace("{{CLINE_METADATA}}", "")
			.replace("{{CLINE_RULES}}", staticRules)
			.trim();
		return `${staticPrompt}\n\n${spans}`;
	}

	return basePrompt
		.replace("{{PLATFORM_NAME}}", platform)
		.replace("{{CWD}}", workspaceRoot)
		.replace("{{CURRENT_DATE}}", new Date().toLocaleDateString())
		.replace("{{IDE_NAME}}", ide)
		.replace(
			"{{CLINE_METADATA}}",
			isCline
				? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
				: "",
		)
		.replace("{{CLINE_RULES}}", effectiveRules)
		.trim();
}
