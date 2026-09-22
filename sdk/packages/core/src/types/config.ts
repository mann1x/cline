import type { ModelInfo } from "@cline/llms";
import type {
	AgentConfig,
	AgentHooks,
	AgentMode,
	AgentTool,
	BasicLogger,
	ConsecutiveMistakeLimitContext,
	ConsecutiveMistakeLimitDecision,
	ExtensionContext,
	HookErrorMode,
	ITelemetryService,
	MessageWithMetadata,
	RenderedPromptTemplate,
	SessionExecutionConfig,
	SessionPromptConfig,
	SessionWorkspaceConfig,
} from "@cline/shared";
import type { CompactionRevisions } from "../extensions/context/compaction-revisions";
import type { ToolRoutingRule } from "../extensions/tools/model-tool-routing";
import type { QaCredential } from "../extensions/tools/qa-credentials";
import type { TaskProgressState } from "../extensions/tools/task-progress";
import type {
	AgentProfileConnection,
	AgentProviderConnection,
	TeamEvent,
} from "../extensions/tools/team";
import type { CheckApprover } from "../runtime/atomic/proposal";
import type { EscalationApproval } from "../runtime/escalation/escalation-session";
import type { StruggleThresholds } from "../runtime/safety/struggle-detector";
import type { ProviderConfig } from "./provider-settings";

export type CoreAgentMode = AgentMode;

export interface CoreModelConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	providerConfig?: ProviderConfig;
	knownModels?: Record<string, ModelInfo>;
	/**
	 * Request model-side thinking/reasoning when supported.
	 */
	thinking?: boolean;
	/**
	 * Explicit reasoning effort override for capable models.
	 */
	reasoningEffort?: ProviderConfig["reasoningEffort"];
	/**
	 * Explicit thinking/reasoning token budget for capable models.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Maximum output tokens per API call.
	 */
	maxTokensPerTurn?: number;
	/**
	 * How much of one tool result reaches the provider before the message
	 * builder middle-truncates it. Omit for the built-in default.
	 */
	maxToolResultChars?: number;
	/**
	 * Sampling temperature per API call.
	 */
	temperature?: number;
}

/**
 * A connection for delegated agents that is not the session's own.
 *
 * Subagents and teammates inherit the lead's whole connection — provider,
 * model, sampler, and the context window with it. That is the right default and
 * the wrong only option: it leaves no way to run a team of small agents under a
 * strong lead, and no way to give them a window sized for the narrower job.
 *
 * Deliberately only the connection: which model to call, where, and with what
 * provider settings. Everything else about a delegated agent — its tools, its
 * prompt, its iteration cap — still comes from the session that spawned it. And
 * only the fields actually set are taken, so an override naming a model and
 * nothing else keeps the session's sampler and thinking budget.
 */
export type DelegatedAgentConnectionOverride = Pick<
	CoreModelConfig,
	| "providerId"
	| "modelId"
	| "apiKey"
	| "baseUrl"
	| "headers"
	| "providerConfig"
	| "knownModels"
	// Not a connection field, and taken anyway: the cap is read against a
	// context window, and an Agents tab that names a window of its own has
	// named a different budget with it. Absent, agents keep the session's.
	| "maxToolResultChars"
>;

/**
 * A second, costlier model the session's own can hand a stuck task to.
 *
 * The expert is not a better default -- it is a model whose call is worth
 * avoiding: a metered account, a limited allowance, or hardware shared with
 * other people. So the whole configuration is about *when* it is allowed to be
 * called and what happens to it afterwards, and none of it is about making the
 * expert easier to reach.
 *
 * The connection is the same shape a delegated agent takes, for the same
 * reason: `providers.json` holds one entry per provider and the session's model
 * owns it, so an expert on that provider needs a configuration of its own
 * rather than a share of the session's. See {@link
 * DelegatedAgentConnectionOverride}.
 */
