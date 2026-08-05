/**
 * Ask a model to rewrite its own prompt template.
 *
 * The shipped templates are written by us, against failures we watched happen.
 * That is a reasonable starting point and a poor stopping point: the whole
 * premise of per-family templates is that a Gemma reads differently from a
 * Qwen, and the model that knows most about how Gemma reads is a Gemma. So
 * this hands a model the template it would actually be given, tells it what
 * goes wrong in practice, and asks for a version in the form it would rather
 * receive.
 *
 * Runs against Ollama's cloud models, which are large enough to be worth
 * asking and are reached through the same local endpoint as everything else:
 *
 *   bun scripts/review-prompt-templates.mts
 *   bun scripts/review-prompt-templates.mts --model glm-4.7:cloud --model kimi-k3:cloud
 *   OLLAMA_HOST=http://pandorum:11439 bun scripts/review-prompt-templates.mts
 *
 * What comes back is a proposal, not a template. It is parsed and validated
 * before being written, so a review that produced something Cline cannot load
 * says so here rather than at the next session start, and nothing is copied
 * into `assets/` automatically — that stays a human decision.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_PROMPT_TEMPLATE_NAME,
	renderPromptTemplate,
} from "@cline/shared";
import { getBuiltinPromptTemplates } from "../src/extensions/config/builtin-templates";
import { generatePromptTemplate } from "../src/extensions/config/prompt-template-review";
import { getShippedToolCallSignatures } from "../src/extensions/config/shipped-tool-signatures";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(here, "..", "assets", "prompt-templates");
const DEFAULT_OUTPUT_DIR = join(here, "..", "..", "..", "..", "prompt-reviews");

/**
 * The two the templates were written for, so they review their own work first.
 * The others — glm, kimi, deepseek — come after these two have been checked by
 * hand, which is why they are arguments rather than defaults.
 */
const DEFAULT_MODELS = ["gemma4:31b-cloud", "qwen3.5:397b-cloud"];

/** A cloud model is a long call, and a rewrite of a 6KB prompt is a long one. */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * How many times to hand a model its own mistakes back.
 *
 * A regeneration is cheap and a flawed template is expensive, so it is worth
 * spending calls to get a clean one. Three is enough in practice: a model that
 * cannot fix a duplicated heading on the second try is not going to.
 */
const DEFAULT_ATTEMPTS = 3;

/**
 * Tools a rewrite has to address, because the instructions name the failure
 * each one exists to prevent. Everything else is the model's call.
 */
const REQUIRED_MENTIONS = ["check_file", "code_intel"];

interface Options {
	models: string[];
	host: string;
	outputDir: string;
	timeoutMs: number;
	attempts: number;
	/** Extra tools a rewrite must address, on top of REQUIRED_MENTIONS. */
	require: string[];
}

function parseArgs(argv: string[]): Options {
	const models: string[] = [];
	let host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
	let outputDir = DEFAULT_OUTPUT_DIR;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	let attempts = DEFAULT_ATTEMPTS;
	const require: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		switch (arg) {
			case "--model":
				if (!value) {
					throw new Error("--model needs a model name");
				}
				models.push(value);
				index++;
				break;
			case "--host":
				if (!value) {
					throw new Error("--host needs a URL");
				}
				host = value;
				index++;
				break;
			case "--out":
				if (!value) {
					throw new Error("--out needs a directory");
				}
				outputDir = value;
				index++;
				break;
			case "--timeout":
				if (!value) {
					throw new Error("--timeout needs seconds");
				}
				timeoutMs = Number(value) * 1000;
				index++;
				break;
			case "--require":
				if (!value) {
					throw new Error("--require needs a tool name");
				}
				require.push(value);
				index++;
				break;
			case "--attempts":
				if (!value) {
					throw new Error("--attempts needs a number");
				}
				attempts = Math.max(1, Math.trunc(Number(value)));
				index++;
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}

	if (!host.startsWith("http")) {
		host = `http://${host}`;
	}
	return {
		models: models.length > 0 ? models : DEFAULT_MODELS,
		host: host.replace(/\/+$/, ""),
		outputDir,
		timeoutMs,
		attempts,
		require,
	};
}

