import { createHandlerAsync } from "@cline/llms";
import type { BasicLogger, MessageWithMetadata } from "@cline/shared";
import { countUserRunMessages } from "../../session/user-run-messages";
import type {
	CoreCompactionContext,
	CoreCompactionResult,
	CoreCompactionSummarizerConfig,
} from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	type BudgetProjectionResult,
	buildBudgetProjection,
} from "./budget-projection";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	buildThinkingSummaryRequest,
	CHARS_PER_TOKEN,
	collectUserRequests,
	type EstimateMessageTokens,
	ensureFilesSection,
	estimateTokens,
	extractFileOps,
	findCutPlan,
	findLatestSummaryIndex,
	getCompactionSummaryMetadata,
	type MeasureReportedTokens,
	planFullCut,
	type RecencyBounds,
	resolveCompactionOutputBudgets,
	resolveEffectiveMaxInputTokens,
	resolveSummarizerConfig,
	resolveThinkingSummaryMaxTokens,
	serializeConversation,
	serializeReasoningWithOutcomes,
} from "./compaction-shared";
import { logExcerpt, runCouncilReview } from "./council-compaction";
import { cutEchoedTranscript, trimReplayOverflow } from "./replay-compaction";
import {
	buildToolLedger,
	collectFileHistories,
	evictToolLedger,
	mergeToolLedger,
	type RevisionSpanLookup,
	renderToolLedger,
	renderToolLedgerKey,
	spliceLedgerCitations,
} from "./tool-ledger";

/**
 * The summarizer input budget assumed when nothing knows the summarizer's
 * window.
 *
 * It has to clear the largest built-in instruction with room left for a
 * transcript, or the guard below refuses every compaction and the context grows
 * unbounded while the log says "skipped". The replay prompt is ~3,100
 * characters -- about 1,030 tokens at the default ratio -- so the old 1,024
 * floor was under the instruction alone: a summarizer with no known window
 * compacted nothing at all, silently, and the only symptom was a session that
 * kept growing.
 */
const MIN_AGENTIC_SUMMARY_INPUT_TOKENS = 4_096;

function resolveProviderMaxInputTokens(
	providerConfig: ProviderConfig,
): number | undefined {
	const modelInfoLimit = resolveEffectiveMaxInputTokens({
		maxInputTokens:
			providerConfig.maxInputTokens ?? providerConfig.modelInfo?.maxInputTokens,
		contextWindow: providerConfig.modelInfo?.contextWindow,
	});
	if (modelInfoLimit !== undefined) {
		return modelInfoLimit;
	}
	const knownModelInfo = providerConfig.knownModels?.[providerConfig.modelId];
	return resolveEffectiveMaxInputTokens({
		maxInputTokens: knownModelInfo?.maxInputTokens,
		contextWindow: knownModelInfo?.contextWindow,
	});
}

export function buildAgenticSummaryInputBudget(options: {
	messages: CoreCompactionContext["messages"];
	targetTokens: number;
	estimateMessageTokens: EstimateMessageTokens;
}): BudgetProjectionResult {
	return buildBudgetProjection({
		messages: options.messages,
		targetTokens: Math.max(1, options.targetTokens),
		policyIntent: "agentic_summary",
		estimateMessageTokens: options.estimateMessageTokens,
	});
}

interface SummaryGenerationResult {
	text: string;
	/** Reasoning/thinking output length; discarded from the summary itself. */
	reasoningChars: number;
	/** Provider-reported reason the response is incomplete (e.g. "max_output_tokens"). */
	incompleteReason?: string;
}

/**
 * What the summarizer is told it is, which is not the same job in both modes.
 *
 * The system half used to say "concise" while the user half asked for the
 * detail that has to survive, and the model was pulled both ways on the one
 * message that has to carry everything. Both of these agree with their prompt
 * instead — and they have to be separate texts, because the two prompts ask
 * for different artifacts. A replay is written in the first person and is read
 * as the model's own memory; a full summary is a state record read as the only
 * surviving fact. Telling a model to write a hand-over note and then handing it
 * the replay prompt reproduces the seam the replay prompt exists to remove.
 */
export const SUMMARIZER_SYSTEM_PROMPTS = {
	tail: "You are re-telling your own recent work in your own voice, because the earlier part of your transcript is about to be discarded and what you write takes its place directly in front of the turns that remain. Match the prose of those turns. Keep every specific — names, paths, quoted wording, errors, numbers — that you would otherwise have to rediscover.",
	full: "You write the state record for a working session of any kind. The transcript you are given is about to be discarded, so what you write is the only record that remains. Follow the requested structure exactly, section for section, and keep every specific — names, paths, quoted wording, errors, numbers — that whoever continues would otherwise have to rediscover.",
	// The retrospective ran under the hand-over wording too, and it is the one
	// pass that must not carry specifics: they are in the summary already, and
	// repeating them spends the budget twice for one fact.
	retrospective:
		"You are assessing your own reasoning on work that is about to be discarded. This is judgement, not a record — what happened is written up separately. Be terse, and say only what you would want to know before starting the next hour of this task.",
} as const;