export interface CoreEscalationConfig {
	/**
	 * Where the expert runs. Absent means no expert is configured, and every
	 * escalation path is closed -- the tool is not offered and no guard hands
	 * over to it.
	 */
	connection?: DelegatedAgentConnectionOverride;
	/**
	 * Release the expert's conversation when an escalation ends, rather than
	 * holding it for the next one.
	 *
	 * Off by default, and the two answers are right on different hardware. A
	 * held conversation keeps a hosted provider's prompt cache warm, so a
	 * follow-up an hour later does not pay to send the whole exchange again. A
	 * released one frees the slot a local server was holding, which is what
	 * lets another model load at all.
	 */
	closeAfterEscalation?: boolean;
	/**
	 * Ask the user before each escalation, showing the brief and the
	 * assessment.
	 *
	 * Off by default. The model's own account of why it needs help is the one
	 * piece of evidence it has an interest in, so a host that turns this on
	 * gets the harness's independent assessment beside it.
	 */
	requireApproval?: boolean;
	/**
	 * Puts the escalation to the user, where `requireApproval` is set.
	 *
	 * Supplied by hosts that have somewhere to ask. A host with nobody there --
	 * cron, automation, a CLI with no terminal -- leaves this out, and then
	 * `requireApproval` can only refuse: an approval nobody can give is not an
	 * approval, and escalating anyway would be the setting doing the opposite of
	 * what it says.
	 */
	approve?: (request: {
		brief: string;
		index: number;
		of: number;
	}) => Promise<EscalationApproval>;
	/**
	 * The expert's own prompt template, already resolved by the host.
	 *
	 * The expert is a different model from the session's, often a different
	 * family, and until this existed it received neither: `openExpert` built a
	 * hand-written role preamble and handed the delegated agent the built-in
	 * tool descriptions, so a glm or qwen expert read upstream Cline's prompt --
	 * written for frontier models, which is the reason family templates exist
	 * at all. Resolution lives in the host because only the host can ask
	 * `/api/show` what a local tag actually is; core composes what it is given.
	 *
	 * The system text does NOT replace the role preamble, it follows it. The
	 * preamble says who is asking and what is expected back -- that the caller
	 * is a model rather than a user, and that a suggested patch in a code block
	 * is the one answer that is useless here. Put the family text first and the
	 * model reads a general-purpose coding prompt and answers as if to a user,
	 * which is the exact failure the preamble was written to stop.
	 */
	promptTemplate?: RenderedPromptTemplate;
	/**
	 * Let the session's own model keep running while the expert works.
	 *
	 * Off by default, and the default is not conservatism about the feature --
	 * it is that the cost cannot be found out from here. A local ollama serves
	 * a cloud expert through the same endpoint as the local base, so the two
	 * sharing an endpoint says nothing about whether they contend for it; and
	 * between two local models on a server holding one at a time, every
	 * alternation is an unload and a load. Only the host knows which of those
	 * its hardware is doing, so only the host can answer this.
	 *
	 * Off is not the hand-over this feature started as. The notes are still
	 * collected and still carry the revision each changed file can be read at;
	 * they arrive in one batch with the delivery rather than while the expert
	 * is still working, so the base can check the claims against the exact
	 * bytes without ever having run beside it.
	 */
	alternateWithBase?: boolean;
	/**
	 * Keep the base running, and relay nothing to it until the delivery.
	 *
	 * Read only when {@link alternateWithBase} is set, and there for the
	 * machine where a model swap is expensive. The base still runs -- it may
	 * read, run the check and think about the problem while it stands down from
	 * edits, and a steer from the user still reaches it -- but nothing about
	 * the expert's work is relayed while that work is happening: no note
	 * batches, no guards on the expert's channels, no messages either way.
	 *
	 * The notes are not saved up for the end, either. A batch is only worth a
	 * wake-up while it can still change something, and a model handed four
	 * hundred of them at the delivery is reading a transcript of work that has
	 * already finished -- which costs the swap it was avoiding and buys nothing
	 * (user, 2026-09-14: "the batches are not useful and would be processed
	 * when the runs end and there will be a ton").
	 */
	relayNothing?: boolean;
	/** Escalations allowed in one task. Three by default. */
	maxEscalations?: number;
	/** Follow-ups within one escalation, after the first delivery. Twenty by default. */
	maxFollowUps?: number;
	/**
	 * When the struggle detector offers an escalation.
	 *
	 * Exposed because the right numbers are still an open question and the
	 * setting is load-bearing: on one measured arm the trigger fired zero times
	 * in three runs, because the change protocol produces successful tool calls
	 * carrying bad verdicts rather than failed ones. Omitted fields keep the
	 * corpus-fitted defaults.
	 */
	struggleThresholds?: StruggleThresholds;
}

export interface CoreRuntimeFeatures {
	enableTools: boolean;
	enableSpawnAgent: boolean;
	enableAgentTeams: boolean;
	/**
	 * Whether a turn that calls no tool is nudged to continue even when nothing
	 * says work is unfinished. Defaults to true, which is what every host did
	 * before this was a setting.
	 *
	 * A coding session wants that reading: a silent turn there is nearly always
	 * one that should have acted, and a needless nudge costs a turn where a
	 * missed one costs the task. A session used mostly for questions wants the
	 * opposite -- see `completionPolicy.strongNudges`.
	 */
	strongNudges?: boolean;
	disableMcpSettingsTools?: boolean;
	yolo?: boolean;
}

export type CoreCompactionMode = "auto" | "manual" | "overflow_recovery";

