import {
	type AgentEvent,
	type AgentResult,
	mergeAgentHooks,
	type ProviderSettings,
	prewarmFileIndex,
	SessionSource,
	type UserInstructionConfigService,
} from "@cline/core";
import type { ConsecutiveMistakeLimitContext } from "@cline/shared";
import { createSessionId } from "@cline/shared";
import { logCliError } from "../logging/errors";
import { createCliCore } from "../session/session";
import { resolveClineWelcomeLine } from "../tui/interactive-welcome";
import {
	askQuestionInTerminal,
	requestToolApproval,
	submitAndExitInTerminal,
} from "../utils/approval";
import { formatCliErrorMessage } from "../utils/cline-pass-errors";
import { handleEvent, handleTeamEvent } from "../utils/events";
import {
	shouldZeroClineFreeModelCost,
	zeroCliAgentEventCost,
	zeroCliUsageCost,
} from "../utils/free-model-cost";
import { createRuntimeHooks } from "../utils/hooks";
import {
	c,
	emitJsonLine,
	formatUsd,
	getActiveCliSession,
	setActiveCliSession,
	writeErr,
	writeln,
} from "../utils/output";
import type { Config } from "../utils/types";
import { shouldShowCliUsageCost } from "../utils/usage-cost-display";
import { setActiveRuntimeAbort } from "./active-runtime";
import {
	CLI_DEFAULT_CHECKPOINT_CONFIG,
	CLI_DEFAULT_LOOP_DETECTION,
} from "./defaults";
import { describeAbortSource, resolveMistakeLimitDecision } from "./format";
import { buildUserInputMessage } from "./prompt";
import { subscribeToAgentEvents } from "./session-events";

function printModelProviderInfo(config: Config): void {
	const catalog = config.knownModels ? "live" : "bundled";
	const thinking = config.thinking ? "on" : "off";
	const { mode, providerId, modelId } = config;
	if (config.outputMode === "json") {
		emitJsonLine("stdout", {
			type: "run_start",
			providerId,
			modelId,
			catalog,
			thinking,
			mode,
			sessionId: getActiveCliSession()?.manifest.session_id,
		});
		return;
	}
	writeln(
		`${c.dim}[model] provider=${providerId} model=${modelId} catalog=${catalog} thinking=${thinking} mode=${mode}${c.reset}\n`,
	);
}

function emitAbortRequested(
	config: Config,
	reason: "sigint" | "sigterm",
): void {
	if (config.outputMode === "json") {
		emitJsonLine("stdout", { type: "run_abort_requested", reason });
	} else if (reason === "sigint") {
		writeln(`\n${c.dim}[abort] requested${c.reset}`);
	}
}

function emitTeamRestored(config: Config): void {
	const teamName = config.teamName ?? "(unknown team)";
	if (config.outputMode === "json") {
		emitJsonLine("stdout", { type: "team_restored", teamName });
		return;
	}
	writeln(
		`${c.dim}[team] restored persisted team state for "${teamName}"${c.reset}`,
	);
}

function printRunStats(
	config: Config,
	result: AgentResult,
	usage: AgentResult["usage"],
	startTime: number,
	reasoningChunkCount: number,
	redactedReasoningChunkCount: number,
): void {
	if (config.outputMode !== "text") {
		return;
	}
	if (config.verbose) {
		writeln();
		const parts: string[] = [];
		parts.push(`${((performance.now() - startTime) / 1000).toFixed(2)}s`);
		const tokenParts: string[] = [
			`${usage.inputTokens} in`,
			`${usage.outputTokens} out`,
		];
		if (usage.cacheReadTokens) {
			tokenParts.push(`${usage.cacheReadTokens} cache read`);
		}
		if (usage.cacheWriteTokens) {
			tokenParts.push(`${usage.cacheWriteTokens} cache write`);
		}
		parts.push(tokenParts.join(", "));
		if (
			shouldShowCliUsageCost(config.providerId) &&
			typeof usage.totalCost === "number"
		) {
			parts.push(`${formatUsd(usage.totalCost)} est. cost`);
		}
		if (result.iterations > 1) {
			parts.push(`${result.iterations} iterations`);
		}
		writeln(`${c.dim}[${parts.join(" | ")}]${c.reset}`);
		if (config.thinking) {
			writeln(
				`${c.dim}[thinking] chunks=${reasoningChunkCount} redacted=${redactedReasoningChunkCount}${c.reset}`,
			);
		}
	}
}

