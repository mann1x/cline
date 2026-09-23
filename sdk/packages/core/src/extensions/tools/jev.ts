/**
 * Jev: a second opinion with a number on it.
 *
 * TypeSafe's System One model, Jev, is not a chat model. It takes a piece of
 * text -- the "state" -- and a set of typed questions, and answers each with a
 * probability: a yes/no (`noul`), a pick among options you name (`choice`), or
 * a rating on levels you name (`score`). Choice and score answers also carry a
 * confidence derived from the distribution. It writes no prose, so it cannot
 * explain an answer; what it gives is the one thing a coding model is bad at
 * reporting about itself, which is how sure to be.
 *
 * Three consumers, one client:
 *  - the `jev` tool, which the model calls when it is unsure of a reading, a
 *    fact or a choice (the rule that tells it when is the host's);
 *  - {@link rankQuestionOptions}, which the host runs over a model-authored
 *    `ask_question` before the user sees it;
 *  - {@link appraiseEscalation}, which scores a task about to be handed to the
 *    expert, for the assessment the user and the expert both read.
 *
 * What the documentation says to design around, and this file does
 * (docs/knowledge-base/jev):
 *  - Questions in one request run in parallel and the state is billed once:
 *    thirteen questions in one call measured ~12x cheaper and ~10x faster than
 *    thirteen calls. So every consumer here asks everything in one request.
 *  - The state plus the longest question must fit 32k tokens, and irrelevant
 *    context lowers accuracy. So the state is bounded and made of named parts.
 *  - A noul has no confidence field; its value is the signal. Here it gets the
 *    same two-outcome confidence a choice between yes and no would, `2p - 1`
 *    for the likelier side, so one floor reads all three kinds.
 *  - It is literal and weak at arithmetic and multi-hop reasoning, and text in
 *    the state can steer it. Its answers are evidence, never an instruction,
 *    and everything here words them that way.
 */

import { type AgentTool, createTool } from "@cline/shared";

export const JEV_TOOL_NAME = "jev";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** The documented starting point for confidence-gated routing. */
export const JEV_DEFAULT_FLOOR = 0.6;
/** The documented bar for decisions that are costly to get wrong. */
export const JEV_DEFAULT_HIGH_STAKES_FLOOR = 0.85;
export const JEV_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A ceiling on each named part of a state, in characters.
 *
 * The documented bound is 32k tokens for the state plus the longest question,
 * and no tokenizer is published, so this cannot be checked exactly. At the
 * usual ~4 characters a token, six parts at this size stay well inside it.
 */
export const JEV_MAX_PART_CHARS = 12_000;
export const JEV_MAX_QUESTIONS = 10;

/** Where Jev is and how sure an answer has to be before it counts. */
export interface JevEndpoint {
	apiKey: string;
	/** Defaults to {@link JEV_DEFAULT_BASE_URL}. */
	baseUrl?: string;
	/** Defaults to {@link JEV_DEFAULT_MODEL}. Pin a version to keep tuned floors valid. */
	model?: string;
	/** Confidence at or above which an answer is acted on. */
	floor?: number;
	/** The same, for a question the caller marks as costly to get wrong. */
	highStakesFloor?: number;
	timeoutMs?: number;
}

export type JevQuestion =
	| {
			type: "noul";
			instructions: unknown;
			criteria?: { true?: unknown; false?: unknown };
	  }
	| { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
	| { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevAnswer =
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  }
	| {
			type: "score";
			score: number;
			legend?: Record<string, string>;
			probabilities: Record<string, number>;
			confidence: number;
	  };

export interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevCallOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	/** Waits between retries, for tests. */
	sleep?: (ms: number) => Promise<void>;
}

/** A failed Jev call, worded for whoever has to act on it. */
export class JevError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "JevError";
	}
}

/** Delays before the second and third attempt on a 429 or 529. */
const RETRY_DELAYS_MS = [400, 1_200];

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One evaluation: a state and its questions, answered.
 *
 * Retries only what the API says to retry, a 429 or a 529, and inside one
 * deadline for the whole call rather than per attempt: the SDK's default of 10 s
 * an attempt with two retries is 30 s nobody budgeted for, and every caller
 * here is holding up either a question to the user or an escalation.
 */