export interface CoreCompactionBudget {
	request: {
		/** Estimated tokens for the full provider request. */
		inputTokens: number;
		/** Effective provider input limit. */
		maxInputTokens: number;
		/** Full-request token count that triggers automatic compaction. */
		triggerTokens: number;
		/** Full-request token count the strategy output should fit within. */
		targetTokens: number;
		/** Fixed system-prompt, tool-definition, and request framing cost. */
		overheadTokens: number;
		thresholdRatio: number;
		utilizationRatio: number;
	};
	messages: {
		/** Estimated tokens in the compactable message transcript. */
		inputTokens: number;
		/** Message budget corresponding to the full-request trigger. */
		triggerTokens: number;
		/** Message budget the strategy should compact toward. */
		targetTokens: number;
	};
}

export interface CoreCompactionContext {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: MessageWithMetadata[];
	model: {
		id: string;
		provider: string;
		info?: ModelInfo;
	};
	mode: CoreCompactionMode;
	budget: CoreCompactionBudget;
	/**
	 * Aborted when the turn is cancelled. Custom `compact` implementations
	 * that call models or external services should observe it so a cancelled
	 * or recovering turn is not blocked on a stalled compaction.
	 */
	abortSignal?: AbortSignal;
	/**
	 * Where a compaction says how far through its own model calls it is.
	 *
	 * A compaction is several sequential requests and reads as one spinner
	 * from outside; on a local model the whole sequence can run for minutes.
	 * Supplied by the pipeline, which owns the channel -- absent means the
	 * compaction simply says nothing, as it did before.
	 */
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
}

// Mirrors BudgetPolicyIntent in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionBudgetPolicyIntent =
	| "agentic_summary"
	| "basic_compaction_projection"
	| "normal_provider_request";

// Mirrors LiveTailHandling in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionLiveTailHandling =
	| "included_verbatim"
	| "included_degraded"
	| "summarized_as_context"
	| "omitted_with_warning"
	| "preserved_out_of_band";

export interface CoreCompactionBudgetMetadata {
	policyIntent: CoreCompactionBudgetPolicyIntent;
	actionCount: number;
	warningCount: number;
	liveTailHandling: CoreCompactionLiveTailHandling;
}

export interface CoreCompactionResult {
	messages: MessageWithMetadata[];
	budget?: CoreCompactionBudgetMetadata;
}

export interface CoreCompactionSummarizerConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	/**
	 * Optional pre-resolved model metadata for the summarizer. Supplying either
	 * this or `knownModels` lets agentic compaction budget summary input against
	 * the summarizer model's actual context window instead of falling back to the
	 * active model's window.
	 */
	modelInfo?: ModelInfo;
	knownModels?: Record<string, ModelInfo>;
	providerConfig?: ProviderConfig;
	maxOutputTokens?: number;
}

/**
 * Session settings for the model's task checklist.
 *
 * Off unless a host asks for it: the checklist costs a parameter on every tool
 * description and re-sent text every few calls, which is a trade a host makes
 * knowingly rather than inherits.
 */
export interface CoreTaskProgressConfig {
	enabled: boolean;
	/** Tool calls between reminders. Non-positive disables reminding only. */
	reminderInterval?: number;
	/** Called whenever the model sends a new checklist. */
	onUpdate?: (state: TaskProgressState) => void;
}

/**
 * How firmly the session insists an edited file be checked before it finishes.
 *
 * Three states rather than a boolean, because "ask the model once" and "do not
 * let it finish" are different products and the user owns the choice. It lives
 * in settings rather than in the conversation on purpose: a question asked
 * after every file change is a round trip per edit, and "always" is not an
 * answer a model should be giving on the user's behalf.
 */
export type CoreEditVerificationMode = "off" | "nudge" | "require";

export interface CoreEditVerificationConfig {
	mode?: CoreEditVerificationMode;
	/** Tools whose calls mark a file changed. Defaults to the built-in editors. */
	editTools?: string[];
	/**
	 * Tools whose calls mark a file verified. Named by the host rather than
	 * assumed: the checker on the VS Code path is `check_file`, which lives in
	 * the extension. A host that names none gets no guard at all.
	 */
	checkTools?: string[];
}

