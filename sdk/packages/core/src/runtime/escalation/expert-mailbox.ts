/**
 * What the base model says to the expert while the expert is still working.
 *
 * The escalation already had a channel in one direction and at one moment: the
 * base asks, the expert answers, and between those two points neither could say
 * anything to the other. That was tolerable while `escalate` blocked -- the base
 * was not running, so it had nothing to say -- and it is not tolerable now. The
 * base is live, it is being told what the expert is doing, and the two things it
 * is there for both require a channel: answering a question the expert asked,
 * and telling an expert that is going round in circles to stop.
 *
 * This is the same shape as the team mailbox next door in `multi-agent.ts`,
 * built separately rather than reused because that one is keyed by agent id
 * across a roster of teammates and carries a notification telling the recipient
 * to go and read its messages with a tool. There is exactly one expert, it has
 * no mailbox tool, and the message has to arrive in the turn rather than as an
 * invitation to fetch it.
 *
 * THE LABEL IS THE POINT. The expert reads this in the middle of its own work,
 * where an unlabelled paragraph is indistinguishable from the user speaking --
 * and a correction from the person who owns the task is worth more than one the
 * supervising model inferred from a note. Both are worth acting on and they are
 * not worth the same, so they are never merged. When the base is passing on
 * something the user said, it says so in its own words, inside its own message.
 */

export interface ExpertMailbox {
	/** Queue something for the expert's next turn. */
	send(text: string): void;
	/** Everything waiting, labelled and cleared. Nothing when empty. */
	take(): string | undefined;
	/** The escalation is over; nothing waiting is worth delivering. */
	clear(): void;
}

const HEADER = "== FROM THE MODEL SUPERVISING YOU, JUST NOW ==";

export function createExpertMailbox(): ExpertMailbox {
	const waiting: string[] = [];
	return {
		send(text) {
			const said = text.trim();
			if (said) {
				waiting.push(said);
			}
		},
		take() {
			if (waiting.length === 0) {
				return undefined;
			}
			// Everything at once, not one per turn. The expert reads its
			// mailbox once a turn, so holding the rest back would delay the
			// urgent message this exists to carry by exactly as many turns as
			// there are messages in front of it.
			const said = waiting.splice(0, waiting.length);
			return `${HEADER}\n\n${said.join("\n\n")}`;
		},
		clear() {
			waiting.length = 0;
		},
	};
}