export async function evaluateJev(
	endpoint: JevEndpoint,
	request: { state: unknown; questions: Record<string, JevQuestion> },
	options: JevCallOptions = {},
): Promise<JevResponse> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		endpoint.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS,
	);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort);
	const url = `${trimSlash(endpoint.baseUrl || JEV_DEFAULT_BASE_URL)}/systemone`;
	const body = JSON.stringify({
		state: request.state,
		model: endpoint.model || JEV_DEFAULT_MODEL,
		questions: request.questions,
	});

	try {
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${endpoint.apiKey}`,
					},
					body,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted) {
					throw new JevError(
						options.signal?.aborted
							? "The Jev call was cancelled."
							: `Jev did not answer within ${Math.round((endpoint.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS) / 1000)} s.`,
					);
				}
				throw new JevError(
					`Jev could not be reached: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (response.ok) {
				const payload = (await response.json()) as Partial<JevResponse>;
				if (!payload || typeof payload.answers !== "object") {
					throw new JevError("Jev answered without an `answers` map.");
				}
				return {
					model: String(payload.model ?? ""),
					answers: payload.answers as Record<string, JevAnswer>,
					...(payload.usage ? { usage: payload.usage } : {}),
				};
			}
			const retryable = response.status === 429 || response.status === 529;
			const delay = RETRY_DELAYS_MS[attempt];
			if (retryable && delay !== undefined) {
				await sleep(delay);
				if (controller.signal.aborted) {
					throw new JevError("The Jev call was cancelled or timed out.");
				}
				continue;
			}
			const detail = (await response.text().catch(() => "")).slice(0, 400);
			throw new JevError(
				describeStatus(response.status, detail),
				response.status,
			);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function describeStatus(status: number, detail: string): string {
	switch (status) {
		case 401:
			return "Jev refused the API key (401). The key is set on the Jev tab of the API configuration settings.";
		case 422:
			return `Jev rejected the request as malformed (422): ${detail || "no detail given"}`;
		case 429:
			return "Jev is rate-limiting this key (429), and still was after two retries.";
		case 529:
			return "Jev is overloaded (529), and still was after two retries.";
		default:
			return `Jev returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
	}
}

/**
 * How sure an answer is, on one 0-1 scale for all three kinds.
 *
 * Choice and score carry their own. A noul is a choice between two outcomes,
 * so it gets the two-outcome form of the same measure: `2·p − 1` for the
 * likelier side, 0 at a coin flip and 1 at certainty. At the default floor of
 * 0.6 that asks for p ≥ 0.8 either way, which is where the documentation's own
 * examples draw the yes and no bands.
 */
export function jevConfidence(answer: JevAnswer): number {
	if (answer.type === "noul") {
		const p = clamp01(answer.noul);
		return Math.abs(2 * p - 1);
	}
	return clamp01(answer.confidence);
}

function clamp01(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
	return Math.min(1, Math.max(0, n));
}

function resolveFloor(endpoint: JevEndpoint, highStakes: boolean): number {
	const floor = highStakes
		? (endpoint.highStakesFloor ?? JEV_DEFAULT_HIGH_STAKES_FLOOR)
		: (endpoint.floor ?? JEV_DEFAULT_FLOOR);
	return Number.isFinite(floor) ? clamp01(floor) : JEV_DEFAULT_FLOOR;
}

/** Cut a state part to its ceiling, keeping the head and the tail. */
export function boundJevText(text: string, max = JEV_MAX_PART_CHARS): string {
	if (text.length <= max) {
		return text;
	}
	const half = Math.floor((max - 40) / 2);
	return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters cut] …\n${text.slice(-half)}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const JEV_TOOL_DESCRIPTION = `Get a calibrated confidence score from Jev, an external scoring model, before acting on something you are not sure of. Jev reads the context you give it and answers typed questions with probabilities; it writes no text and cannot explain itself.

Use it when you are unsure:
- whether you understood the user's request — ask whether the request is ambiguous, or which of your readings it means;
- whether a fact your answer rests on is supported by what you have read — put the source text in the context and ask whether it states the claim;
- which approach, option or file to choose;
- how complex the task is, before deciding to escalate or delegate it.

Arguments:
- \`context\` — the situation, in plain text: what the user asked, what you found, what you are deciding. Only what the questions need; unrelated text makes the answers worse.
- \`questions\` — 1 to 10, all asked in one call. Each has an \`id\`, a \`kind\` and a \`question\`:
  - \`yes_no\` — a yes/no question. Returns the probability of yes.
  - \`choice\` — pick one of \`options\` (2 to 50). Include a "none of these" option when that is possible: a choice always picks something.
  - \`score\` — rate on \`levels\` (2 to 10, lowest first).
  Set \`high_stakes: true\` on a question whose wrong answer is costly; it must clear a higher bar.

Each answer comes back as confident or unsure against the user's confidence floor. Act on a confident answer. On an unsure one, verify it yourself or ask the user — do not treat it as settled. Jev is weak at arithmetic, counting and multi-step reasoning, so check those in code, and ask one property per question rather than one broad question.`;

export const JEV_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		context: {
			type: "string",
			description:
				"The situation Jev should judge: the request, the evidence, the decision. Only what the questions need.",
		},
		questions: {
			type: "array",
			description: "1 to 10 questions, answered together.",
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description:
							"A short name for the question; the answer comes back under it.",
					},
					kind: {
						type: "string",
						enum: ["yes_no", "choice", "score"],
					},
					question: { type: "string" },
					options: {
						type: "array",
						items: { type: "string" },
						description: "For `choice`: the options, 2 to 50.",
					},
					levels: {
						type: "array",
						items: { type: "string" },
						description: "For `score`: the levels, lowest first, 2 to 10.",
					},
					high_stakes: {
						type: "boolean",
						description: "Hold this answer to the higher confidence bar.",
					},
				},
				required: ["id", "kind", "question"],
			},
		},
	},
	required: ["context", "questions"],
} as const;