/**
 * When a task is run as a sequence of judged, revertible transactions.
 *
 * This says where the protocol is configured from and who decides to run it,
 * not whether a change can be judged — that question is answered by whether
 * there is an oracle and whether the model may propose one, and it is the same
 * question in both modes.
 *
 * `static` engages on every task from the moment it starts, configured once and
 * unaffected by anything said in the conversation. It is the mode to measure a
 * model in, because a run must not depend on what a panel happened to be
 * showing. `on` makes the protocol available and leaves the engaging to the
 * user, per task, at the point they hit something worth judging — which is how
 * a developer meets it: not at the start of the work, but partway through.
 *
 * Off is the default: the protocol costs a check per attempt and holds a copy
 * of the workspace in memory, which is not a bargain for a one-line edit.
 *
 * Replaced `off | auto | always`. `auto` stood down where nothing could judge a
 * change and `always` engaged anyway with the model as the check — a
 * distinction that had stopped carrying its own weight, because `proposeCheck`
 * already decides that same case and says so in plainer words. Both old values
 * engaged by themselves, so both migrate to `static`; migrating them to `on`
 * would leave the protocol switched on and never engaging.
 */
export type CoreAtomicProtocolMode = "off" | "on" | "static";

export interface CoreAtomicProtocolConfig {
	mode?: CoreAtomicProtocolMode;
	/**
	 * What the model must run for this task to count as done, as a shell line.
	 *
	 * The user's own check, and it outranks anything detection finds. Detection
	 * answers "does this workspace still hold together", which a model can leave
	 * green with the asked-for thing still broken — a typecheck passes over a
	 * game that no longer starts. A line written for the task in front of the
	 * user is the narrower question and the one worth judging on.
	 */
	oracleCommand?: string;
	/**
	 * A pattern that command's output must match, on top of a clean exit.
	 *
	 * For the large class of checks that report a verdict and exit zero anyway.
	 * Without it, such a check keeps every transaction it is ever pointed at:
	 * the harness's own oracle prints `{"ok":false,"error":"…"}` and exits 0
	 * whether the game runs or not.
	 */
	oracleExpect?: string;
	/** Longest that command may run before the transaction is judged on nothing. */
	oracleTimeoutMs?: number;
	/** Changes the model may declare per transaction. Three by default. */
	maxChanges?: number;
	/** Attempts before the task stops. Six by default, as the harness runs it. */
	maxTransactions?: number;
	/**
	 * Asks the user to approve a check the model proposed for this task.
	 *
	 * Supplied by hosts that have somewhere to ask. Where a workspace holds
	 * nothing runnable, this is the difference between a real verdict and the
	 * model's own account of its work — and the approval is a boundary rather
	 * than a formality, since an approved command is then run repeatedly and
	 * trusted as the judge. A host without a user leaves it out and gets the
	 * behaviour it had before.
	 */
	approveCheck?: CheckApprover;
	/**
	 * Whether the model may propose its own check where nothing can be run.
	 *
	 * Defaults on. Off restores the verdict that preceded it -- the model's own
	 * account of its work -- which is weaker evidence and measurably faster:
	 * across one workspace the proposed-check runs took four to six times the
	 * model time of the self-declared ones and closed nothing. This is here so
	 * the two can be compared on the same task rather than across releases.
	 */
	proposeCheck?: boolean;
	/**
	 * Proposals put to the user before the run gives up on having a check.
	 *
	 * Two by default. A host that approves everything automatically wants a
	 * different number from one where a person answers each time.
	 */
	maxCheckProposals?: number;
	/**
	 * Discarded attempts before a check that has never passed may be replaced.
	 *
	 * Two by default, and zero turns it off. The freeze on a proposed check is
	 * what stops a model weakening it until one passes; this is the one crack
	 * in it, for the case the freeze cannot survive — a check that cannot pass
	 * at all, which freezes the run into failure. Measured over ten runs on one
	 * workspace, that cost two of them outright, and in the second the model
	 * proposed the correct check twice and was refused both times.
	 *
	 * Only ever applies to a check the model proposed. A check the user wrote,
	 * or one detected in the tree, is the specification and is never revisited.
	 */
	checkReconsideredAfter?: number;
	/**
	 * Retires what the model had read about a file the protocol put back.
	 *
	 * Supplied by hosts that own the read receipts, for the same reason
	 * `approveCheck` is supplied by hosts that have somewhere to ask. The
	 * protocol's `restore_file` moves every line in the file it restores, so
	 * reads taken before it no longer describe it, and the editor's
	 * read-before-edit guard would otherwise accept an edit aimed at code that
	 * has since moved. A host that leaves this out still gets the restore.
	 */
	forgetReads?: (absolutePath: string) => void;
}

export type CoreCompactionStrategy = "basic" | "agentic";

