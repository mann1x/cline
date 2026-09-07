import { useTerminalDimensions } from "@opentui/react";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialog } from "@opentui-ui/dialog/react";
import { useCallback, useEffect, useRef } from "react";
import type { SlashCommandRegistry } from "../commands/slash-command-registry";
import { resolveSlashCommand } from "../commands/slash-command-registry";
import { ForkConfirmContent } from "../components/dialogs/fork-confirm";
import { HelpDialogContent } from "../components/dialogs/help-dialog";
import { withLoadingDialog } from "../components/dialogs/loading-dialog";
import { useSession } from "../contexts/session-context";
import type { AppView, TuiProps } from "../types";
import { hydrateSessionMessages } from "../utils/hydrate-messages";
import type { LocalSlashCommandInvocation } from "../utils/skill-command-input";
import { HistoryDialogContent } from "../views/history-view";
import { runLocalSlashCommandAction } from "./local-command-actions";
import type { OpenConfigOptions } from "./use-config-panel";

export function useLocalCommandActions(input: {
	slashCommandRegistry: SlashCommandRegistry;
	canForkSession: boolean;
	openAccount: () => void;
	openConfig: (options?: OpenConfigOptions) => void;
	openMcpManager: () => Promise<boolean>;
	openModelSelector: () => void;
	openSkills: (invocation?: LocalSlashCommandInvocation) => void;
	openThemePicker: () => void;
	refocusTextarea: () => void;
	setAppView: (view: AppView) => void;
	onClearConversation: () => Promise<void>;
	onResumeSession: TuiProps["onResumeSession"];
	onExportHistorySession: TuiProps["onExportHistorySession"];
	onDeleteHistorySession: TuiProps["onDeleteHistorySession"];
	onCompact: TuiProps["onCompact"];
	onDelegate: TuiProps["onDelegate"];
	onListAgents: TuiProps["onListAgents"];
	onFork: TuiProps["onFork"];
	onUndo: () => Promise<void>;
	onExit: TuiProps["onExit"];
}) {
	const dialog = useDialog();
	const session = useSession();
	const { height: termHeight } = useTerminalDimensions();
	const {
		slashCommandRegistry,
		canForkSession,
		openAccount,
		openConfig,
		openMcpManager,
		openModelSelector,
		openSkills,
		openThemePicker,
		refocusTextarea,
		setAppView,
		onClearConversation,
		onResumeSession,
		onExportHistorySession,
		onDeleteHistorySession,
		onCompact,
		onDelegate,
		onListAgents,
		onFork,
		onUndo,
		onExit,
	} = input;

	const openHistory = useCallback(async () => {
		const sessionId = await dialog.choice<string>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<string>) => (
				<HistoryDialogContent
					{...ctx}
					onExport={onExportHistorySession}
					onDelete={onDeleteHistorySession}
				/>
			),
		});
		if (sessionId) {
			try {
				await withLoadingDialog(dialog, "Loading session...", async () => {
					const result = await onResumeSession(sessionId);
					const { messages } = result;
					const entries = hydrateSessionMessages(messages);
					if (entries.length === 0) {
						session.appendEntry({
							kind: "error",
							text: `Session ${sessionId} has no messages to resume.`,
						});
					} else {
						session.clearEntries();
						// replaceEntries rather than appendEntry: appendEntry
						// stamps unstamped entries with the CURRENT mode, which
						// would lock hydrated history to the resume-time accent.
						session.replaceEntries(entries);
						if (typeof result.currentContextSize === "number") {
							session.setLastTotalTokens(result.currentContextSize);
						}
						if (typeof result.totalCost === "number") {
							session.setLastTotalCost(result.totalCost);
						}
						session.setHasSubmitted(true);
						setAppView("chat");
					}
				});
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `Failed to resume session: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		refocusTextarea();
	}, [
		dialog,
		onDeleteHistorySession,
		onExportHistorySession,
		onResumeSession,
		refocusTextarea,
		session,
		setAppView,
		termHeight,
	]);

	const openHelp = useCallback(async () => {
		await dialog.choice<void>({
			size: "large",
			style: { maxHeight: termHeight - 2 },
			content: (ctx: ChoiceContext<void>) => <HelpDialogContent {...ctx} />,
		});
		refocusTextarea();
	}, [dialog, refocusTextarea, termHeight]);

	const runCompact = useCallback(async () => {
		session.setIsRunning(true);
		session.appendEntry({
			kind: "compaction",
			compactionMode: "manual",
			status: "started",
		});
		try {
			const result = await onCompact();
			session.updateLastEntry((entry) =>
				entry.kind === "compaction" && entry.status === "started"
					? {
							...entry,
							status: result.compacted ? "completed" : "skipped",
							messagesBefore: result.messagesBefore,
							messagesAfter:
								result.workingContextMessagesAfter ?? result.messagesAfter,
						}
					: entry,
			);
		} catch (error) {
			const cancelled =
				error instanceof Error &&
				(error.name === "AbortError" || /abort/i.test(error.message));
			session.updateLastEntry((entry) =>
				entry.kind === "compaction" && entry.status === "started"
					? { ...entry, status: cancelled ? "cancelled" : "failed" }
					: entry,
			);
			if (!cancelled) {
				session.appendEntry({
					kind: "error",
					text: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		} finally {
			session.setIsRunning(false);
		}
	}, [onCompact, session]);

	// A /compact asked for mid-turn, held until the turn finishes
	// (mann1x/cline#70). A ref, not state: the queue is read by an effect on the
	// running edge, and re-rendering for it would buy nothing.
	const compactQueued = useRef(false);
	const queueCompact = useCallback(() => {
		if (compactQueued.current) {
			session.appendEntry({
				kind: "status",
				text: "Compaction is already queued for the end of this turn.",
			});
			return;
		}
		compactQueued.current = true;
		session.appendEntry({
			kind: "status",
			text: "Compaction queued. It will run as soon as this turn finishes.",
		});
	}, [session]);

	useEffect(() => {
		if (session.isRunning || !compactQueued.current) {
			return;
		}
		compactQueued.current = false;
		void runCompact();
	}, [session.isRunning, runCompact]);

	/**
	 * `/delegate <agent> <task>` -- hand work to a configured agent directly.
	 *
	 * The lead model is not asked whether to delegate and does not get a turn
	 * until the agent has reported back. With no task, this lists the agents
	 * rather than guessing at one: picking for the user is how the wrong agent
	 * gets a task that reads plausibly for either.
	 */
	const runDelegate = useCallback(
		async (invocation?: LocalSlashCommandInvocation) => {
			const rest = (invocation?.text ?? "")
				.replace(/^\s*\/delegate\b/, "")
				.trim();
			const [agentName, ...taskWords] = rest.split(/\s+/);
			const task = taskWords.join(" ").trim();

			if (!agentName || !task) {
				let available: Awaited<ReturnType<typeof onListAgents>> = [];
				try {
					available = await onListAgents();
				} catch {
					// Listing is best-effort; the usage line is the point.
				}
				session.appendEntry({
					kind: "status",
					text:
						available.length > 0
							? `Usage: /delegate <agent> <task>. Agents: ${available
									.map((agent) =>
										agent.profile || agent.modelId
											? `${agent.name} (${agent.profile ?? agent.modelId})`
											: agent.name,
									)
									.join(", ")}`
							: "No agents are configured. Agent files live in .cline/agents in this workspace, or in the Cline data directory.",
				});
				return;
			}

			session.setIsRunning(true);
			session.appendEntry({
				kind: "status",
				text: `Delegating to "${agentName}": ${task}`,
			});
			try {
				const result = await onDelegate(agentName, task);
				if (result.text.trim()) {
					session.appendEntry({ kind: "team", text: result.text.trim() });
				}
				session.appendEntry({
					kind: "status",
					text: `"${result.agentName}" finished in ${Math.round(
						result.durationMs / 1000,
					)}s over ${result.iterations} ${
						result.iterations === 1 ? "iteration" : "iterations"
					}.`,
				});
			} catch (error) {
				session.appendEntry({
					kind: "error",
					text: `Delegation failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			} finally {
				session.setIsRunning(false);
			}
		},
		[onDelegate, onListAgents, session],
	);

	const runFork = useCallback(async () => {
		if (!canForkSession) {
			session.appendEntry({
				kind: "status",
				text: "Fork is available after this session has messages.",
			});
			return;
		}
		const confirmed = await dialog.choice<boolean>({
			closeOnEscape: true,
			content: (ctx: ChoiceContext<boolean>) => <ForkConfirmContent {...ctx} />,
		});
		refocusTextarea();
		if (!confirmed) return;
		session.appendEntry({
			kind: "status",
			text: "Creating forked session...",
		});
		try {
			const result = await onFork();
			if (result) {
				session.updateLastEntry(() => ({
					kind: "status",
					text: `Forked into new session ${result.newSessionId}. This is now the active session. Use /history to switch sessions.`,
				}));
				if (result.carriedWorkingContext) {
					session.appendEntry({
						kind: "compaction",
						compactionMode: "inherited",
						status: "completed",
						messagesBefore: result.carriedWorkingContext.canonicalMessages,
						messagesAfter: result.carriedWorkingContext.workingContextMessages,
					});
				}
			} else {
				session.updateLastEntry(() => ({
					kind: "error",
					text: "Fork failed: could not read messages from the current session.",
				}));
			}
		} catch (error) {
			session.updateLastEntry(() => ({
				kind: "error",
				text: `Fork failed: ${error instanceof Error ? error.message : String(error)}`,
			}));
		}
	}, [canForkSession, dialog, onFork, refocusTextarea, session]);

	const handleSlashCommand = useCallback(
		(command: string, invocation?: LocalSlashCommandInvocation) => {
			const resolved = resolveSlashCommand(slashCommandRegistry, command);
			if (!resolved || resolved.execution !== "local") {
				return false;
			}
			return runLocalSlashCommandAction({
				name: resolved.name,
				isRunning: session.isRunning,
				invocation,
				openAccount,
				openConfig,
				openMcpManager,
				openModelSelector,
				openSkills,
				openThemePicker,
				runCompact,
				queueCompact,
				runDelegate,
				runFork,
				runUndo: onUndo,
				clearConversation: onClearConversation,
				openHelp,
				openHistory,
				exitCline: onExit,
			});
		},
		[
			onClearConversation,
			onExit,
			onUndo,
			openAccount,
			openConfig,
			openMcpManager,
			openHelp,
			openHistory,
			openModelSelector,
			openSkills,
			openThemePicker,
			runCompact,
			queueCompact,
			runDelegate,
			runFork,
			session.isRunning,
			slashCommandRegistry,
		],
	);

	return { handleSlashCommand, openHistory };
}
