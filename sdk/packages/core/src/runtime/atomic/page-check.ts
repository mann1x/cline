/**
 * A check the harness provides, for the workspaces that have none.
 *
 * `discoverOracle` finds a check by looking for a test runner, a compiler or a
 * build. A single-file page has none of those, and that is exactly the shape
 * of task this protocol keeps failing on: the model edits a game, cannot run
 * it, and the verdict falls back to its own word.
 *
 * Asking the model to name a shell command instead does not fix it — the
 * command it names may not be installed, and a check that cannot run judges
 * nothing. So this one is ours: no external program, no browser, nothing to
 * install. It builds a stub DOM, executes every `<script>` in the file and
 * pumps a bounded number of animation frames. A page that throws while
 * loading, throws in a frame, or never schedules a frame at all did not work.
 *
 * Ported from the harness oracle the atomic campaign was measured with, where
 * it decided every verdict across ~90 runs.
 */

import * as vm from "node:vm";
import { findScriptSyntaxError } from "../../extensions/tools/delimiter-balance";

/** Frames pumped by default: enough for a game to have run its loop. */
export const DEFAULT_PAGE_FRAMES = 30;

/** Longest any one script block may run before the page is judged stuck. */
const SCRIPT_TIMEOUT_MS = 10_000;

export interface PageCheckResult {
	ok: boolean;
	/** Why it failed, in the form the transaction's message quotes. */
	error?: string;
	framesRun: number;
	/** Whether the page had to be told to start rather than starting itself. */
	started: boolean;
	/** The page was not run at all, so `ok: false` judges nothing about it. */
	unchecked?: boolean;
}

/** Everything a canvas context is asked to do, swallowed. */
function canvasContext(): unknown {
	return new Proxy({} as Record<string, unknown>, {
		get(target, property) {
			if (property in target) {
				return target[property as string];
			}
			if (property === "canvas") {
				return { width: 640, height: 480 };
			}
			// Read and then done arithmetic on, so a function will not do.
			if (
				property === "globalAlpha" ||
				property === "lineWidth" ||
				property === "shadowBlur"
			) {
				return 1;
			}
			return (...args: unknown[]) => {
				if (property === "measureText") {
					return { width: (String(args[0] ?? "").length || 1) * 6 };
				}
				if (
					property === "createLinearGradient" ||
					property === "createRadialGradient"
				) {
					return { addColorStop() {} };
				}
				return undefined;
			};
		},
		set(target, property, value) {
			target[property as string] = value;
			return true;
		},
	});
}

function element(id: string): Record<string, unknown> {
	const node: Record<string, unknown> = {
		id,
		width: 640,
		height: 480,
		style: {},
		dataset: {},
		children: [] as unknown[],
		textContent: "",
		innerText: "",
		innerHTML: "",
		className: "",
		classList: {
			add() {},
			remove() {},
			toggle() {},
			contains: () => false,
		},
		getContext: () => canvasContext(),
		addEventListener() {},
		removeEventListener() {},
		appendChild(child: unknown) {
			(node.children as unknown[]).push(child);
			return child;
		},
		removeChild() {},
		setAttribute() {},
		getAttribute: () => null,
		focus() {},
		play: () => Promise.resolve(),
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			width: 640,
			height: 480,
			right: 640,
			bottom: 480,
		}),
	};
	return node;
}

function audioNode(): unknown {
	return new Proxy({} as Record<string, unknown>, {
		get(target, property) {
			if (property === "value") {
				return 0;
			}
			if (
				property === "frequency" ||
				property === "gain" ||
				property === "detune"
			) {
				return {
					value: 0,
					setValueAtTime() {},
					linearRampToValueAtTime() {},
					exponentialRampToValueAtTime() {},
					setTargetAtTime() {},
				};
			}
			if (property in target) {
				return target[property as string];
			}
			return () => audioNode();
		},
		set(target, property, value) {
			target[property as string] = value;
			return true;
		},
	});
}

/**
 * The script bodies in a page, and what to say when there are none.
 *
 * Two very different failures used to share one message, and both have
 * happened on a real run: a file truncated above its script (14 KB down to
 * 572 bytes, head and style and nothing else), and a file whose `<script>` is
 * there but never closed. The first is the file being destroyed; the second is
 * an edit that dropped the trailing tags. Reading the second as the first cost
 * two investigations.
 */