export interface CoreCompactionConfig {
	enabled?: boolean;
	strategy?: CoreCompactionStrategy;
	preserveRecentTokens?: number;
	/**
	 * Minimum share of the transcript's messages the preserved tail should reach
	 * before `preserveRecentTokens` alone is allowed to end it (0–1).
	 *
	 * A token budget is a poor proxy for how much conversation survives, and the
	 * two diverge exactly when messages are heavy: measured live, a 113-message
	 * transcript satisfied a 20,000-token budget after six messages and compacted
	 * to seven while the post-compaction budget allowed ~73,000. Defaults to
	 * {@link DEFAULT_PRESERVE_RECENT_MESSAGES_RATIO}; the token budget for the
	 * compacted request still caps it, so this can only ask, never overrun.
	 */
	preserveRecentMessagesRatio?: number;
	/**
	 * Whether the most recent messages survive a compaction verbatim.
	 *
	 * On (the default) the summary is a preface: it is prepended to a recency
	 * tail the model then reads in its own words, and `summaryPrompt` is written
	 * for that — first person, same prose, no seam. Off, the summary *is* the
	 * context and `fullSummaryPrompt` applies instead, which is a different
	 * artifact rather than a longer one.
	 *
	 * The two are separate settings because they are separate jobs, and a user
	 * who has tuned one should not lose it by trying the other.
	 */
	keepRecentMessages?: boolean;
	/**
	 * The compaction from which the tail is dropped anyway, counting from 1.
	 *
	 * Only meaningful while {@link keepRecentMessages} is on; with it off every
	 * compaction already keeps nothing. `1` drops the tail on every compaction
	 * and anything below `1` never does. Unset takes
	 * `FORCE_FULL_FROM_COMPACTION`, which is now `0` -- off.
	 *
	 * It defaulted to `2` and should not have. That made the tail policy change
	 * part-way through every run: the first compaction kept the tail, every
	 * later one dropped it. The first was then the weak one by construction,
	 * and no experiment could compare keeping a tail with dropping one, because
	 * neither arm ever did either for a whole run. Left as an override for
	 * anyone who wants that behaviour on purpose.
	 */
	forceFullFromCompaction?: number;
	/**
	 * The session's file revision log, when the host keeps one.
	 *
	 * Compaction is the only thing that can answer either of the log's two open
	 * questions: which revisions a summary still refers to, and therefore which
	 * histories are worth holding. Supplied by the host for the same reason
	 * `forgetReads` is -- the log lives in the runtime, and a host without one
	 * still compacts, with ledger entries that say nothing about files.
	 */
	revisions?: CompactionRevisions;
	/**
	 * Whether each summary carries the harness's own record of the calls it
	 * stands for.
	 *
	 * Defaults on. Set `false` with the Checkpoints switch, which owns the
	 * revision addresses the ledger quotes: a ledger naming revisions on a
	 * session that has no `restore_file` to reach them is an offer the session
	 * cannot honour.
	 */
	toolLedgerEnabled?: boolean;
	/**
	 * Replaces the built-in instruction the summarizer is given when a recency
	 * tail survives — see {@link keepRecentMessages}.
	 *
	 * The summary is all that survives the turns it stands for, and what a good
	 * one contains depends on the work and on the model writing it, so this is
	 * worth being able to change without a rebuild. `{{files_read}}` and
	 * `{{files_edited}}` are substituted; the transcript is appended by the
	 * caller either way. Blank or unset uses the default.
	 */
	summaryPrompt?: string;
	/**
	 * Replaces the built-in instruction used when no recency tail survives.
	 *
	 * Ignored while {@link keepRecentMessages} is on. Blank or unset uses the
	 * default, which is written for a reader that has this text and nothing
	 * else: a fixed section list rather than a request for detail, because
	 * length adjectives are a measured non-lever and structure is not.
	 */
	fullSummaryPrompt?: string;
	/**
	 * Whether compaction also writes a retrospective over the reasoning it is
	 * discarding, prepended to the summary as its own thinking block.
	 *
	 * The summary records what happened; the reasoning that produced it is
	 * thrown away with the turns, and with it every wrong approach the model
	 * already ruled out. A model that resumes from a summary alone has no memory
	 * of having been wrong, which is how a long task repeats its own mistakes.
	 *
	 * Costs one extra model call per compaction. Defaults to on.
	 */
	thinkingSummaryEnabled?: boolean;
	/**
	 * Whether the summary and the retrospective are reviewed before they
	 * replace the transcript.
	 *
	 * Two reviewers each receive one half of the transcript along with the
	 * whole summary, and correct it against the half they hold; a synthesiser
	 * merges the two corrections. The summary is the one artifact in the
	 * system that is never checked against the thing it describes, and from
	 * the turn it is written it *is* the thing it describes -- so a claim that
	 * went in wrong is never caught by anything downstream.
	 *
	 * Costs three extra model calls per compaction and cannot fail one: every
	 * path through the review returns the summary it was given. Defaults to on.
	 */
	councilEnabled?: boolean;
	/**
	 * Replaces the built-in retrospective instruction.
	 *
	 * Worth changing per model for the same reason as `summaryPrompt`, and more
	 * so: a model that habitually reasons to its cap needs a firmer hand about
	 * terseness than one that thinks in three lines. Blank or unset uses the
	 * default.
	 */
	thinkingSummaryPrompt?: string;
	/**
	 * Whether a turn whose reasoning hit the thinking cap has that reasoning
	 * replaced, for the next request, with a note of what it settled.
	 *
	 * A capped turn is cut mid-sentence, and the next turn re-derives the same
	 * reasoning from the beginning rather than continuing from it. Defaults on
	 * where a thinking budget is known; without one there is nothing to detect.
	 */
	cappedThinkingEnabled?: boolean;
	/** Replaces the built-in continuation-note instruction. */
	cappedThinkingPrompt?: string;
	/**
	 * What the server appends to reasoning it cut at the budget, when the
	 * session knows the wording. Confirms or denies a capped turn outright;
	 * without one the condenser measures instead.
	 */
	cappedThinkingBudgetMessage?: string;
	/** The per-turn thinking allowance this session sends, when one is known. */
	thinkingBudgetTokens?: number;
	summarizer?: CoreCompactionSummarizerConfig;
	compact?: (
		context: CoreCompactionContext,
	) =>
		| Promise<CoreCompactionResult | undefined>
		| CoreCompactionResult
		| undefined;
}