/**
 * How many times the summarizer is asked before compaction gives up.
 *
 * Three, because the three failures it recovers from are different and a
 * single retry only covers one of them: a transport error is usually gone on
 * the next call, an empty response from a model that spent its budget
 * reasoning may need two, and a summary that overran its budget needs one
 * attempt to measure it and another to act on the measurement.
 */
/**
 * The ledger's share of the message budget, once it carries across
 * compactions.
 *
 * A tenth, because the ledger is evidence for the summary rather than a second
 * copy of it, and the budget it competes for is the standing context that has
 * to leave room for the turns it gives perspective on. Small enough that a
 * long session's record is pruned rather than allowed to crowd the prose;
 * large enough that the calls worth keeping -- refusals and verdicts -- all
 * fit, since those are short.
 */
/**
 * What the quoted user requests may take, as a share of the message budget.
 *
 * More than the ledger gets, because this is the one part of a transcript that
 * cannot be rebuilt from anywhere: the files are on disk and the calls are in
 * the ledger, and what was asked exists only in the messages being discarded.
 * Nothing here is ever evicted -- over budget, the requests are elided rather
 * than dropped -- so this bounds how much of each is shown and never how many.
 * There is no floor under it either: a window small enough to make the share
 * tiny is a window where every quoted character is taken from the transcript,
 * and the per-request minimum is what guarantees each one is still there.
 */
const USER_REQUEST_BUDGET_SHARE = 0.15;

const TOOL_LEDGER_BUDGET_SHARE = 0.1;

/**
 * A floor under that share, for a caller that names no message target.
 *
 * Roughly a dozen entries. Below this the eviction order stops meaning
 * anything: everything recoverable is gone on the first compaction and the
 * ledger is a handful of verdicts with no context around them.
 */
const MIN_TOOL_LEDGER_CHARS = 2_000;

/**
 * Everything the user has typed, in order, without repeating what was already
 * carried.
 *
 * Appended rather than merged by content: the same sentence typed twice at
 * different points in a session is two instructions, and only an immediate
 * repeat is one.
 */
function mergeUserRequests(
	previous: readonly string[],
	next: readonly string[],
): string[] {
	const merged = [...previous];
	for (const request of next) {
		if (merged[merged.length - 1] === request) {
			continue;
		}
		merged.push(request);
	}
	return merged;
}

const SUMMARY_ATTEMPTS = 3;

/**
 * Tell the summarizer, in numbers, that its last attempt did not fit.
 *
 * This is the one place length is worth talking about, and it is the exception
 * that proves the rule the prompts follow. `DEFAULT_FULL_COMPACTION_PROMPT`
 * carries no length adjective because adjectives are a measured non-lever
 * (arXiv 2605.23296): "be concise" and "be very detailed" produce nearly the
 * same output, since the model anchors length to its training distribution and
 * has no way to know what the budget is.
 *
 * A measurement is not an adjective. "You wrote 4,100 tokens and the limit is
 * 2,800" is a fact about this attempt against a number the model could not
 * otherwise see, and the second attempt has something to aim at. What it must
 * not turn into is an instruction to drop sections — a shorter summary that
 * has lost the standing instructions or the identifiers is worse than one that
 * overran, so the guidance is to compress within the structure and the two
 * things that are never compressed are named.
 */
function describeOverrun(measuredTokens: number, limitTokens: number): string {
	return [
		"",
		"",
		`Your previous attempt was about ${measuredTokens} tokens. It has to fit in ${limitTokens} and it did not, so it was rejected and nothing was kept from it.`,
		"",
		`Write it again under ${limitTokens} tokens. Keep every section — a missing section reads as an omission by accident. Shorten within them instead: fewer words per item, no restating the same fact in two sections, no preamble. Two things are never shortened: quoted standing instructions, and identifiers, lists and checklists, which have to stay verbatim and complete however little room is left.`,
	].join("\n");
}

async function generateSummary(options: {
	providerConfig: ProviderConfig;
	request: string;
	systemPrompt: string;
	logger?: BasicLogger;
}): Promise<SummaryGenerationResult> {
	const handler = await createHandlerAsync(options.providerConfig);
	let text = "";
	let reasoningChars = 0;
	let incompleteReason: string | undefined;
	for await (const chunk of handler.createMessage(options.systemPrompt, [
		{ role: "user", content: options.request },
	])) {
		if (chunk.type === "text") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "reasoning") {
			reasoningChars += chunk.reasoning?.length ?? 0;
			continue;
		}
		if (chunk.type === "done") {
			if (!chunk.success && chunk.error) {
				throw new Error(chunk.error);
			}
			incompleteReason = chunk.incompleteReason ?? incompleteReason;
		}
	}
	options.logger?.debug("Generated compaction summary", {
		outputChars: text.length,
		reasoningChars,
		incompleteReason,
		modelId: options.providerConfig.modelId,
		providerId: options.providerConfig.providerId,
	});
	return { text: text.trim(), reasoningChars, incompleteReason };
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

