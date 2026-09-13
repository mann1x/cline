import { normalizeAtomicProtocolMode } from "@shared/AtomicProtocolSettings"
import { useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { latestPlan, openTransaction, transactionLabel } from "./change-protocol-status"

/**
 * The change protocol, where a developer actually meets it.
 *
 * In this panel rather than in Settings because engaging is a decision about
 * the bug in front of you, made partway through the work — and because the
 * check that decides it is part of the same decision. Settings keeps the two
 * limits and the Static configuration; nothing here can reach those.
 *
 * Under Static this shows status and nothing else. A run being measured must
 * not be perturbable from the chat, so there is nothing here to perturb it
 * with.
 */
const ChangeProtocolSection = () => {
	const { atomicProtocolSettings, atomicProtocolSession, clineMessages } = useExtensionState()
	const mode = normalizeAtomicProtocolMode(atomicProtocolSettings?.mode)
	const engaged = mode === "static" || atomicProtocolSession?.engaged === true
	const [busy, setBusy] = useState(false)

	const transaction = useMemo(() => openTransaction(clineMessages ?? [], engaged), [clineMessages, engaged])
	// The plan the model filed through the `plan` tool, if it has. Whether one
	// exists at all is the thing worth seeing at a glance -- a transaction with
	// no plan behind it is the shape that goes round in circles -- so the status
	// line says which, and the hover carries the plan itself.
	const plan = useMemo(() => (engaged ? latestPlan(clineMessages ?? []) : undefined), [clineMessages, engaged])
	const planTitle = engaged
		? plan
			? `Plan filed through the plan tool:\n\n${plan}`
			: "No plan filed through the plan tool yet."
		: undefined

	const post = useCallback(
		async (update: { engaged?: boolean; oracleCommand?: string; oracleExpect?: string; proposeCheck?: boolean }) => {
			setBusy(true)
			try {
				await StateServiceClient.updateSettings({
					metadata: {},
					atomicProtocolSession: update,
				} as never)
			} catch (error) {
				console.error("Failed to update the change protocol for this task:", error)
			} finally {
				setBusy(false)
			}
		},
		[],
	)

	if (mode === "off") {
		return null
	}

	return (
		<div className="mb-2.5 border-t border-[var(--vscode-panel-border)] pt-2.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium">Change Protocol</span>
				<span className="text-xs text-muted-foreground" data-testid="change-protocol-status" title={planTitle}>
					{mode === "static"
						? `Engaged for every task${transaction ? ` · ${transactionLabel(transaction)}` : ""}`
						: engaged
							? `Engaged${transaction ? ` · ${transactionLabel(transaction)}` : ""}`
							: "Not engaged"}
					{engaged ? (plan ? " · plan filed" : " · no plan") : ""}
				</span>
			</div>

			{mode === "static" ? (
				<p className="text-xs text-muted-foreground mt-1 mb-0">
					Configured in Settings and not changeable from here, so a run stays repeatable.
				</p>
			) : (
				<>
					<p className="text-xs text-muted-foreground mt-1 mb-1.5">
						Work as transactions: a few changes, then a check. If the check fails the files go back to what they were
						and the next attempt starts with a record of what was tried.
					</p>

					<label className="text-xs text-muted-foreground block mb-1" htmlFor="change-protocol-oracle">
						What decides whether this is fixed. Empty means the project's own test, typecheck or build.
					</label>
					<input
						className="w-full text-xs mb-1.5 bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] px-1.5 py-1"
						defaultValue={atomicProtocolSession?.oracleCommand ?? ""}
						disabled={busy}
						id="change-protocol-oracle"
						onBlur={(event) => post({ oracleCommand: event.target.value })}
						placeholder="node run_game.js index.html"
					/>

					<label className="text-xs text-muted-foreground block mb-1" htmlFor="change-protocol-expect">
						Optional: a pattern the output must match too, for a check that reports its verdict and exits cleanly
						either way.
					</label>
					<input
						className="w-full text-xs mb-1.5 bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] px-1.5 py-1"
						defaultValue={atomicProtocolSession?.oracleExpect ?? ""}
						disabled={busy}
						id="change-protocol-expect"
						onBlur={(event) => post({ oracleExpect: event.target.value })}
						placeholder={'"ok":\\s*true'}
					/>

					<label className="flex items-center gap-1.5 text-xs mb-2 cursor-pointer">
						<input
							checked={atomicProtocolSession?.proposeCheck !== false}
							disabled={busy}
							onChange={(event) => post({ proposeCheck: event.target.checked })}
							type="checkbox"
						/>
						<span className="text-muted-foreground">
							Where nothing can be run, let the model propose the check and ask you to approve it
						</span>
					</label>

					<button
						className="text-xs px-2 py-1 bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50"
						data-testid="change-protocol-engage"
						disabled={busy}
						onClick={() => post({ engaged: !engaged })}
						title={
							engaged
								? "Turn it off. Whatever transaction is open is judged once first, and its files are put back if the check fails — and never while the model is mid-edit."
								: "Turn it on for this task. Changes become transactions that are judged and put back if the check fails."
						}
						type="button">
						{engaged ? "Disengage" : "Engage"}
					</button>
				</>
			)}
		</div>
	)
}

export default ChangeProtocolSection
