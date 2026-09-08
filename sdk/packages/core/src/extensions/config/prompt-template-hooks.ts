import type {
	AgentHooks,
	AgentToolDefinition,
	RenderedPromptTemplate,
} from "@cline/shared";
import { applyPromptTemplateToTools } from "@cline/shared";

/**
 * Put a session's rendered template on every model request.
 *
 * Two things are deliberately *not* happening here. Nothing is resolved: which
 * template governs this session, and how it layers over `default.md`, was
 * settled once by `renderPromptTemplate` when the session started, and this
 * hook only carries the answer. And nothing is recomputed per request: the
 * rewritten tool list is memoised against the list it was built from, so a
 * fifty-turn conversation does the work once.
 *
 * `beforeModel` is still the seam, because it is the only one that sees every
 * tool. Builtin tools are constructed in core, MCP tools arrive from a hub and
 * the VS Code host injects its own; there is no single construction site to
 * patch, but they all converge on `request.tools`.
 */

export interface PromptTemplateHooksOptions {
	/** The session's rendered template, from `renderPromptTemplate`. */
	rendered: RenderedPromptTemplate | undefined;
	/**
	 * What this host is called — the same string the system prompt puts after
	 * `IDE:`, so `{{IDE_NAME}}` means one thing across the whole prompt.
	 *
	 * A host that omits it gets `the editor` in the descriptions that use the
	 * token. That is a wording default, not a behavioural one, which is why it
	 * is not required.
	 */
	ideName?: string;
}

export function createPromptTemplateHooks(
	options: PromptTemplateHooksOptions,
): AgentHooks | undefined {
	const { rendered, ideName } = options;
	if (!rendered || Object.keys(rendered.tools).length === 0) {
		// No templates on disk at all. Every other case — including a template
		// that overrides nothing — still carries `default.md`'s descriptions and
		// must go through the hook, or `default.md` would only apply to the
		// sessions that happened not to match anything else.
		return undefined;
	}

	// Keyed on the array the runtime hands us. The tool set is built once per
	// session and passed by reference on every turn, so this hits from the
	// second request onwards; a runtime that rebuilds the array simply
	// recomputes, which is correct either way. Weak so a finished session's
	// tools can be collected.
	const cache = new WeakMap<object, AgentToolDefinition[]>();

	return {
		beforeModel: async (context) => {
			const tools = context.request.tools;
			if (!tools || tools.length === 0) {
				return undefined;
			}
			const cached = cache.get(tools);
			if (cached) {
				return { tools: cached };
			}
			const rewritten = applyPromptTemplateToTools(tools, rendered, {
				ideName,
			}).map((tool) => ({
				...tool,
				// `AgentToolDefinition.description` is required while the shared
				// helper is generic over an optional one; this only bridges the
				// type boundary.
				description: tool.description ?? "",
			}));
			cache.set(tools, rewritten);
			return { tools: rewritten };
		},
	};
}