/**
 * Context passed to a custom `createCheckpoint` implementation.
 */
export interface CoreCheckpointContext {
	/** Absolute path to the working directory of the session. */
	cwd: string;
	/** The session identifier. */
	sessionId: string;
	/** Monotonically increasing run counter for this session (starts at 1). */
	runCount: number;
}

/**
 * Configuration for the built-in git-based checkpoint feature.
 *
 * Checkpoints capture a restorable snapshot of the workspace at the start of
 * each root-agent run so that changes made during a session can be rolled back.
 *
 * @example Disable checkpoints entirely:
 * ```ts
 * checkpoint: { enabled: false }
 * ```
 *
 * @example Bring your own checkpoint implementation:
 * ```ts
 * checkpoint: {
 *   createCheckpoint: async ({ cwd, sessionId, runCount }) => {
 *     const ref = await mySnapshotFn(cwd);
 *     return { ref, createdAt: Date.now(), runCount };
 *   },
 * }
 * ```
 */
export interface CoreCheckpointConfig {
	/**
	 * Whether to create checkpoints on each root-agent run start.
	 * Defaults to `false` — checkpoints are **opt-in**. Set to `true` to
	 * enable the built-in git stash/ref checkpoint behaviour for this session.
	 */
	enabled?: boolean;
	/**
	 * Replace the built-in git stash/ref checkpoint logic with a custom
	 * implementation. Called once at the start of each root-agent run (before
	 * the first agent iteration).
	 *
	 * Return an object with at least `ref`, `createdAt`, and `runCount` to have
	 * the entry recorded in session metadata, or return `undefined` to skip
	 * writing a checkpoint for that run.
	 */
	createCheckpoint?: (context: CoreCheckpointContext) =>
		| Promise<
				| {
						ref: string;
						createdAt: number;
						runCount: number;
						kind?: "stash" | "commit";
				  }
				| undefined
		  >
		| {
				ref: string;
				createdAt: number;
				runCount: number;
				kind?: "stash" | "commit";
		  }
		| undefined;
}