interface ToolQuestion {
	id: string;
	kind: "yes_no" | "choice" | "score";
	question: string;
	options?: string[];
	levels?: string[];
	highStakes: boolean;
}

function readStrings(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** The model's questions, checked, or the reason they cannot be asked. */
export function readJevToolQuestions(
	value: unknown,
): { questions: ToolQuestion[] } | { error: string } {
	let raw = value;
	// Models send arrays as JSON text often enough to be worth one parse.
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { error: "`questions` must be an array of question objects." };
		}
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		return { error: "`questions` needs at least one question." };
	}
	if (raw.length > JEV_MAX_QUESTIONS) {
		return {
			error: `\`questions\` holds ${raw.length}; at most ${JEV_MAX_QUESTIONS} are asked in one call. Keep the ones the decision turns on.`,
		};
	}
	const questions: ToolQuestion[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		const item = (entry ?? {}) as Record<string, unknown>;
		const id =
			(typeof item.id === "string" && item.id.trim()) || `q${index + 1}`;
		if (seen.has(id)) {
			return {
				error: `Two questions share the id \`${id}\`; give each its own.`,
			};
		}
		seen.add(id);
		const question =
			typeof item.question === "string" ? item.question.trim() : "";
		if (!question) {
			return { error: `Question \`${id}\` has no \`question\` text.` };
		}
		const kind = item.kind;
		const highStakes = item.high_stakes === true;
		if (kind === "yes_no") {
			questions.push({ id, kind, question, highStakes });
		} else if (kind === "choice") {
			const options = [...new Set(readStrings(item.options))];
			if (options.length < 2 || options.length > 50) {
				return {
					error: `Choice \`${id}\` needs 2 to 50 distinct \`options\`; it has ${options.length}.`,
				};
			}
			questions.push({ id, kind, question, options, highStakes });
		} else if (kind === "score") {
			const levels = readStrings(item.levels);
			if (levels.length < 2 || levels.length > 10) {
				return {
					error: `Score \`${id}\` needs 2 to 10 \`levels\`, lowest first; it has ${levels.length}.`,
				};
			}
			questions.push({ id, kind, question, levels, highStakes });
		} else {
			return {
				error: `Question \`${id}\` has kind ${JSON.stringify(kind)}; use "yes_no", "choice" or "score".`,
			};
		}
	}
	return { questions };
}

