import type { CliCompactionMode, Config } from "./types";

export const CLI_COMPACTION_MODES = ["basic", "agentic", "off"] as const;

export const DEFAULT_CLI_COMPACTION_MODE: Extract<
	CliCompactionMode,
	"agentic" | "basic"
> = "agentic";

const CLI_COMPACTION_MODE_ALIASES: Record<string, CliCompactionMode> = {
	agentic: "agentic",
	basic: "basic",
	off: "off",
};

const CLI_COMPACTION_MODE_LABELS = {
	agentic: "LLM",
	basic: "Truncation",
	off: "Off",
} as const satisfies Record<CliCompactionMode, string>;

export const CLI_COMPACTION_MODE_OPTION_DESCRIPTION =
	"Context compaction mode: agentic|basic|off (default: agentic)";

export const CLI_COMPACTION_MODE_EXPECTED_TEXT = '"agentic", "basic", or "off"';

export function parseCliCompactionMode(
	value: string,
): CliCompactionMode | undefined {
	return CLI_COMPACTION_MODE_ALIASES[value.trim().toLowerCase()];
}

export function buildCliCompactionConfig(
	mode?: CliCompactionMode,
	/**
	 * The compaction from which the recency tail is dropped, when a run says.
	 *
	 * Passed through rather than defaulted here: core carries the measured
	 * number, and a default repeated in the caller is one that goes stale
	 * silently. `0` is a value and not an absence -- it is how the behaviour is
	 * turned off -- so it must not meet a `??` on the way down.
	 */
	forceFullFromCompaction?: number,
): NonNullable<Config["compaction"]> {
	if (mode === "off") {
		return { enabled: false };
	}
	const tail =
		forceFullFromCompaction === undefined ? {} : { forceFullFromCompaction };
	if (mode === undefined) {
		return { enabled: true, ...tail };
	}
	return { enabled: true, strategy: mode, ...tail };
}

export function getCliCompactionMode(config: Config): CliCompactionMode {
	if (config.compaction?.enabled === false) {
		return "off";
	}
	return config.compaction?.strategy ?? DEFAULT_CLI_COMPACTION_MODE;
}

export function applyCliCompactionMode(
	config: Config,
	mode: CliCompactionMode | undefined,
): void {
	if (mode === undefined) {
		return;
	}
	if (mode === "off") {
		const { strategy: _strategy, ...rest } = config.compaction ?? {};
		config.compaction = {
			...rest,
			enabled: false,
		};
		return;
	}

	config.compaction = {
		...config.compaction,
		enabled: true,
		strategy: mode,
	};
}

export function getNextCliCompactionMode(
	mode: CliCompactionMode,
): CliCompactionMode {
	const currentIndex = CLI_COMPACTION_MODES.indexOf(mode);
	const safeIndex = currentIndex >= 0 ? currentIndex : 0;
	return CLI_COMPACTION_MODES[(safeIndex + 1) % CLI_COMPACTION_MODES.length];
}

export function formatCliCompactionMode(mode: CliCompactionMode): string {
	return CLI_COMPACTION_MODE_LABELS[mode];
}
