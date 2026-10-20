import { describe, expect, it } from "vitest";
import { BUILTIN_PROMPT_TEMPLATE_FILES } from "../config/builtin-templates.generated";
import { AGENT_SUMMARY_PROMPT } from "../tools/team/agent-reports";
import { SWARM_REDUCER_PROMPT } from "../tools/team/spawn-swarm-tool";
import { SUBAGENT_BASE_PROMPT } from "../tools/team/subagent-layout";
import { SUMMARIZER_SYSTEM_PROMPTS } from "./agentic-compaction";
import {
	CAPPED_THINKING_SYSTEM_PROMPT,
	DEFAULT_CAPPED_THINKING_PROMPT,
} from "./capped-thinking";
import {
	DEFAULT_COMPACTION_PROMPT,
	DEFAULT_THINKING_COMPACTION_PROMPT,
} from "./compaction-shared";
import {
	COUNCIL_SYSTEM_PROMPTS,
	DEFAULT_COUNCIL_CRITIC_PROMPT,
	DEFAULT_COUNCIL_SYNTHESIZER_PROMPT,
	DEFAULT_COUNCIL_WRITER_PROMPT,
} from "./council-compaction";
import { DEFAULT_FULL_COMPACTION_PROMPT } from "./full-compaction";
import { DEFAULT_REPLAY_COMPACTION_PROMPT } from "./replay-compaction";

/**
 * What the model is shown as an example is read as a hint about its own task.
 *
 * Every example below was once lifted from the benchmark the fork is measured
 * on -- the file's name, the line its parse error is seeded at, the column of
 * the missing bracket, the collision the oracle checks -- and a model working
 * that benchmark was handed them in its tool descriptions and in every
 * condensation and compaction it read. Found on pandorum 2026-10-20, when a
 * condensed note named the example's `game.js` throughout a session working on
 * another file. Examples come from somewhere else.
 */
const BENCHMARK_DETAILS = [
	/manic_miner/i,
	/run_game/i,
	/game\.js/i,
	/collision/i,
	/left wall/i,
	/left_edge/i,
	/\bline 90\b/i,
	/\bline 274\b/i,
	/line 108, column 385/i,
	/"insert_line": 108/,
];

const PROMPTS: Record<string, string> = {
	AGENT_SUMMARY_PROMPT,
	CAPPED_THINKING_SYSTEM_PROMPT,
	COUNCIL_SYSTEM_PROMPTS: JSON.stringify(COUNCIL_SYSTEM_PROMPTS),
	DEFAULT_CAPPED_THINKING_PROMPT,
	DEFAULT_COMPACTION_PROMPT,
	DEFAULT_COUNCIL_CRITIC_PROMPT,
	DEFAULT_COUNCIL_SYNTHESIZER_PROMPT,
	DEFAULT_COUNCIL_WRITER_PROMPT,
	DEFAULT_FULL_COMPACTION_PROMPT,
	DEFAULT_REPLAY_COMPACTION_PROMPT,
	DEFAULT_THINKING_COMPACTION_PROMPT,
	SUBAGENT_BASE_PROMPT,
	SUMMARIZER_SYSTEM_PROMPTS: JSON.stringify(SUMMARIZER_SYSTEM_PROMPTS),
	SWARM_REDUCER_PROMPT,
	...Object.fromEntries(
		BUILTIN_PROMPT_TEMPLATE_FILES.map((file) => [file.fileName, file.raw]),
	),
};

describe("examples the model is shown", () => {
	for (const [name, text] of Object.entries(PROMPTS)) {
		it(`${name} borrows nothing from the benchmark`, () => {
			for (const detail of BENCHMARK_DETAILS) {
				expect(text).not.toMatch(detail);
			}
		});
	}
});
