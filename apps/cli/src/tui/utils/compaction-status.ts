import type { ChatEntry, InteractiveCompactionResult } from "../types";

export type CompactionDividerEntry = Extract<ChatEntry, { kind: "compaction" }>;

function formatMessageCount(count: number): string {
	return `${count} ${count === 1 ? "message" : "messages"}`;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * Extracts a compaction divider entry from a status notice's metadata.
 * "started" notices produce a streaming (in-progress) divider; "completed"
 * notices produce the final divider with counters. Returns undefined for
 * non-compaction notices.
 */
export function parseCompactionNoticeMetadata(
	metadata: Record<string, unknown> | undefined,
): Omit<CompactionDividerEntry, "kind"> | undefined {
	if (
		!metadata ||
		(metadata.phase !== "started" &&
			metadata.phase !== "progress" &&
			metadata.phase !== "completed" &&
			metadata.phase !== "skipped")
	) {
		return undefined;
	}
	const kind = metadata.kind ?? metadata.reason;
	if (kind !== "auto_compaction" && kind !== "manual_compaction") {
		return undefined;
	}
	const compactionMode = kind === "manual_compaction" ? "manual" : "auto";
	if (metadata.phase === "started") {
		return { compactionMode, status: "started" };
	}
	// The same divider, saying which of its calls it is on. Both counters or
	// nothing: a progress notice without them would open a second divider.
	if (metadata.phase === "progress") {
		const step = asFiniteNumber(metadata.step);
		const stepTotal = asFiniteNumber(metadata.stepTotal);
		if (step === undefined || stepTotal === undefined) {
			return undefined;
		}
		return {
			compactionMode,
			status: "started",
			step,
			stepTotal,
			...(typeof metadata.stepLabel === "string" && metadata.stepLabel.trim()
				? { stepLabel: metadata.stepLabel }
				: {}),
		};
	}
	if (metadata.phase === "skipped") {
		return { compactionMode, status: "skipped" };
	}
	return {
		compactionMode,
		status: "completed",
		tokensBefore: asFiniteNumber(metadata.tokensBefore),
		tokensAfter: asFiniteNumber(metadata.tokensAfter),
		messagesBefore: asFiniteNumber(metadata.messagesBefore),
		messagesAfter: asFiniteNumber(metadata.messagesAfter),
		durationMs: asFiniteNumber(metadata.durationMs),
	};
}

export function formatTokenCount(count: number): string {
	if (count < 1_000) {
		return `${count}`;
	}
	if (count < 1_000_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	}
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Wall clock for a finished compaction: `48s`, `7m32s`, `1h04m`. Mirrors the
 * webview's formatDuration.
 */
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCompactionDividerLabel(
	entry: CompactionDividerEntry,
): string {
	if (entry.status === "started") {
		const base =
			entry.compactionMode === "manual"
				? "Compacting messages"
				: "Auto compacting messages";
		if (typeof entry.step === "number" && typeof entry.stepTotal === "number") {
			const stage = entry.stepLabel ? ` · ${entry.stepLabel}` : "";
			return `${base} (${entry.step}/${entry.stepTotal})${stage}`;
		}
		return base;
	}
	if (entry.status === "failed") {
		return "Compaction failed";
	}
	if (entry.status === "cancelled") {
		return "Compaction cancelled";
	}
	if (entry.status === "skipped") {
		return "Compaction skipped";
	}
	const parts: string[] = [
		entry.compactionMode === "manual"
			? "Context compacted (manual)"
			: entry.compactionMode === "inherited"
				? "Compacted working context carried over"
				: "Context compacted",
	];
	if (
		typeof entry.tokensBefore === "number" &&
		typeof entry.tokensAfter === "number"
	) {
		parts.push(
			`${formatTokenCount(entry.tokensBefore)} → ${formatTokenCount(entry.tokensAfter)} tokens`,
		);
	}
	if (
		typeof entry.messagesBefore === "number" &&
		typeof entry.messagesAfter === "number"
	) {
		parts.push(`${entry.messagesBefore} → ${entry.messagesAfter} messages`);
	}
	const label = parts.join(" · ");
	// Outside the dot-separated list: the others describe the transcript, this
	// describes the wait.
	return typeof entry.durationMs === "number"
		? `${label} (${formatDuration(entry.durationMs)})`
		: label;
}

export function formatCompactionStatus(
	result: InteractiveCompactionResult,
): string {
	if (result.messagesBefore === 0) {
		return "No messages to compact.";
	}
	if (!result.compacted) {
		return "No compaction needed.";
	}
	if (typeof result.workingContextMessagesAfter === "number") {
		return `Compacted working context to ${formatMessageCount(result.workingContextMessagesAfter)}; saved history remains ${formatMessageCount(result.messagesAfter)}.`;
	}
	if (result.messagesBefore === result.messagesAfter) {
		return `Compacted context; message count stayed at ${formatMessageCount(result.messagesAfter)}.`;
	}
	return `Compacted ${formatMessageCount(result.messagesBefore)} to ${formatMessageCount(result.messagesAfter)}.`;
}