export interface CoreSessionConfig
	extends CoreModelConfig,
		CoreRuntimeFeatures,
		Omit<SessionWorkspaceConfig, "workspaceRoot">,
		Omit<SessionPromptConfig, "systemPrompt">,
		Omit<
			SessionExecutionConfig,
			| "enableTools"
			| "teamName"
			| "missionLogIntervalSteps"
			| "missionLogIntervalMs"
			| "maxConsecutiveMistakes"
		> {
	/**
	 * Core/hub runtime session identifier.
	 *
	 * When provided, this becomes the host-owned id for persistence, hub
	 * subscriptions, send/abort/stop commands, and approval routing. When
	 * omitted, the runtime host creates one. This is distinct from the agent
	 * conversation id, which is generated by the conversation store for
	 * transcript/tool/hook context.
	 */
	sessionId?: string;
	/**
	 * Turn images into text with a second model, so the session's model never
	 * sees one. See `AgentConfig.describeImages`.
	 *
	 * Declared here because it is a session-level setting that hosts already
	 * pass: the VS Code host has set both of these since the vision model
	 * shipped, and only got away with it because it adds them through a
	 * conditional spread, which excess-property checking does not inspect. A
	 * host assigning them directly — the CLI — was rejected for setting a field
	 * that has always been read.
	 */
	describeImages?: AgentConfig["describeImages"];
	/** See `AgentConfig.alwaysDescribeImages`. */
	alwaysDescribeImages?: boolean;
	/**
	 * Run subagents and teammates on this connection instead of the session's.
	 *
	 * Omitted means what it always meant: they inherit the lead's. See
	 * `DelegatedAgentConnectionOverride`.
	 */
	delegatedAgentConnection?: DelegatedAgentConnectionOverride;
	/**
	 * Most delegated agents that may run at once against their endpoint.
	 *
	 * Resolved by the host, because answering it can mean asking the server: a
	 * local one has a fixed number of slots (`OLLAMA_NUM_PARALLEL`,
	 * `--parallel N`) and *queues* the request that finds none free rather than
	 * refusing it, so over-spawning reads as a slow run rather than a blocked
	 * one. Hosted providers have the same shape with a plan's allowance in place
	 * of slots.
	 *
	 * `0` means no cap of ours -- not "unlimited", but "something else decides":
	 * opencoti with PolyKV on, where agents share a slot and admission control
	 * answers against measured KV headroom. `undefined` means no host resolved
	 * one at all, which leaves every previous behaviour exactly as it was.
	 */
	maxConcurrentAgents?: number;
	/**
	 * The same bound, per endpoint, for the endpoints that are not the
	 * session's.
	 *
	 * An agent that names a `profile:` or a `providerId:` runs somewhere else,
	 * and how many requests *that* server serves at once is its own number. Held
	 * to the lead's, a four-slot server ran one agent while its siblings queued
	 * for slots it had free.
	 *
	 * Given as connections rather than as keys so the host never has to spell an
	 * endpoint key: two spellings of one server -- a trailing slash, a capital
	 * letter -- are the same endpoint, and only `agentEndpointKey` knows that.
	 * The first entry naming an endpoint wins, so a host may list the specific
	 * answers (a profile's own count) ahead of the general ones (the shared
	 * provider entry's).
	 *
	 * Host-resolved like `maxConcurrentAgents`, but from configuration alone:
	 * the one thing that can only be answered by asking a server -- opencoti
	 * with PolyKV, where the cap is lifted because admission control decides --
	 * is not asked here, because that probe is unbounded and these endpoints are
	 * merely configured, not necessarily running. A server that is switched off
	 * would otherwise hold up starting a session that was never going near it.
	 *
	 * An endpoint nobody named takes `maxConcurrentAgents`, which is what every
	 * endpoint took before this existed.
	 */
	/**
	 * Agent Nodes: where delegated agents run, in priority order.
	 *
	 * A node is a complete agents configuration -- its own provider, model,
	 * context window, sampler and budget -- so a set of them is heterogeneous
	 * by design. 1 is the highest priority and a lower tier is used only when
	 * no node in a higher one has a free slot; within a tier, round-robin.
	 * When all of them are full the next agent WAITS, in spawn order.
	 *
	 * Resolved by the host, capacity included: the unit differs by provider
	 * (a parallel-sessions setting for ollama, llama.cpp and the cloud ones;
	 * the sub-pools inside one session for opencoti).
	 *
	 * Empty or absent is every session that predates this: delegated agents
	 * take `delegatedAgentConnection`, or the session's own.
	 */
	agentNodes?: ReadonlyArray<{
		id: string;
		priority: number;
		/**
		 * How many delegated agents this node runs at once.
		 *
		 * `0` is the node turned OFF -- it is never placed on. "The endpoint
		 * decides" is `Number.POSITIVE_INFINITY`, not `0`: the two readings
		 * collided once already, and a node meaning the second was read as
		 * the first and silently took no agents at all.
		 */
		capacity: number;
		connection: DelegatedAgentConnectionOverride;
	}>;
	agentSlotLimits?: ReadonlyArray<{
		providerId?: string;
		baseUrl?: string;
		/** As `maxConcurrentAgents`: `0` means admission control decides. */
		limit: number;
	}>;
	/**
	 * Resolves a provider other than the session's, for a configured subagent
	 * whose frontmatter names one.
	 *
	 * Host-supplied because only the host knows where its provider store lives:
	 * the CLI's follows `--config`, the extension's follows its own data
	 * directory. Core reaching for a default path would read the wrong file in
	 * one of them and call the wrong server with the wrong key. Absent means an
	 * agent on a second provider is refused rather than silently run on the
	 * session's connection.
	 */
	resolveProviderConnection?: (
		providerId: string,
	) => AgentProviderConnection | undefined;
	/**
	 * Resolves a saved API configuration profile by name, for an agent whose
	 * frontmatter names one.
	 *
	 * Host-supplied for the same reason as the provider resolver, and absent on
	 * a host that has no profiles at all — the CLI has providers and no named
	 * configurations over them. An agent naming a profile on such a host is
	 * refused rather than run on the session's, which is the same rule the
	 * provider case follows and for the same reason: a subagent silently running
	 * the wrong model is worse than one that does not run.
	 */
	resolveProfileConnection?: (
		name: string,
	) => AgentProfileConnection | undefined;
	/**
	 * The profile names this host currently has, so a refusal can say what to
	 * pick instead of only what is missing. Profiles are deleted long after the
	 * agent files that name them were written.
	 */
	listProfileNames?: () => string[];
	workspaceRoot?: string;
	systemPrompt: string;
	teamName?: string;
	missionLogIntervalSteps?: number;
	missionLogIntervalMs?: number;
	hooks?: AgentHooks;
	hookErrorMode?: HookErrorMode;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	extensionContext?: ExtensionContext;
	extraTools?: AgentTool[];
	/**
	 * The checklist the model keeps while it works.
	 *
	 * Applied to the whole session toolset — builtins and `extraTools` alike.
	 * A host that replaces a builtin (VS Code swaps `run_commands` for its own
	 * terminal-aware version) would otherwise leave the most-used tool in a
	 * coding run as the one tool carrying no checklist.
	 */
	taskProgress?: CoreTaskProgressConfig;
	/**
	 * Whether the run may end with a file the model changed and never checked.
	 *
	 * Measured on a live session: the linter ran once *before* anything was
	 * touched, then four consecutive edits landed unchecked, and the file was
	 * left with sixteen problems. The tool was present and already used — what
	 * was missing was anything that noticed.
	 */
	editVerification?: CoreEditVerificationConfig;
	/**
	 * Whether the task runs as judged, revertible transactions.
	 *
	 * A stronger claim than edit verification and a different one: verification
	 * asks that a changed file be checked, while this decides what happens when
	 * the check says no. A transaction that fails is not reported and left on
	 * disk — every file it touched goes back to what it was, and the next
	 * attempt starts from the same place this one did, carrying the record of
	 * what was already tried.
	 */
	atomicProtocol?: CoreAtomicProtocolConfig;
	/**
	 * A costlier model this session may hand a stuck task to.
	 *
	 * Absent means no escalation path exists, which is every previous build's
	 * behaviour. See {@link CoreEscalationConfig}.
	 */
	escalation?: CoreEscalationConfig;
	/**
	 * The project's own checker, for the `check_file` this host supplies.
	 *
	 * Without one that tool answers a narrower question than the extension's
	 * does — syntax and brackets, where VS Code reads its language servers —
	 * and the two hosts ship measurably different tools under one name. Naming
	 * a command closes the distance and changes what the tool tells the model
	 * it is, which is the half that matters: a model that believes it has only
	 * a syntax check goes and runs the linter through `run_commands` anyway.
	 *
	 * `${file}` marks where the path goes; a command without it gets the path
	 * appended.
	 */
	checkFile?: { lintCommand?: string };
	/**
	 * Named secrets a QA command can ask for.
	 *
	 * Supplied by the host because only the host has a secret store; core never
	 * reads or writes them anywhere, it only routes a value into the environment
	 * of the one command that asked and masks it back out of what comes home.
	 * See `extensions/tools/qa-credentials.ts` for why that is the whole design.
	 */
	qaCredentials?: QaCredential[];
	pluginPaths?: string[];
	/**
	 * Additional Agent Plugins v1 package roots. Paths are resolved by the
	 * execution host, so hub clients do not load package contents themselves.
	 */
	agentPluginPaths?: string[];
	extensions?: AgentConfig["extensions"];
	execution?: AgentConfig["execution"];
	compaction?: CoreCompactionConfig;
	checkpoint?: CoreCheckpointConfig;
	onTeamEvent?: (event: TeamEvent) => void;
	onConsecutiveMistakeLimitReached?: (
		context: ConsecutiveMistakeLimitContext,
	) =>
		| Promise<ConsecutiveMistakeLimitDecision>
		| ConsecutiveMistakeLimitDecision;
	toolRoutingRules?: ToolRoutingRule[];
	/**
	 * Optional skill allowlist for the `skills` tool. When provided, only these
	 * skills are surfaced in tool metadata and invocable by name.
	 */
	skills?: string[];
	workspaceMetadata?: string;
}

/**
 * Public ClineCore start configuration. The execution host resolves `cwd`
 * before constructing a runtime, assigning the shared chat workspace when both
 * workspace paths are omitted.
 */
export type ClineCoreStartConfig = Omit<CoreSessionConfig, "cwd"> & {
	cwd?: string;
};
