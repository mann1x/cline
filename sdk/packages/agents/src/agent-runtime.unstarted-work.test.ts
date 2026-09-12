import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/** A model that only ever talks: every turn is text and no tool call. */
class SilentModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private remaining: number) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const more = this.remaining-- > 0;
		return (async function* () {
			yield {
				type: "text-delta",
				text: more ? "I will fix it next." : "Done.",
			} as AgentModelEvent;
		})();
	}
}

/** Every reminder the runtime sent back, flattened to text. */
function nudges(model: SilentModel): string[] {
	const out: string[] = [];
	for (const request of model.requests) {
		for (const message of (request.messages ?? []) as AgentMessage[]) {
			if (message.role !== "user") {
				continue;
			}
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.map((part: { type?: string; text?: string }) =>
								part.type === "text" ? (part.text ?? "") : "",
							)
							.join("");
			if (text.startsWith("[SYSTEM]")) {
				out.push(text);
			}
		}
	}
	return out;
}

/**
 * The nudge for a model that has not started, as opposed to one that has
 * finished.
 *
 * "Your last message contained no tool calls" is the whole of what a silent
 * turn used to be told, and it is equally true of both. Measured on pandorum
 * session 1789230811792_qnyfa: the change protocol had TX-01 open, the model
 * spent three turns describing edits it never made, and neither nudge
 * mentioned the protocol or the empty transaction. It concluded the protocol
 * replaced its other instructions and the run ended with the file untouched.
 */
describe("the unstarted-work clause on the no-tool-call nudge", () => {
	it("appends what the host says has not started", async () => {
		const model = new SilentModel(2);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: {
				maxNoToolCallNudges: 2,
				describeUnstartedWork: () => " TX-01 is open with nothing in it.",
			},
		});

		await runtime.run("go");

		const seen = nudges(model);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toContain("contained no tool calls");
		expect(seen[0]).toContain("TX-01 is open with nothing in it.");
	});

	it("leaves the nudge alone when the host has nothing to add", async () => {
		const model = new SilentModel(2);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: {
				maxNoToolCallNudges: 2,
				describeUnstartedWork: () => undefined,
			},
		});

		await runtime.run("go");

		const seen = nudges(model);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toContain("contained no tool calls");
		expect(seen[0]).not.toContain("TX-01");
	});

	it("awaits a host that answers asynchronously", async () => {
		const model = new SilentModel(2);
		const runtime = new AgentRuntime({
			model,
			completionPolicy: {
				maxNoToolCallNudges: 2,
				describeUnstartedWork: async () => " TX-02 is open with nothing in it.",
			},
		});

		await runtime.run("go");

		expect(nudges(model)[0]).toContain("TX-02 is open with nothing in it.");
	});
});