function toJevQuestion(question: ToolQuestion): JevQuestion {
	switch (question.kind) {
		case "yes_no":
			return { type: "noul", instructions: question.question };
		case "choice":
			return {
				type: "choice",
				instructions: question.question,
				criteria: Object.fromEntries(
					(question.options ?? []).map((option) => [option, null]),
				),
			};
		case "score":
			return {
				type: "score",
				instructions: question.question,
				criteria: question.levels ?? [],
			};
	}
}

function percent(p: number): string {
	return `${Math.round(clamp01(p) * 100)}%`;
}

/** One answer, worded for the model, with its verdict against the floor. */
export function describeJevAnswer(
	question: ToolQuestion,
	answer: JevAnswer | undefined,
	floor: number,
): { line: string; sure: boolean } {
	if (!answer) {
		return { line: `- ${question.id}: no answer came back.`, sure: false };
	}
	const confidence = jevConfidence(answer);
	const sure = confidence >= floor;
	const verdict = sure
		? `confident (${confidence.toFixed(2)} ≥ ${floor.toFixed(2)})`
		: `UNSURE (${confidence.toFixed(2)} < ${floor.toFixed(2)})`;
	if (answer.type === "noul") {
		const p = clamp01(answer.noul);
		const side = p >= 0.5 ? "yes" : "no";
		return {
			line: `- ${question.id}: ${side} — P(yes) = ${p.toFixed(2)}; ${verdict}`,
			sure,
		};
	}
	if (answer.type === "choice") {
		const ranked = Object.entries(answer.probabilities ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([option, p]) => `${JSON.stringify(option)} ${percent(p)}`)
			.join(", ");
		return {
			line: `- ${question.id}: ${JSON.stringify(answer.choice)}; ${verdict}. Distribution: ${ranked}`,
			sure,
		};
	}
	const levels = question.levels ?? [];
	const nearest =
		levels[Math.round(answer.score)] ??
		answer.legend?.[String(Math.round(answer.score))];
	return {
		line: `- ${question.id}: ${answer.score.toFixed(2)} on 0–${levels.length - 1}${nearest ? ` (nearest: ${JSON.stringify(nearest)})` : ""}; ${verdict}`,
		sure,
	};
}

export interface JevToolOptions {
	/** Read per call; nothing means Jev is not configured. */
	getEndpoint: () => JevEndpoint | undefined;
	fetchImpl?: typeof fetch;
	onError?: (message: string, error: unknown) => void;
}

/**
 * Create the `jev` tool.
 *
 * The host omits it when Jev is not enabled or has no key; an endpoint that
 * disappears mid-session is still answered in words rather than a stack trace.
 */
