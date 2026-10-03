import { subagentCancellation } from "@cline/core"
import type * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000
const MB = 1024 * 1024

/**
 * One line of the extension host's memory, for the Cerebriline log.
 *
 * The host is one process shared by every extension, so none of these numbers
 * is Cerebriline's alone. What the line gives is a trend beside our own
 * activity: a baseline at activation, and whether memory climbs while agents
 * run. Asked on 2026-10-03, with the host at 1.5 GB after 37 minutes, there
 * was nothing to read: a running host cannot be inspected from outside, and
 * the log held no figure.
 */
export function formatMemoryLine(
	usage: Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers">,
	uptimeSeconds: number,
	runningAgents: number,
): string {
	const mb = (bytes: number) => Math.round(bytes / MB)
	return (
		`[memory] rss=${mb(usage.rss)}MB heapUsed=${mb(usage.heapUsed)}MB heapTotal=${mb(usage.heapTotal)}MB ` +
		`external=${mb(usage.external)}MB arrayBuffers=${mb(usage.arrayBuffers)}MB ` +
		`agents=${runningAgents} uptime=${Math.round(uptimeSeconds)}s (extension host, shared by all extensions)`
	)
}

/** Log the host's memory now and every five minutes until the extension is disposed. */
export function startMemoryLog(context: Pick<vscode.ExtensionContext, "subscriptions">): void {
	const write = () => {
		try {
			Logger.log(formatMemoryLine(process.memoryUsage(), process.uptime(), subagentCancellation.running().length))
		} catch {
			// A figure for the log is never worth an error in the host.
		}
	}
	write()
	const timer = setInterval(write, MEMORY_LOG_INTERVAL_MS)
	timer.unref?.()
	context.subscriptions.push({ dispose: () => clearInterval(timer) })
}