async function post(
	host: string,
	path: string,
	body: unknown,
	timeoutMs: number,
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${host}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`${path} returned ${response.status}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the model actually is, which is what a template matches on.
 *
 * A cloud model answers `/api/show` the same way a local one does, so the
 * review runs against the template the model would really be given rather
 * than one picked from its name.
 */
async function readFamily(
	host: string,
	model: string,
	timeoutMs: number,
): Promise<string | undefined> {
	try {
		const payload = (await post(host, "/api/show", { model }, timeoutMs)) as {
			details?: { family?: string };
			model_info?: Record<string, unknown>;
		};
		const family =
			payload.details?.family ??
			(payload.model_info?.["general.architecture"] as string | undefined);
		return typeof family === "string" && family.trim() !== ""
			? family.trim()
			: undefined;
	} catch (error) {
		console.warn(
			`  could not read the family for ${model}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

async function review(model: string, options: Options): Promise<boolean> {
	console.log(`\n${model}`);

	const family = await readFamily(options.host, model, options.timeoutMs);
	const templates = getBuiltinPromptTemplates();
	const rendered = renderPromptTemplate(templates, {
		providerId: "ollama",
		modelId: model,
		family,
	});
	const matchedName = rendered?.name;
	const isDefault =
		matchedName === undefined ||
		matchedName.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME;
	console.log(
		`  family=${family ?? "unknown"} template=${matchedName ?? "none"}`,
	);

	const defaultTemplate = readFileSync(
		join(TEMPLATE_DIR, "default.md"),
		"utf8",
	);
	const familyFileName = isDefault
		? undefined
		: templates.find((template) => template.name === matchedName)?.fileName;
	const familyTemplate = familyFileName
		? readFileSync(join(TEMPLATE_DIR, familyFileName), "utf8")
		: undefined;

	// Every tool a session can be handed. Without this the parser cannot tell a
	// section naming a real tool from one naming a tool the model invented.
	const knownToolNames = Object.keys(
		templates.find(
			(template) =>
				template.name.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME,
		)?.tools ?? {},
	);

	const fileName = `${model.replace(/[^a-zA-Z0-9._-]/g, "-")}.md`;
	const outputPath = join(options.outputDir, fileName);
	mkdirSync(options.outputDir, { recursive: true });

	try {
		const result = await generatePromptTemplate({
			defaultTemplate,
			familyTemplate,
			familyFileName,
			providerId: "ollama",
			modelId: model,
			family,
			knownToolNames,
			// The real argument shapes, so every example call the model writes is
			// audited against the schema it will actually be sent.
			toolSignatures: getShippedToolCallSignatures(),
			requiredMentions: [...REQUIRED_MENTIONS, ...options.require],
			expectedName: isDefault ? undefined : matchedName,
			fileName,
			attempts: options.attempts,
			complete: async (messages) => {
				const payload = (await post(
					options.host,
					"/api/chat",
					{
						model,
						stream: false,
						// This is a one-shot transform, not a problem to reason
						// about, and a reasoning model spends the whole budget
						// on the thinking block: deepseek-v4-flash times out at
						// forty minutes with it on and answers in two with it
						// off. The in-app generator disables reasoning for the
						// same reason; ignored by models that have none.
						think: false,
						options: { temperature: 0.2 },
						messages,
					},
					options.timeoutMs,
				)) as { message?: { content?: string } };
				return payload.message?.content ?? "";
			},
			onAttempt: (attempt, problems) => {
				for (const problem of problems) {
					console.warn(`  attempt ${attempt}: ${problem}`);
				}
			},
		});

		writeFileSync(outputPath, `${result.raw}\n`, "utf8");
		if (result.audit.problems.length === 0) {
			console.log(
				`  clean on attempt ${result.attempts}: system=${
					result.audit.template?.system ? "yes" : "no"
				} tools=${Object.keys(result.audit.template?.tools ?? {}).join(", ") || "none"}`,
			);
			console.log(`  wrote ${outputPath}`);
			return true;
		}
		console.error(
			`  NOT CLEAN after ${result.attempts} attempt(s); wrote the best of them to ${outputPath}`,
		);
		return false;
	} catch (error) {
		console.error(
			`  failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	console.log(`host=${options.host} out=${options.outputDir}`);

	let clean = true;
	for (const model of options.models) {
		// Sequential on purpose: these are large models on a shared endpoint,
		// and two of them at once is how one of them times out.
		clean = (await review(model, options)) && clean;
	}

	console.log(
		"\nNothing was copied into assets/prompt-templates. Read a proposal, keep what is better, then rerun the generator.",
	);
	process.exit(clean ? 0 : 1);
}

await main();