export function createJevTool(options: JevToolOptions): AgentTool {
	return createTool({
		name: JEV_TOOL_NAME,
		description: JEV_TOOL_DESCRIPTION,
		inputSchema: JEV_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<string> => {
			const request = (input ?? {}) as {
				context?: unknown;
				questions?: unknown;
			};
			const state =
				typeof request.context === "string" ? request.context.trim() : "";
			if (!state) {
				return "`jev` needs a `context`: the request, the evidence and the decision the questions are about.";
			}
			const read = readJevToolQuestions(request.questions);
			if ("error" in read) {
				return read.error;
			}
			const endpoint = options.getEndpoint();
			if (!endpoint?.apiKey) {
				return "Jev is not configured, so nothing was scored. The user enables it and sets its key on the Jev tab of the API configuration settings; decide without it rather than calling again.";
			}
			try {
				const response = await evaluateJev(
					endpoint,
					{
						state: boundJevText(state, JEV_MAX_PART_CHARS * 2),
						questions: Object.fromEntries(
							read.questions.map((question) => [
								question.id,
								toJevQuestion(question),
							]),
						),
					},
					{
						...(context?.signal ? { signal: context.signal } : {}),
						...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
					},
				);
				const described = read.questions.map((question) =>
					describeJevAnswer(
						question,
						response.answers[question.id],
						resolveFloor(endpoint, question.highStakes),
					),
				);
				const unsure = read.questions
					.filter((_, index) => !described[index]?.sure)
					.map((question) => question.id);
				return [
					`Jev (${response.model || endpoint.model || JEV_DEFAULT_MODEL}):`,
					...described.map((entry) => entry.line),
					"",
					unsure.length === 0
						? "Every answer cleared the floor; act on them."
						: `Unsure: ${unsure.join(", ")}. Verify these yourself or ask the user before acting on them.`,
				].join("\n");
			} catch (error) {
				options.onError?.("[jev] evaluation failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `${message}\nNothing was scored; decide without Jev's answer.`;
			}
		},
	});
}

// ---------------------------------------------------------------------------
// ask_question: rank the options before the user sees them
// ---------------------------------------------------------------------------

/** Options under this share of the probability are dropped. */
export const JEV_DROP_BELOW = 0.05;

const RECOMMENDED_SUFFIX = /\s*\((?:recommended)\)\s*$/i;

export interface RankedOptions {
	/** What the user is shown, in the model's order, one marked recommended at most. */
	options: string[];
	/** The options Jev put under {@link JEV_DROP_BELOW}, as the model wrote them. */
	dropped: string[];
	/** The option marked recommended, if any cleared the floor. */
	recommended?: string;
	confidence: number;
	/** One line per option the user sees, for the question text. */
	scores: { option: string; probability: number }[];
}

/**
 * Apply Jev's answer to a question's options.
 *
 * Pure, so the rules are testable without a network: drop what Jev puts under
 * 5%, but never below two options, since a question with one answer is not a
 * question; recommend the top option only when the answer clears the floor,
 * and then replace the model's own mark rather than add a second one, because
 * the webview only honours a marker that appears exactly once.
 */
export function applyOptionRanking(
	options: readonly string[],
	probabilities: Readonly<Record<string, number>>,
	confidence: number,
	floor: number,
): RankedOptions {
	const bare = options.map((option) =>
		option.replace(RECOMMENDED_SUFFIX, "").trim(),
	);
	const p = (index: number) => clamp01(probabilities[bare[index] ?? ""]);
	const order = bare.map((_, index) => index).sort((a, b) => p(b) - p(a));
	const keep = new Set<number>(
		order.filter((index) => p(index) >= JEV_DROP_BELOW),
	);
	for (const index of order) {
		if (keep.size >= 2) {
			break;
		}
		keep.add(index);
	}
	const top = order[0];
	const recommend = top !== undefined && confidence >= floor ? top : undefined;
	const shown = bare
		.map((option, index) => ({ option, index }))
		.filter(({ index }) => keep.has(index));
	return {
		options: shown.map(({ option, index }) =>
			index === recommend ? `${option} (recommended)` : option,
		),
		dropped: options.filter((_, index) => !keep.has(index)),
		...(recommend !== undefined ? { recommended: bare[recommend] } : {}),
		confidence: clamp01(confidence),
		scores: shown.map(({ option, index }) => ({
			option,
			probability: p(index),
		})),
	};
}

/**
 * Ask Jev which of a question's options the user is most likely to want.
 *
 * One choice question over the options, judged against the conversation the
 * host passes in. The options go in bare: a model's own "(recommended)" mark
 * is exactly the kind of text in a state that steers the answer.
 */
export async function rankQuestionOptions(
	endpoint: JevEndpoint,
	input: { conversation: string; question: string; options: readonly string[] },
	call: JevCallOptions = {},
): Promise<RankedOptions> {
	const bare = [
		...new Set(
			input.options.map((option) =>
				option.replace(RECOMMENDED_SUFFIX, "").trim(),
			),
		),
	];
	const response = await evaluateJev(
		endpoint,
		{
			state: {
				conversation: boundJevText(input.conversation),
				question_to_user: boundJevText(input.question, 4_000),
			},
			questions: {
				preferred: {
					type: "choice",
					instructions:
						"The assistant is about to ask the user `question_to_user`. Given what the user has said in `conversation`, which option is the user most likely to choose?",
					criteria: Object.fromEntries(bare.map((option) => [option, null])),
				},
			},
		},
		call,
	);
	const answer = response.answers.preferred;
	if (!answer || answer.type !== "choice") {
		throw new JevError("Jev answered the option ranking with no choice.");
	}
	return applyOptionRanking(
		input.options,
		answer.probabilities ?? {},
		answer.confidence,
		resolveFloor(endpoint, false),
	);
}

/** The scores as a markdown footer for the question the user is shown. */
export function describeOptionRanking(ranked: RankedOptions): string {
	const lines = ranked.scores.map(
		({ option, probability }) => `- ${option}: ${percent(probability)}`,
	);
	const dropped = ranked.dropped.length
		? `\n\nLeft out as very unlikely (under ${percent(JEV_DROP_BELOW)}): ${ranked.dropped.map((option) => `“${option.replace(RECOMMENDED_SUFFIX, "")}”`).join(", ")}. Type it if you want one of them.`
		: "";
	const verdict = ranked.recommended
		? `confidence ${ranked.confidence.toFixed(2)}`
		: `confidence ${ranked.confidence.toFixed(2)}, too low to recommend one`;
	return `*Jev's read of which you are likely to pick (${verdict}):*\n${lines.join("\n")}${dropped}`;
}

// ---------------------------------------------------------------------------
// Escalation: score the task before it is handed over
// ---------------------------------------------------------------------------

export const JEV_COMPLEXITY_LEVELS = [
	"Trivial: a one-line or mechanical change",
	"Routine: a clear change in one or two places",
	"Involved: several parts must change together, with some design judgement",
	"Hard: subtle behaviour, many interacting parts, or unclear requirements",
	"Very hard: needs deep expertise or research to get right",
] as const;

/**
 * Score a task about to be escalated, worded as lines for the assessment.
 *
 * Two questions in one call: how complex the task is, and whether the run so
 * far looks stuck rather than progressing. Both are Jev's reading of the text it
 * was given -- the user's task, the model's own reason, the harness's counts --
 * and the lines say so, beside the measured ones rather than above them.
 */
export async function appraiseEscalation(
	endpoint: JevEndpoint,
	input: { task?: string; goal?: string; reason?: string; measured?: string },
	call: JevCallOptions = {},
): Promise<string[]> {
	const state: Record<string, string> = {};
	if (input.task?.trim()) state.user_task = boundJevText(input.task.trim());
	if (input.goal?.trim())
		state.handover_goal = boundJevText(input.goal.trim(), 4_000);
	if (input.reason?.trim())
		state.model_reason = boundJevText(input.reason.trim(), 4_000);
	if (input.measured?.trim())
		state.harness_measured = boundJevText(input.measured.trim(), 6_000);
	if (Object.keys(state).length === 0) {
		return [];
	}
	const response = await evaluateJev(
		endpoint,
		{
			state,
			questions: {
				complexity: {
					type: "score",
					instructions:
						"How complex is the software task in `user_task` (and `handover_goal`, the part being handed to a stronger model)?",
					criteria: [...JEV_COMPLEXITY_LEVELS],
				},
				stuck: {
					type: "noul",
					instructions:
						"Does the evidence in `harness_measured` and `model_reason` show the work is stuck — repeating failures without progress — rather than progressing?",
				},
			},
		},
		call,
	);
	const floor = resolveFloor(endpoint, false);
	const lines: string[] = [];
	const complexity = response.answers.complexity;
	if (complexity?.type === "score") {
		const level = JEV_COMPLEXITY_LEVELS[Math.round(complexity.score)] ?? "";
		const sure = complexity.confidence >= floor;
		lines.push(
			`Jev, an external scoring model, rates the task's complexity ${complexity.score.toFixed(1)} of 4 — ${level.split(":")[0] ?? level} — at confidence ${complexity.confidence.toFixed(2)}${sure ? "" : `, under the ${floor.toFixed(2)} floor, so treat it as a guess`}.`,
		);
	}
	const stuck = response.answers.stuck;
	if (stuck?.type === "noul") {
		const p = clamp01(stuck.noul);
		const sure = jevConfidence(stuck) >= floor;
		lines.push(
			`Jev puts the chance that the run is stuck rather than progressing at ${percent(p)}${sure ? "" : " — close enough to even that it says little"}.`,
		);
	}
	if (lines.length > 0) {
		lines.push(
			"Jev's lines are its reading of the text above, not a measurement: it saw the task, the model's reason and these counts, and nothing of the code.",
		);
	}
	return lines;
}
