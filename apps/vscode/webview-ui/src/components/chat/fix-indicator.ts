import type { AtomicProtocolSessionSettings, AtomicProtocolSettings } from "@shared/AtomicProtocolSettings"

/**
 * What the middle segment of Plan | Fix | Act says.
 *
 * Pulled out of the component because it is the only part worth testing and the
 * component is not worth mounting for it: three states, and the wording of each
 * is the feature. Fix reports, it does not switch -- engaging is in the
 * auto-approve panel, next to the check it runs, because it can put files back.
 */
export interface FixIndicator {
	/** False dims the segment: the protocol is off and there is nothing to engage. */
	available: boolean
	/** True paints it green and bold: transactions are running right now. */
	engaged: boolean
	/** For assistive technology, which cannot see either of the above. */
	label: string
	/** Hover text, and the only place the user is told where the switch is. */
	title: string
}

export function describeFixIndicator(
	settings: AtomicProtocolSettings | undefined,
	session: AtomicProtocolSessionSettings | undefined,
): FixIndicator {
	const mode = settings?.mode ?? "off"
	// Static is engaged by definition and deliberately not switchable from the
	// chat, so it says so rather than sending the user to look for a switch that
	// would not be there.
	if (mode === "static") {
		return {
			available: true,
			engaged: true,
			label: "Change protocol engaged for every task",
			title: "Change protocol: Static. Every task runs as judged, revertible transactions, using the check in Settings. Not switchable from here.",
		}
	}
	if (mode === "on") {
		const engaged = session?.engaged === true
		return {
			available: true,
			engaged,
			label: engaged ? "Change protocol engaged for this task" : "Change protocol available, not engaged",
			title: engaged
				? "Change protocol engaged. Changes are made as transactions and put back if the check fails. Disengage it in the Auto-approve panel."
				: "Change protocol available. Engage it for this task in the Auto-approve panel, above the message box.",
		}
	}
	return {
		available: false,
		engaged: false,
		label: "Change protocol off",
		title: "Change protocol is off. Turn it on in Settings → Features → Change Protocol.",
	}
}
