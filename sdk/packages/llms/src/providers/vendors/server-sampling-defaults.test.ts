import { describe, expect, it } from "vitest";
import {
	formatSamplingDefault,
	readServerSamplingDefaults,
} from "./server-sampling-defaults";

// Measured on opencoti (192.168.178.2:8240, 2026-11-20): the params block as
// /props serves it, float32 noise and the random-seed sentinel included.
const PARAMS = {
	seed: 4294967295,
	temperature: 0.800000011920929,
	top_k: 64,
	top_p: 0.949999988079071,
	min_p: 0.0,
	typical_p: 1.0,
	repeat_last_n: 64,
	repeat_penalty: 1.0,
	presence_penalty: 0.03500000014901161,
	frequency_penalty: 0.0,
	n_keep: 0,
	samplers: ["penalties", "top_k"],
	chat_format: "Content-only",
	stream: false,
};

describe("formatSamplingDefault", () => {
	it("drops float32 noise", () => {
		expect(formatSamplingDefault("top_p", 0.949999988079071)).toBe("0.95");
		expect(formatSamplingDefault("presence_penalty", 0.03500000014901161)).toBe(
			"0.035",
		);
		expect(formatSamplingDefault("top_k", 64)).toBe("64");
	});

	it("names llama.cpp's random seed instead of printing it", () => {
		expect(formatSamplingDefault("seed", 4294967295)).toBe("random");
		expect(formatSamplingDefault("seed", 42)).toBe("42");
	});
});

describe("readServerSamplingDefaults", () => {
	it("reads /props at the root, asks for the model, keeps scalar numbers", async () => {
		let url = "";
		const fetchStub = (async (input: Parameters<typeof fetch>[0]) => {
			url = String(input);
			return new Response(
				JSON.stringify({ default_generation_settings: { params: PARAMS } }),
				{ status: 200 },
			);
		}) as typeof fetch;
		const read = await readServerSamplingDefaults(
			"http://host:8240/v1",
			"gemma 4",
			fetchStub,
		);
		expect(url).toBe("http://host:8240/props?model=gemma%204");
		expect(read.reachable).toBe(true);
		expect(read.parameters).toEqual({
			seed: "random",
			temperature: "0.8",
			top_k: "64",
			top_p: "0.95",
			min_p: "0",
			typical_p: "1",
			repeat_last_n: "64",
			repeat_penalty: "1",
			presence_penalty: "0.035",
			frequency_penalty: "0",
			n_keep: "0",
		});
	});

	it("answers nothing from a server without /props", async () => {
		const fetchStub = (async () =>
			new Response("not found", { status: 404 })) as typeof fetch;
		expect(
			await readServerSamplingDefaults(
				"http://vllm:8000/v1",
				undefined,
				fetchStub,
			),
		).toEqual({ reachable: true, parameters: {} });
	});

	it("is unreachable when the fetch throws, and without a base URL", async () => {
		const fetchStub = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		expect(
			await readServerSamplingDefaults("http://down:1", undefined, fetchStub),
		).toEqual({ reachable: false, parameters: {} });
		expect(await readServerSamplingDefaults(undefined)).toEqual({
			reachable: false,
			parameters: {},
		});
	});
});
