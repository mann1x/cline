import { polykvRoot } from "./polykv";

/**
 * llama.cpp's "pick a random seed" value (`LLAMA_DEFAULT_SEED`, 0xFFFFFFFF).
 * Shown as a word because the number reads like a seed someone chose.
 */
const LLAMA_RANDOM_SEED = 4294967295;

/**
 * The server stores samplers as float32 and serialises them back as doubles,
 * so `0.95` arrives as `0.949999988079071`. Six significant digits is more
 * than any sampler is set to and less than float32 noise reaches.
 */
export function formatSamplingDefault(name: string, value: number): string {
	if (name === "seed" && value === LLAMA_RANDOM_SEED) {
		return "random";
	}
	return String(Number(value.toPrecision(6)));
}

/**
 * What a request that leaves a sampler out gets, from the server's own
 * `/props` (`default_generation_settings.params`), keyed by llama.cpp's names.
 *
 * That object is the server's answer after its start flags and the GGUF's
 * own sampling metadata are applied -- the values a blank field in the
 * settings leaves in force, which is the question the placeholder answers.
 * Only scalar numbers are kept; the sampler order and the like are not fields.
 *
 * `model` is passed for a llama-server in router mode, which answers `/props`
 * per model; a single-model server ignores it. Read fresh: the server may have
 * been restarted with other flags or another model.
 */
export async function readServerSamplingDefaults(
	baseUrl: string | undefined,
	model?: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 5_000,
): Promise<{ reachable: boolean; parameters: Record<string, string> }> {
	if (!baseUrl) {
		return { reachable: false, parameters: {} };
	}
	try {
		const query = model ? `?model=${encodeURIComponent(model)}` : "";
		const response = await fetchImpl(`${polykvRoot(baseUrl)}/props${query}`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return { reachable: true, parameters: {} };
		}
		const body = (await response.json()) as {
			default_generation_settings?: { params?: unknown };
		};
		const params = body.default_generation_settings?.params;
		const parameters: Record<string, string> = {};
		if (params && typeof params === "object") {
			for (const [name, value] of Object.entries(params)) {
				if (typeof value === "number" && Number.isFinite(value)) {
					parameters[name] = formatSamplingDefault(name, value);
				}
			}
		}
		return { reachable: true, parameters };
	} catch {
		return { reachable: false, parameters: {} };
	}
}