function scriptBodies(html: string): {
	blocks: string[];
	modules: number;
	error?: string;
} {
	// A browser runs a block as a classic script only when its type is absent
	// or a JavaScript type. Running a JSON, template or importmap block failed
	// a working page with "SyntaxError: Unexpected token ':'"; a module block is
	// counted, because it cannot be run here at all.
	let modules = 0;
	let others = 0;
	const blocks: string[] = [];
	for (const match of html.matchAll(
		/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
	)) {
		const type = /\btype\s*=\s*["']?([^"'\s>]+)/i
			.exec(match[1])?.[1]
			.toLowerCase();
		// A browser ignores the body of a `src=` script.
		if (match[2].trim() === "" || /\bsrc\s*=/i.test(match[1])) {
			continue;
		}
		if (type === "module") {
			modules += 1;
		} else if (type === undefined || CLASSIC_TYPES.has(type)) {
			blocks.push(match[2]);
		} else {
			others += 1;
		}
	}
	if (blocks.length > 0 || modules > 0 || others > 0) {
		return { blocks, modules };
	}
	const opened = (html.match(/<script\b[^>]*>/gi) ?? []).length;
	const closed = (html.match(/<\/script>/gi) ?? []).length;
	return {
		blocks,
		modules,
		error:
			opened > closed
				? `unclosed <script> (${opened} opened, ${closed} closed)`
				: "no script blocks",
	};
}

/** The `type` values a browser runs as a classic script. */
const CLASSIC_TYPES = new Set([
	"",
	"text/javascript",
	"application/javascript",
	"application/ecmascript",
	"text/ecmascript",
]);

/** A top-level `import` or `export`: module code, which `vm.Script` refuses. */
const MODULE_SYNTAX = /^[ \t]*(import\s*[\w{*"'$]|export\s)/m;

function describe(error: unknown, prefix = ""): string {
	const named =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: String(error ?? "unknown error");
	return prefix ? `${prefix}: ${named}` : named;
}

/**
 * Load a page the way a browser would, and say whether it ran.
 *
 * `source` is passed in rather than read here so the caller decides which
 * copy of the file is being judged — the working tree, or a snapshot restored
 * behind it, which is what validating a proposed check against the unmodified
 * files needs.
 */
export function checkPage(
	filePath: string,
	source: string,
	options: { frames?: number } = {},
): PageCheckResult {
	const frames = options.frames ?? DEFAULT_PAGE_FRAMES;
	const isPage = /\.html?$/i.test(filePath);
	const {
		blocks,
		modules,
		error: noScript,
	} = isPage
		? scriptBodies(source)
		: {
				blocks: [source],
				modules: MODULE_SYNTAX.test(source) ? 1 : 0,
				error: undefined,
			};
	if (noScript) {
		return { ok: false, error: noScript, framesRun: 0, started: false };
	}
	// Not run, so not judged: saying the page failed would send the model to
	// fix code a browser runs, and saying it passed would keep a broken one.
	if (modules > 0) {
		return {
			ok: false,
			unchecked: true,
			error:
				'its scripts are ES modules (import/export or type="module"), which this check cannot run',
			framesRun: 0,
			started: false,
		};
	}

	// Asked of a real parser before anything runs, because `vm` parses lazily
	// under Bun and would report a broken file as a clean one -- the same
	// false pass this whole check exists to close.
	const syntaxError = findScriptSyntaxError(filePath, source);
	if (syntaxError) {
		return { ok: false, error: syntaxError, framesRun: 0, started: false };
	}

	let pending: Array<(time: number) => void> = [];
	let framesRun = 0;
	// A `setInterval` loop is a game loop as much as `requestAnimationFrame`:
	// stubbed to nothing, a page driven by one was failed for never scheduling
	// a frame. Each live interval runs once per pumped frame.
	const intervals = new Map<number, (time: number) => void>();
	let nextInterval = 1;
	// Load events, which a browser fires once the scripts have run. Swallowed,
	// a page that starts in `window.onload` or a `load` listener never started.
	const lifecycle: Array<{ event: string; callback: () => void }> = [];
	const listen = (event: unknown, callback: unknown) => {
		if (
			(event === "load" || event === "DOMContentLoaded") &&
			typeof callback === "function"
		) {
			lifecycle.push({
				event: String(event),
				callback: callback as () => void,
			});
		}
	};

	const elements = new Map<string, Record<string, unknown>>();
	const getElementById = (id: string) => {
		const existing = elements.get(id);
		if (existing) {
			return existing;
		}
		const created = element(id);
		elements.set(id, created);
		return created;
	};

	const audioContext = function AudioContext() {
		return {
			currentTime: 0,
			destination: audioNode(),
			state: "running",
			createOscillator: () => audioNode(),
			createGain: () => audioNode(),
			createBiquadFilter: () => audioNode(),
			createBufferSource: () => audioNode(),
			createBuffer: () => ({ getChannelData: () => new Float32Array(128) }),
			resume: () => Promise.resolve(),
			close: () => Promise.resolve(),
		};
	};

	const sandbox: Record<string, unknown> = {
		document: {
			getElementById,
			querySelector: (selector: string) =>
				getElementById(String(selector).replace(/^[#.]/, "")),
			querySelectorAll: () => [],
			createElement: (tag: string) => element(tag),
			addEventListener: listen,
			removeEventListener() {},
			readyState: "loading",
			body: element("body"),
			documentElement: element("html"),
		},
		console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
		requestAnimationFrame: (callback: (time: number) => void) =>
			pending.push(callback),
		cancelAnimationFrame() {},
		setTimeout: (callback: unknown) => {
			if (typeof callback === "function") {
				pending.push(callback as (time: number) => void);
			}
			return 0;
		},
		clearTimeout() {},
		setInterval: (callback: unknown) => {
			if (typeof callback !== "function") {
				return 0;
			}
			const id = nextInterval++;
			intervals.set(id, callback as (time: number) => void);
			return id;
		},
		clearInterval: (id: unknown) => {
			intervals.delete(Number(id));
		},
		addEventListener: listen,
		removeEventListener() {},
		performance: { now: () => framesRun * 16.7 },
		Date,
		Math,
		JSON,
		AudioContext: audioContext,
		webkitAudioContext: audioContext,
		Image: function Image() {
			return element("img");
		},
		alert() {},
		localStorage: {
			getItem: () => null,
			setItem() {},
			removeItem() {},
		},
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);

	try {
		for (const block of blocks) {
			vm.runInContext(block, sandbox, { timeout: SCRIPT_TIMEOUT_MS });
		}
	} catch (error) {
		return { ok: false, error: describe(error), framesRun: 0, started: false };
	}

	// What a browser does next: the document is parsed, then the page loaded.
	(sandbox.document as Record<string, unknown>).readyState = "complete";
	const loaders = [
		...lifecycle.filter((entry) => entry.event === "DOMContentLoaded"),
		...lifecycle.filter((entry) => entry.event === "load"),
	].map((entry) => entry.callback);
	if (typeof sandbox.onload === "function") {
		loaders.push(sandbox.onload as () => void);
	}
	try {
		for (const loader of loaders) {
			loader();
		}
	} catch (error) {
		return {
			ok: false,
			error: describe(error, "load"),
			framesRun: 0,
			started: false,
		};
	}

	// Some pages start themselves; if this one waits to be told, tell it.
	let started = false;
	try {
		const start = sandbox.startGame ?? sandbox.start ?? sandbox.init;
		if (
			typeof start === "function" &&
			pending.length === 0 &&
			intervals.size === 0
		) {
			(start as () => void)();
			started = true;
		}
	} catch (error) {
		return {
			ok: false,
			error: describe(error, "start"),
			framesRun: 0,
			started: false,
		};
	}

	// Pumped by hand rather than by a timer, so the run is bounded and the same
	// every time: whatever the page schedules, it is called `frames` times.
	try {
		while (framesRun < frames) {
			const due = [...pending, ...intervals.values()];
			pending = [];
			if (due.length === 0) {
				break;
			}
			for (const callback of due) {
				callback(framesRun * 16.7);
			}
			framesRun += 1;
		}
	} catch (error) {
		return {
			ok: false,
			error: describe(error, `frame ${framesRun}`),
			framesRun,
			started,
		};
	}

	// A page that never schedules a frame is not running, however cleanly it
	// loaded — which is the whole complaint in "it's not working". Only asked
	// of a page: a plain script that runs to the end and stops is finished, not
	// stalled.
	if (isPage && framesRun === 0) {
		return {
			ok: false,
			error: "no animation frame was ever scheduled",
			framesRun: 0,
			started,
		};
	}
	return { ok: true, framesRun, started };
}