/**
 * The second phase, in full.
 *
 * Self-contained and unable to fail the compaction: a retrospective is worth
 * having and worth nothing at the price of losing the summary that was already
 * paid for. Every exit here returns `undefined` and the compaction proceeds
 * without it.
 */
async function generateThinkingSummary(options: {
	enabled: boolean;
	messages: MessageWithMetadata[];
	previousThinkingSummary?: string;
	promptTemplate?: string;
	maxOutputTokens: number;
	summarizer?: CoreCompactionSummarizerConfig;
	activeProviderConfig: ProviderConfig;
	summarizerInputLimit: number;
	logger?: BasicLogger;
}): Promise<string | undefined> {
	if (!options.enabled) {
		return undefined;
	}
	const reasoningText = serializeReasoningWithOutcomes(options.messages);
	if (!reasoningText.trim() && !options.previousThinkingSummary?.trim()) {
		// Nothing was thought and nothing was carried, so there is nothing to be
		// retrospective about. Common on the first compaction of a session whose
		// model does not reason at all.
		return undefined;
	}
	const request = buildThinkingSummaryRequest({
		previousThinkingSummary: options.previousThinkingSummary,
		reasoningText,
		promptTemplate: options.promptTemplate,
	});
	if (estimateTokens(request.length) > options.summarizerInputLimit) {
		options.logger?.log(
			"Skipped thinking compaction: reasoning exceeds the summarizer input limit",
			{
				severity: "warn",
				requestEstimatedTokens: estimateTokens(request.length),
				summarizerInputLimit: options.summarizerInputLimit,
			},
		);
		return undefined;
	}
	const providerConfig = resolveSummarizerConfig({
		activeProviderConfig: options.activeProviderConfig,
		summarizer: options.summarizer,
		maxInputTokens: options.summarizerInputLimit,
		outputTokenCap: options.maxOutputTokens,
	});
	try {
		const result = await generateSummary({
			providerConfig,
			request,
			systemPrompt: SUMMARIZER_SYSTEM_PROMPTS.retrospective,
			logger: options.logger,
		});
		// The retrospective is handed its own reasoning text and can run past
		// the end of it in the same way the summary does, so it gets the same
		// cut. It is the more damaging of the two to leave: the retrospective
		// is prepended above the summary, so an echo here is the first thing
		// the next turn reads.
		const trimmed = cutEchoedTranscript(result.text).text.trim();
		if (!trimmed) {
			return undefined;
		}
		options.logger?.debug(
			`[compaction] retrospective (${trimmed.length} chars): ${logExcerpt(trimmed, 600)}`,
		);
		options.logger?.debug("Generated thinking compaction", {
			reasoningInputChars: reasoningText.length,
			previousThinkingSummaryChars:
				options.previousThinkingSummary?.length ?? 0,
			maxOutputTokens: options.maxOutputTokens,
			outputChars: trimmed.length,
			providerId: providerConfig.providerId,
			modelId: providerConfig.modelId,
		});
		return trimmed;
	} catch (error) {
		options.logger?.log(
			"Thinking compaction failed; keeping the summary alone",
			{
				severity: "warn",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		);
		return undefined;
	}
}

/**
 * How many model calls the council makes. Three: a reviewer for each half of
 * the transcript, and a synthesiser to merge what they say.
 */
const COUNCIL_CALLS = 3;

/**
 * The model calls a compaction is about to make, counted before it makes them.
 *
 * A compaction is several sequential requests -- the summary, the
 * retrospective, then the council -- each of which can take a minute or more
 * on a local model. From outside it is one spinner that sits there, and a run
 * that looked hung on 2026-09-21 was in fact four calls deep and working. The
 * count is what makes the difference legible.
 */
export function planCompactionSteps(options: {
	thinkingSummaryEnabled: boolean;
	councilEnabled: boolean;
}): number {
	return (
		1 +
		(options.thinkingSummaryEnabled ? 1 : 0) +
		(options.councilEnabled ? COUNCIL_CALLS : 0)
	);
}

/** One compaction's progress through {@link planCompactionSteps} calls. */
export interface CompactionProgress {
	/** Count one model call, by the stage it belongs to. */
	step(label: string): void;
}

export function createCompactionProgress(
	total: number,
	emit: (progress: {
		step: number;
		stepTotal: number;
		stepLabel: string;
	}) => void,
): CompactionProgress {
	let step = 0;
	let stepTotal = Math.max(1, total);
	return {
		step(label: string): void {
			step += 1;
			// A retried stage is an extra call, not a stage that disappeared, so
			// the plan grows with it. That keeps the pair honest -- (3/6) after
			// the summary was written twice, never (4/4) with a step unaccounted
			// for, and never a step number past its own total.
			if (step > stepTotal) {
				stepTotal = step;
			}
			emit({ step, stepTotal, stepLabel: label });
		},
	};
}

export async function runAgenticCompaction(options: {
	context: CoreCompactionContext;
	providerConfig: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	/** Overrides the built-in summary instruction; blank uses the default. */
	summaryPrompt?: string;
	/** Second phase: a retrospective over the reasoning being discarded. */
	thinkingSummaryEnabled?: boolean;
	/** Overrides the built-in retrospective instruction; blank uses the default. */
	thinkingSummaryPrompt?: string;
	/**
	 * Third phase: two reviewers, each holding half the transcript, correct the
	 * summary and the retrospective against it, and a synthesiser merges them.
	 *
	 * Defaults on. Costs three extra calls per compaction and cannot fail one:
	 * every path through {@link runCouncilReview} returns what it was given.
	 */
	councilEnabled?: boolean;
	/**
	 * Whether a recency tail survives the compaction. Defaults to true.
	 *
	 * False is a different operation, not a tighter budget: the summary becomes
	 * the whole context rather than its preface, `bounds` stops being consulted,
	 * and the prompt the caller passes has to be one written for a reader with
	 * nothing else. See {@link planFullCut}.
	 */
	keepRecentMessages?: boolean;
	/**
	 * Where the ledger gets the revisions holding each touched file's content.
	 *
	 * Absent means the ledger still runs and simply says nothing about files.
	 * That is the honest degradation: a wrong revision label is worse than
	 * none, because the model will try to restore it.
	 */
	spanFor?: RevisionSpanLookup;
	/**
	 * Whether to append the harness's record of what was called.
	 *
	 * Defaults on. Turned off with the Checkpoints switch, which owns the
	 * revision addresses the ledger quotes.
	 */
	toolLedgerEnabled?: boolean;
	bounds: RecencyBounds;
	estimateMessageTokens: EstimateMessageTokens;
	/**
	 * Measures what a transcript costs as a request, for the reported
	 * before/after only. Absent in callers that only need the cut.
	 */
	measureReportedTokens?: MeasureReportedTokens;
	logger?: BasicLogger;
}): Promise<CoreCompactionResult | undefined> {
	const messages = options.context.messages;
	if (messages.length < 2) {
		return undefined;
	}

	const keepRecentMessages = options.keepRecentMessages !== false;
	const { cutIndex, pinnedIndex } = keepRecentMessages
		? findCutPlan(messages, options.bounds, options.estimateMessageTokens)
		: planFullCut(messages);
	// `cutIndex === messages.length` is the whole point of the no-tail plan and
	// is refused by the tail plan for the same reason: there, a cut at the end
	// means the recency walk found nothing to keep, which is a failure to
	// compact rather than a complete one.
	const maxCutIndex = keepRecentMessages
		? messages.length - 1
		: messages.length;
	if (cutIndex <= 0 || cutIndex > maxCutIndex) {
		return undefined;
	}

	// A pinned prompt lies before the cut but survives verbatim, so it is not
	// part of what gets summarized.
	const pinnedMessage = pinnedIndex >= 0 ? messages[pinnedIndex] : undefined;
	const messagesToSummarize = messages
		.slice(0, cutIndex)
		.filter((_, index) => index !== pinnedIndex);
	const latestSummaryIndex = findLatestSummaryIndex(messagesToSummarize);
	const previousSummaryMetadata =
		latestSummaryIndex >= 0
			? getCompactionSummaryMetadata(messagesToSummarize[latestSummaryIndex])
			: undefined;
	const previousSummary = previousSummaryMetadata?.summary;
	const previousThinkingSummary = previousSummaryMetadata?.thinkingSummary;
	// Carried rather than rewritten. Both of these are the harness's own record
	// and neither has ever passed through the model: a summary can paraphrase
	// the instruction it was given, and after one generation the paraphrase is
	// the only copy left.
	const previousUserRequests = previousSummaryMetadata?.userRequests ?? [];
	// Two lists, because the pinned prompt is in a different position for each
	// reader.
	//
	// What the summary *stores* comes from the span minus the pin, since a
	// pinned prompt survives verbatim as its own message directly below the
	// summary -- quoting it again would say it twice, and on a small model
	// that is enough to push the result past its budget and into the no-tail
	// rescue. Nothing is lost by leaving it out: a prompt is pinned only while
	// it is the latest turn start, and the moment a newer one takes the pin it
	// falls into this span and is collected then.
	//
	// What the *summarizer* is shown includes it, because that reader is the
	// one that genuinely cannot see it: `messagesToSummarize` filters the pin
	// out, so on the one-prompt-then-a-long-loop shape the summarizer was
	// asked to quote an instruction it had never been given, and said so --
	// "The exact instructions are missing from my current view", written into
	// the summary, where the next turn reads it first. Measured on pandorum
	// session 1789877743966_qduum (4.100.141).
	const spanUserRequests = collectUserRequests(messagesToSummarize);
	const pinnedUserRequests = pinnedMessage
		? collectUserRequests([pinnedMessage])
		: [];
	const previousLedgerEntries =
		previousSummaryMetadata?.toolLedgerEntries ?? [];
	const generation = (previousSummaryMetadata?.generation ?? 0) + 1;
	const newMessagesToFold =
		latestSummaryIndex >= 0
			? messagesToSummarize.slice(latestSummaryIndex + 1)
			: messagesToSummarize;
	if (newMessagesToFold.length === 0) {
		return undefined;
	}

	const preProjectionFileOps = extractFileOps(messagesToSummarize);
	// Resolved twice, because the two answers depend on each other: the input
	// limit comes from the merged model, and the output cap is sized from that
	// limit. The first pass exists only to identify the model; its output cap is
	// never used.
	const summarizerModelConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
	});
	const resolvedSummarizerInputLimit = resolveProviderMaxInputTokens(
		summarizerModelConfig,
	);
	const canUseActiveContextLimit = options.summarizer === undefined;
	const activeCompactionInputLimit = Math.max(
		options.context.budget.request.maxInputTokens,
		options.context.budget.request.triggerTokens,
		MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
	);
	if (resolvedSummarizerInputLimit === undefined && !canUseActiveContextLimit) {
		options.logger?.log(
			"Agentic compaction summarizer has no known input limit; using conservative summary budget",
			{
				severity: "warn",
				summarizerProviderId: summarizerModelConfig.providerId,
				summarizerModelId: summarizerModelConfig.modelId,
				fallbackInputLimit: MIN_AGENTIC_SUMMARY_INPUT_TOKENS,
			},
		);
	}
	const summarizerInputLimit =
		resolvedSummarizerInputLimit ??
		(canUseActiveContextLimit
			? activeCompactionInputLimit
			: MIN_AGENTIC_SUMMARY_INPUT_TOKENS);
	// The ladder: what the summary and the retrospective may spend together at
	// this generation, and the summary's share of it. The summary writes first
	// and the retrospective takes what it leaves.
	const outputBudgets = resolveCompactionOutputBudgets({
		messageTargetTokens: options.context.budget.messages.targetTokens,
		maxInputTokens: summarizerInputLimit,
		generation,
	});
	const summarizerProviderConfig = resolveSummarizerConfig({
		activeProviderConfig: options.providerConfig,
		summarizer: options.summarizer,
		maxInputTokens: summarizerInputLimit,
		outputTokenCap: outputBudgets.summaryMaxTokens,
	});
	const summaryRequestOverheadTokens = estimateTokens(
		buildSummaryRequest({
			previousSummary,
			conversationText: "",
			fileOps: preProjectionFileOps,
			promptTemplate: options.summaryPrompt,
		}).length,
	);
	const availableSummaryInputTokens =
		summarizerInputLimit - summaryRequestOverheadTokens;
	if (availableSummaryInputTokens <= 0) {
		// At warn, and naming the two numbers, because this is a configuration
		// fault rather than a transcript that happens not to need compacting.
		// The instruction alone does not fit the summarizer's window, so no
		// transcript will ever fit either and every compaction from here on is a
		// silent no-op while the context keeps growing. Both built-in prompts
		// are larger than the one they replaced — the no-tail prompt is a fixed
		// section list and cannot be short — so the summarizer window this needs
		// is a real floor, not a rounding error.
		options.logger?.log(
			"Skipped agentic compaction: the summary instruction alone exceeds the summarizer's input limit",
			{
				severity: "warn",
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
				summarizerInputLimit,
				summaryRequestOverheadTokens,
			},
		);
		return undefined;
	}
	const summaryInputBudget = buildAgenticSummaryInputBudget({
		messages: newMessagesToFold,
		targetTokens: availableSummaryInputTokens,
		estimateMessageTokens: options.estimateMessageTokens,
	});
	if (summaryInputBudget.status === "failed") {
		options.logger?.log(
			"Skipped agentic compaction: summary input budget failed",
			{
				severity: "warn",
				budgetWarnings: summaryInputBudget.warnings.map(
					(warning) => warning.code,
				),
				summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
				targetTokens: availableSummaryInputTokens,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}
	// means "say nothing about files", and the ledger is still worth its space
	// without one -- it is the only place a *refused* call survives compaction,
	// which is precisely what the summary is worst at keeping.
	const ledgerEnabled = options.toolLedgerEnabled !== false;
	// This compaction's calls behind the ones carried from the last, collapsed
	// across the join and then brought back under budget. The share is small
	// because the ledger is a record and not the record: it earns its space by
	// holding the calls the prose is worst at keeping, not by holding all of
	// them.
	const ledgerBudgetChars = Math.max(
		MIN_TOOL_LEDGER_CHARS,
		Math.floor(
			(options.context.budget.messages.targetTokens ?? 0) *
				CHARS_PER_TOKEN *
				TOOL_LEDGER_BUDGET_SHARE,
		),
	);
	const ledgerEntries = ledgerEnabled
		? evictToolLedger(
				mergeToolLedger(
					previousLedgerEntries,
					buildToolLedger(newMessagesToFold),
				),
				ledgerBudgetChars,
			)
		: [];
	const toolLedger = ledgerEnabled
		? renderToolLedger(
				ledgerEntries,
				collectFileHistories(ledgerEntries, options.spanFor),
			)
		: "";

	const fileOps = extractFileOps(summaryInputBudget.messages);
	const conversationText = serializeConversation(summaryInputBudget.messages);
	const mergedUserRequests = mergeUserRequests(
		previousUserRequests,
		spanUserRequests,
	);
	const summaryRequest = buildSummaryRequest({
		previousSummary,
		conversationText,
		fileOps,
		promptTemplate: options.summaryPrompt,
		userRequests: mergeUserRequests(mergedUserRequests, pinnedUserRequests),
		userRequestBudgetChars: Math.floor(
			summarizerInputLimit * CHARS_PER_TOKEN * USER_REQUEST_BUDGET_SHARE,
		),
		toolLedger: ledgerEnabled ? renderToolLedgerKey(ledgerEntries) : "",
	});
	// Which of the three instructions actually ran. The diagnostics recorded
	// the strategy and the mode and could not answer "which prompt", so a
	// report that a prompt change had not worked could not be checked against
	// the record -- the prompt had to be reconstructed from the defaults and
	// the stored settings by hand.
	const summaryPromptKind = options.summaryPrompt?.trim()
		? "custom"
		: keepRecentMessages
			? "replay"
			: "full";
	options.logger?.debug("Agentic compaction summarizer diagnostics", {
		keepRecentMessages,
		summaryPromptKind,
		messagesToSummarize: messagesToSummarize.length,
		newMessagesToFold: newMessagesToFold.length,
		preservedMessages: messages.length - cutIndex + (pinnedMessage ? 1 : 0),
		pinnedPromptIndex: pinnedIndex,
		previousSummaryChars: previousSummary?.length ?? 0,
		conversationTextChars: conversationText.length,
		summaryRequestChars: summaryRequest.length,
		summaryRequestEstimatedTokens: estimateTokens(summaryRequest.length),
		newMessagesJsonChars: safeJsonSize(newMessagesToFold),
		summaryInputEstimatedTokens: summaryInputBudget.estimatedTokens,
		summaryInputActions: summaryInputBudget.actions.length,
		summaryInputWarnings: summaryInputBudget.warnings.map(
			(warning) => warning.code,
		),
		summaryRequestOverheadTokens,
		summarizerProviderId: summarizerProviderConfig.providerId,
		summarizerModelId: summarizerProviderConfig.modelId,
		summarizerInputLimit,
		maxInputTokens: options.context.budget.request.maxInputTokens,
		triggerTokens: options.context.budget.request.triggerTokens,
	});
	// Three failures, all recoverable, none of which used to be recovered from:
	// the call threw, the call came back empty, or the summary overran the
	// budget it has to fit. Each one used to end the compaction — and ending it
	// means handing the same oversized transcript to the next turn, one turn
	// larger, having spent a model call to achieve nothing.
	const summaryLimitTokens = outputBudgets.summaryMaxTokens;

	// Every model call this compaction makes goes through `generateSummary`
	// here, `generateThinkingSummary` below, or the council's `generate`
	// callback, so counting at those three points counts all of them --
	// including the retries, which is what makes a stalled-looking compaction
	// distinguishable from a slow one.
	const thinkingSummaryEnabled = options.thinkingSummaryEnabled !== false;
	const councilEnabled = options.councilEnabled !== false;
	const statusKind =
		options.context.mode === "manual"
			? "manual_compaction"
			: options.context.mode === "overflow_recovery"
				? "overflow_recovery_compaction"
				: "auto_compaction";
	const progress = createCompactionProgress(
		planCompactionSteps({ thinkingSummaryEnabled, councilEnabled }),
		({ step, stepTotal, stepLabel }) => {
			options.context.emitStatusNotice?.("compacting", {
				kind: statusKind,
				reason: statusKind,
				phase: "progress",
				step,
				stepTotal,
				stepLabel,
			});
		},
	);

	let summaryResult: SummaryGenerationResult | undefined;
	let lastFailure = "none";
	for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt += 1) {
		// Only the overrun retry changes the request, because only the overrun
		// gives the model something it did not already know. A throw and an
		// empty response are told nothing new: the same request is simply sent
		// again.
		const request =
			lastFailure === "over_budget" && summaryResult
				? `${summaryRequest}${describeOverrun(
						estimateTokens(summaryResult.text.length),
						summaryLimitTokens,
					)}`
				: summaryRequest;
		let candidate: SummaryGenerationResult | undefined;
		progress.step("summary");
		try {
			candidate = await generateSummary({
				providerConfig: summarizerProviderConfig,
				request,
				systemPrompt: keepRecentMessages
					? SUMMARIZER_SYSTEM_PROMPTS.tail
					: SUMMARIZER_SYSTEM_PROMPTS.full,
				logger: options.logger,
			});
		} catch (error) {
			// A cancelled compaction is not a failed one, and retrying it would
			// ignore the abort that asked it to stop.
			if (options.context.abortSignal?.aborted) {
				throw error;
			}
			lastFailure = "threw";
			options.logger?.log("Compaction summarizer call failed; retrying", {
				severity: "warn",
				attempt,
				attempts: SUMMARY_ATTEMPTS,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		// A model can answer with more than the summary. It can copy the
		// request's own transcript back -- the request ends `Conversation:` and
		// it keeps the document going -- and it can paste whole file bodies
		// into the blocks it was asked to trim. Both are removed before the
		// answer is judged, so an attempt that was nothing but the echo is
		// retried as the empty response it effectively is, and the budget check
		// measures the summary rather than the copy.
		const echoed = cutEchoedTranscript(candidate.text);
		if (echoed.cutChars > 0) {
			options.logger?.log(
				"Compaction summary copied its own request back; cut",
				{
					severity: "warn",
					attempt,
					cutChars: echoed.cutChars,
					keptChars: echoed.text.length,
				},
			);
		}
		let summaryText = echoed.text;
		if (keepRecentMessages) {
			const trimmedReplay = trimReplayOverflow(summaryText);
			if (trimmedReplay.trimmedBlocks > 0) {
				options.logger?.log(
					"Compaction replay pasted content it was asked to trim; elided",
					{
						severity: "warn",
						attempt,
						trimmedBlocks: trimmedReplay.trimmedBlocks,
					},
				);
			}
			summaryText = trimmedReplay.text;
		}
		if (candidate.incompleteReason && summaryText.trim()) {
			// A summary the output cap cut off ends mid-sentence, and what it
			// loses is its end -- where the work had got to and what was next,
			// which is the part the next turn reads first. Not a failure here:
			// a truncated summary still beats no compaction, and the retry
			// ladder has no lever that would make the next attempt shorter.
			options.logger?.log(
				"Compaction summary was cut short by the output cap",
				{
					severity: "warn",
					attempt,
					incompleteReason: candidate.incompleteReason,
					summaryChars: summaryText.length,
				},
			);
		}
		candidate = { ...candidate, text: summaryText };
		if (!candidate.text.trim()) {
			lastFailure = "empty";
			options.logger?.log(
				"Compaction summarizer returned no summary text; retrying",
				{
					severity: "warn",
					attempt,
					attempts: SUMMARY_ATTEMPTS,
					summarizerMaxOutputTokens: summarizerProviderConfig.maxOutputTokens,
					reasoningChars: candidate.reasoningChars,
					incompleteReason: candidate.incompleteReason,
					likelyCause:
						candidate.reasoningChars > 0
							? "output_budget_consumed_by_reasoning"
							: "empty_response",
				},
			);
			continue;
		}
		const candidateTokens = estimateTokens(candidate.text.length);
		if (candidateTokens > summaryLimitTokens) {
			lastFailure = "over_budget";
			summaryResult = candidate;
			options.logger?.log(
				"Compaction summary exceeded its output budget; retrying with the measurement",
				{
					severity: "warn",
					attempt,
					attempts: SUMMARY_ATTEMPTS,
					summaryTokens: candidateTokens,
					summaryLimitTokens,
				},
			);
			continue;
		}
		summaryResult = candidate;
		lastFailure = "none";
		break;
	}
	// An overrunning summary on the last attempt is kept, because it is a real
	// summary of the work and the alternative is no compaction at all. The
	// budget is a target the retry exists to hit, not a wall worth losing the
	// transcript over. An empty one is not kept: there is nothing in it.
	const rawSummary =
		lastFailure === "threw" || lastFailure === "empty"
			? ""
			: (summaryResult?.text ?? "");
	if (!rawSummary || !summaryResult) {
		options.logger?.log(
			"Skipped agentic compaction: the summarizer produced nothing usable",
			{
				severity: "warn",
				attempts: SUMMARY_ATTEMPTS,
				lastFailure,
				summarizerProviderId: summarizerProviderConfig.providerId,
				summarizerModelId: summarizerProviderConfig.modelId,
			},
		);
		return undefined;
	}

	const summary = ensureFilesSection(rawSummary, fileOps);
	// The text as the summarizer wrote it, before any reviewer touches it.
	// `generateSummary` fires for all five calls a compaction can make, so the
	// excerpt goes here rather than there: one line for the summary that was
	// actually kept, and the council logs its own stages separately.
	options.logger?.debug(
		`[compaction] summary (${summary.length} chars, prompt=${
			options.summaryPrompt?.trim()
				? "custom"
				: keepRecentMessages
					? "replay"
					: "full"
		}): ${logExcerpt(summary)}`,
	);
	// Built from what is being folded now, not from everything the session has
	// ever done. Earlier generations' calls are already prose in the summary
	// this one folds, and a ledger that accumulated across generations would
	// grow while the transcript shrank.
	//
	// Built from the whole fold rather than from the projected budget slice,
	// too: the projection drops tool results to make the *summary request* fit,
	// and a call whose result was dropped is exactly the one most worth a line
	// here — it is the one the model was never shown and so cannot have
	// described.
	// Switched off with checkpoints, because the ledger is the readable half of
	// the same machinery: it names the revision each file reached, and a
	// revision number is an address for `restore_file`. Offering those addresses
	// on a session that has no `restore_file` reads as an offer the session
	// cannot honour, and costs tokens on every compaction to make it.
	//
	// Explicitly, not inferred from `spanFor`. An absent revision lookup already
	if (thinkingSummaryEnabled) {
		progress.step("retrospective");
	}
	const rawThinkingSummary = await generateThinkingSummary({
		enabled: thinkingSummaryEnabled,
		messages: newMessagesToFold,
		previousThinkingSummary,
		promptTemplate: options.thinkingSummaryPrompt,
		maxOutputTokens: resolveThinkingSummaryMaxTokens({
			budgets: outputBudgets,
			summaryTokens: estimateTokens(summary.length),
		}),
		summarizer: options.summarizer,
		activeProviderConfig: options.providerConfig,
		summarizerInputLimit,
		logger: options.logger,
	});
	// The council reads the transcript the summary was written from, so it runs
	// on `newMessagesToFold` -- what this compaction is folding -- and not on
	// the carried summary above it, which no reviewer holds the evidence for.
	const reviewed =
		options.councilEnabled === false
			? {
					summary,
					thinkingSummary: rawThinkingSummary,
					reviewers: 0,
					merged: false,
				}
			: await runCouncilReview({
					summary,
					thinkingSummary: rawThinkingSummary,
					messages: newMessagesToFold,
					maxRequestChars: summarizerInputLimit * CHARS_PER_TOKEN,
					toolLedgerKey: ledgerEnabled
						? renderToolLedgerKey(ledgerEntries)
						: undefined,
					generate: (call) => (
						progress.step("review"),
						generateSummary({
							providerConfig: summarizerProviderConfig,
							request: call.request,
							systemPrompt: call.systemPrompt,
							logger: options.logger,
						}).then((result) => cutEchoedTranscript(result.text).text)
					),
					logger: options.logger,
				});
	const thinkingSummary = reviewed.thinkingSummary;
	// After the council, so a citation survives being rewritten: the writers
	// work on prose carrying `[#7]`, which is cheap to move around and cheap to
	// keep, where a spliced-in call would be four hundred characters they were
	// asked not to shorten.
	const spliced = ledgerEnabled
		? spliceLedgerCitations(reviewed.summary, ledgerEntries)
		: { text: reviewed.summary, cited: [], uncited: [], invalid: [] };
	if (ledgerEnabled && ledgerEntries.length > 0) {
		options.logger?.debug(
			`[compaction] ledger citations: ${spliced.cited.length} of ${ledgerEntries.length} placed inline` +
				(spliced.uncited.length > 0
					? `, ${spliced.uncited.length} appended (${spliced.uncited.slice(0, 12).join(", ")})`
					: "") +
				(spliced.invalid.length > 0
					? `, ${spliced.invalid.length} citing no such call (${spliced.invalid.slice(0, 12).join(", ")})`
					: ""),
		);
	}
	const reviewedSummary = ensureFilesSection(spliced.text, fileOps);
	if (reviewed.merged) {
		options.logger?.debug("Compaction council merged the summary", {
			reviewers: reviewed.reviewers,
			beforeChars: summary.length,
			afterChars: reviewedSummary.length,
		});
	}
	// Reported, not decided with. `estimateMessageTokens` serializes the whole
	// message, so summing it counts reasoning the provider is not sent on an
	// older turn and metadata that never leaves the host; the number printed
	// beside the context meter has to be the same quantity the meter shows.
	const measureReported =
		options.measureReportedTokens ??
		((list: readonly MessageWithMetadata[]) =>
			list.reduce(
				(total: number, message) =>
					total + options.estimateMessageTokens(message),
				0,
			));
	const tokensBefore = measureReported(messages);
	const resultMessages = [
		buildSummaryMessage({
			summary: reviewedSummary,
			fileOps,
			tokensBefore,
			userRunSpan: countUserRunMessages(messagesToSummarize),
			generation,
			thinkingSummary,
			toolLedger: ledgerEnabled
				? renderToolLedger(
						ledgerEntries.filter((entry) =>
							spliced.uncited.includes(entry.index),
						),
						collectFileHistories(ledgerEntries, options.spanFor),
					)
				: "",
			...(ledgerEnabled ? { toolLedgerEntries: ledgerEntries } : {}),
			userRequests: mergedUserRequests,
			userRequestBudgetChars: Math.floor(
				(options.context.budget.messages.targetTokens ?? 0) *
					CHARS_PER_TOKEN *
					USER_REQUEST_BUDGET_SHARE,
			),
		}),
		...(pinnedMessage ? [pinnedMessage] : []),
		...messages.slice(cutIndex),
	];
	const tokensAfter = measureReported(resultMessages);
	options.logger?.debug("Performed agentic compaction", {
		summaryPromptKind,
		toolLedgerChars: toolLedger.length,
		messagesBefore: messages.length,
		messagesAfter: resultMessages.length,
		messagesSummarized: messagesToSummarize.length,
		messagesPreserved: resultMessages.length - 1,
		tokensBefore,
		tokensAfter,
		maxInputTokens: options.context.budget.request.maxInputTokens,
	});
	const budgetActionCount = summaryInputBudget.actions.filter(
		(action) =>
			action.reason === "over_budget" || action.reason === "tool_pair_boundary",
	).length;
	return {
		messages: resultMessages,
		budget: {
			policyIntent: "agentic_summary",
			actionCount: budgetActionCount,
			warningCount: summaryInputBudget.warnings.length,
			liveTailHandling: summaryInputBudget.liveTailHandling,
		},
	};
}
