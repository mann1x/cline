/**
 * The expert's transcript, saved like any delegated agent's.
 *
 * The expert runs outside the spawn tools, so nothing reported its start or end
 * to the session store, and its conversation lived only in memory. A report
 * from a finished task then held every agent's transcript but the one the task
 * had escalated to.
 */
import type { AgentResult } from "@cline/shared";
import type {
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../extensions/tools/team/spawn-agent-tool";
import type { ExpertRuntime } from "./expert-session";

/** The parent the expert's sub-session is filed under. */
export const EXPERT_PARENT_AGENT_ID = "lead";

/** What `withExpertTranscript` needs of the expert's runtime. */
export interface ExpertRuntimeWithTranscript extends ExpertRuntime {
	getAgentId(): string;
	getConversationId(): string;
	getMessages(): AgentResult["messages"];
}

export interface ExpertTranscriptSink {
	start(context: SubAgentStartContext): Promise<unknown> | unknown;
	end(context: SubAgentEndContext): Promise<unknown> | unknown;
}

/**
 * The expert's runtime, saving its messages after every ask.
 *
 * The first ask files the sub-session, with the brief as its task. Each ask
 * then writes the whole conversation so far, whether it answered, finished on
 * `error`, or threw. A sink that fails is ignored: saving is best-effort and
 * must never cost the escalation.
 */
export function withExpertTranscript(
	expert: ExpertRuntimeWithTranscript,
	sink: ExpertTranscriptSink,
): ExpertRuntime {
	let brief: string | undefined;
	const identity = () => ({
		subAgentId: expert.getAgentId(),
		conversationId: expert.getConversationId(),
		parentAgentId: EXPERT_PARENT_AGENT_ID,
		input: { name: "expert", task: brief ?? "" },
	});
	const quietly = async (write: () => Promise<unknown> | unknown) => {
		try {
			await write();
		} catch {
			// Best-effort, like every other sub-agent observer.
		}
	};
	return {
		async run(prompt: string): Promise<AgentResult> {
			if (brief === undefined) {
				brief = prompt;
				await quietly(() => sink.start(identity()));
			}
			try {
				const result = await expert.run(prompt);
				await quietly(() => sink.end({ ...identity(), agentResult: result }));
				return result;
			} catch (error) {
				await quietly(() =>
					sink.end({
						...identity(),
						agentResult: {
							messages: expert.getMessages(),
						} as AgentResult,
						error: error instanceof Error ? error : new Error(String(error)),
					}),
				);
				throw error;
			}
		},
		...(expert.shutdown
			? {
					shutdown: (reason?: string) =>
						expert.shutdown?.(reason) as Promise<void>,
				}
			: {}),
		...(expert.abort
			? { abort: (reason?: unknown) => expert.abort?.(reason) }
			: {}),
	};
}