export async function runAgent(
	prompt: string,
	config: Config,
	userInstructionService?: UserInstructionConfigService,
	options?: {
		clineApiBaseUrl?: string;
		clineProviderSettings?: ProviderSettings;
	},
): Promise<void> {
	// A clean one-shot run should not inherit a stale nonzero process exit code
	// from lower layers or prior bookkeeping inside the same process.
	process.exitCode = 0;

	if (config.verbose) {
		const clineWelcomeLine = await resolveClineWelcomeLine({
			config,
			clineApiBaseUrl: options?.clineApiBaseUrl,
			clineProviderSettings: options?.clineProviderSettings,
		});
		if (clineWelcomeLine && config.outputMode !== "json") {
			writeln(clineWelcomeLine);
		}
	}

	const startTime = performance.now();
	void prewarmFileIndex(config.cwd).catch((error: unknown) => {
		logCliError(config.logger, "File index prewarm failed", { error });
	});

	const isYoloMode = config.mode === "yolo";
	const toolExecutors = {
		askQuestion: askQuestionInTerminal,
		submit: submitAndExitInTerminal,
	};
	const sessionManager = await createCliCore({
		capabilities: {
			toolExecutors,
			requestToolApproval,
		},
		forceLocalBackend: isYoloMode || config.sandbox === true,
		logger: config.logger,
		cwd: config.cwd,
		workspaceRoot: config.workspaceRoot,
		toolPolicies: config.toolPolicies,
	});
	const runtimeHooks = createRuntimeHooks({
		verbose: config.verbose,
		yolo: isYoloMode,
		cwd: config.cwd,
		workspaceRoot: config.workspaceRoot,
		dispatchHookEvent: async (payload) => {
			await sessionManager.ingestHookEvent(payload);
		},
	});

	let reasoningChunkCount = 0;
	let redactedReasoningChunkCount = 0;
	const displayedErrorMessages = new Set<string>();
	const shouldZeroCost = await shouldZeroClineFreeModelCost(config);

	const onAgentEvent = (rawEvent: AgentEvent): void => {
		const event = zeroCliAgentEventCost(rawEvent, shouldZeroCost);
		if (event.type === "content_start" && event.contentType === "reasoning") {
			reasoningChunkCount += 1;
			if (event.redacted) {
				redactedReasoningChunkCount += 1;
			}
		}
		if (
			event.type === "error" &&
			(!event.recoverable || config.verbose) &&
			event.error.message.trim()
		) {
			displayedErrorMessages.add(
				formatCliErrorMessage(event.error.message, {
					modelId: config.modelId,
				}).trim(),
			);
		}
		handleEvent(event, config);
	};
	const plannedSessionId = createSessionId();
	const unsubscribe = subscribeToAgentEvents(sessionManager, onAgentEvent, {
		sessionId: plannedSessionId,
	});

	// --- Abort & signal handling ---
	let abortRequested = false;
	let timedOut = false;
	let activeSessionId: string | undefined;

	const abortAll = () => {
		if (abortRequested) return false;
		abortRequested = true;
		if (activeSessionId) {
			sessionManager
				.abort(activeSessionId, new Error("Run-agent runtime abort requested"))
				.catch(() => {});
		}
		return true;
	};
	setActiveRuntimeAbort(abortAll);

	let cleanupDone: Promise<void> | undefined;
	const cleanupRuntime = () => {
		cleanupDone ??= (async () => {
			process.off("SIGINT", handleSigint);
			process.off("SIGTERM", handleSigterm);
			unsubscribe();
			await runtimeHooks.shutdown().catch(() => {});
			if (activeSessionId) {
				await sessionManager.stop(activeSessionId).catch(() => {});
			}
			await sessionManager.dispose("cli_run_shutdown").catch(() => {});
			setActiveRuntimeAbort(undefined);
		})();
		return cleanupDone;
	};

	const handleSigint = () => {
		if (abortAll()) {
			emitAbortRequested(config, "sigint");
			return;
		}
		void cleanupRuntime().finally(() => {
			process.exitCode = 0;
			process.exit(0);
		});
	};
	const handleSigterm = () => {
		if (abortAll()) {
			emitAbortRequested(config, "sigterm");
		}
	};
	process.on("SIGINT", handleSigint);
	process.on("SIGTERM", handleSigterm);

	// --- Main execution ---
	try {
		if (config.verbose) {
			printModelProviderInfo(config);
		}
		const {
			prompt: userInput,
			userImages,
			userFiles,
		} = await buildUserInputMessage(prompt, userInstructionService);

		// Both of these are armed before `start()`, because `start()` is what runs
		// the task. In non-interactive mode with a prompt it does not resolve until
		// the whole run is over, so a timeout scheduled after it was scheduled
		// after the thing it was meant to bound -- and then cleared immediately --
		// while `abortAll()` spent the entire run with no `activeSessionId` to
		// abort.
		//
		// Measured on one run: `-t 2400` never fired, SIGTERM at 2520s aborted
		// nothing, and the run went on for 3649s and nine further iterations. The
		// only mark either left was the word "aborted" in the closing summary.
		//
		// The id is safe to claim in advance -- it is the one passed in the config
		// below, and the event subscription above already depends on that.
		activeSessionId = plannedSessionId;
		const timeoutMs =
			typeof config.timeoutSeconds === "number" &&
			Number.isFinite(config.timeoutSeconds) &&
			config.timeoutSeconds > 0
				? config.timeoutSeconds * 1000
				: undefined;
		const timeoutId = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					abortAll();
				}, timeoutMs)
			: undefined;
		const clearRunTimeout = () => {
			if (timeoutId) clearTimeout(timeoutId);
		};

		const started = await sessionManager.start({
			source: SessionSource.CLI,
			config: {
				...config,
				sessionId: plannedSessionId,
				execution: {
					...config.execution,
					loopDetection:
						config.execution?.loopDetection ?? CLI_DEFAULT_LOOP_DETECTION,
				},
				checkpoint: config.checkpoint ?? CLI_DEFAULT_CHECKPOINT_CONFIG,
				// Merged, not replaced. The config carries the prompt-template hooks
				// that rewrite tool descriptions, and overwriting the field dropped
				// them -- silently, and completely in `--yolo`, where the runtime
				// layer is `undefined` and this assignment erased everything.
				hooks: mergeAgentHooks([config.hooks, runtimeHooks.hooks]),
				onTeamEvent: handleTeamEvent,
				onConsecutiveMistakeLimitReached: async (
					context: ConsecutiveMistakeLimitContext,
				) => resolveMistakeLimitDecision(config, context),
			},
			prompt: userInput,
			userImages: userImages.length > 0 ? userImages : undefined,
			userFiles: userFiles.length > 0 ? userFiles : undefined,
			interactive: false,
			localRuntime: {
				onTeamRestored: () => emitTeamRestored(config),
			},
		});

		// Reassigned in case the host handed back a different id than the one
		// claimed above; the abort path has been live throughout either way.
		activeSessionId = started.sessionId;
		setActiveCliSession({
			manifest: started.manifest,
		});

		// When start() already ran the first turn (non-interactive with prompt),
		// the session is finalized before start() returns. Use that result
		// directly; calling send() would fail with "session not found".
		let result: AgentResult | undefined;
		if (started.result) {
			clearRunTimeout();
			result = started.result;
		} else {
			result = await sessionManager
				.send({
					sessionId: started.sessionId,
					prompt: userInput,
					userImages: userImages.length > 0 ? userImages : undefined,
					userFiles: userFiles.length > 0 ? userFiles : undefined,
				})
				.finally(clearRunTimeout);
		}
		if (!result) {
			throw new Error("session manager did not return a result");
		}

		const usageSummary = await sessionManager.getAccumulatedUsage(
			started.sessionId,
		);
		const aggregateUsage = zeroCliUsageCost(
			usageSummary?.aggregateUsage,
			shouldZeroCost,
		);
		const usage = zeroCliUsageCost(
			aggregateUsage ?? usageSummary?.usage ?? result.usage,
			shouldZeroCost,
		);

		if (config.outputMode === "json") {
			emitJsonLine("stdout", {
				type: "run_result",
				finishReason: result.finishReason,
				iterations: result.iterations,
				usage,
				...(aggregateUsage ? { aggregateUsage } : {}),
				durationMs: result.durationMs,
				text: result.text,
				model: result.model,
			});
		}

		if (abortRequested || result.finishReason === "aborted") {
			if (timedOut) {
				writeErr(`run timed out after ${config.timeoutSeconds}s`);
				process.exitCode = 1;
				// Also on the JSON stream. A timeout used to be reported on stderr
				// only, so anything reading the machine-readable output saw a run
				// that stopped for no stated reason.
				if (config.outputMode === "json") {
					emitJsonLine("stdout", {
						type: "run_aborted",
						reason: "timeout",
						message: `run timed out after ${config.timeoutSeconds}s`,
					});
				}
			} else if (config.outputMode === "json") {
				// `external_abort` only when nothing else accounts for the stop. A
				// run that ended on its own mistake limit is not external to
				// anything, and calling it that sent every JSON consumer looking
				// for a second client that does not exist.
				const abortReason = result?.abortReason;
				emitJsonLine("stdout", {
					type: "run_aborted",
					reason: abortRequested
						? "local_abort"
						: abortReason
							? "stopped"
							: "external_abort",
					message: describeAbortSource({
						abortRequested,
						timedOut,
						abortReason,
					}),
				});
			} else {
				writeln(
					`${c.dim}[abort] ${describeAbortSource({ abortRequested, timedOut, abortReason: result?.abortReason })}${c.reset}`,
				);
			}
			writeln();
			return;
		}

		if (result.finishReason !== "completed") {
			const errorText = formatCliErrorMessage(result.text, {
				modelId: config.modelId,
			}).trim();
			if (
				errorText &&
				(config.outputMode === "json" || !displayedErrorMessages.has(errorText))
			) {
				writeErr(errorText);
			}
			process.exitCode = 1;
			return;
		}

		printRunStats(
			config,
			result,
			usage,
			startTime,
			reasoningChunkCount,
			redactedReasoningChunkCount,
		);
		process.exitCode = 0;
	} catch (err) {
		const message = formatCliErrorMessage(err, { modelId: config.modelId });
		logCliError(config.logger, "CLI task run failed", { error: err });
		writeErr(message);
		process.exitCode = 1;
	} finally {
		await cleanupRuntime();
	}
}
