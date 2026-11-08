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

/**
 * Frames pumped by default: ten seconds of a 60 fps loop.
 *
 * Thirty passed a game that threw on frame 31 (automaticum audit 2026-11-08,
 * B8). No bound catches everything; this one costs milliseconds and reaches
 * well past a game's first second.
 */
export const DEFAULT_PAGE_FRAMES = 600;

/** Longest any one script block may run before the page is judged stuck. */
const SCRIPT_TIMEOUT_MS = 10_000;

/**
 * Longest the load handlers, the start and all the frames together may run.
 *
 * They are driven from code running inside the page's context so this bound
 * holds over them. Called from here, a frame that never returned hung the
 * whole agent: the timeout covered only the script blocks.
 */
const PUMP_TIMEOUT_MS = 20_000;

export interface PageCheckResult {
	ok: boolean;
	/** Why it failed, in the form the transaction's message quotes. */
	error?: string;
	framesRun: number;
	/** Timeout callbacks run, which are not frames but can drive a loop. */
	timeoutsRun?: number;
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

function element(
	id: string,
	listen: (event: unknown, callback: unknown) => void = () => {},
): Record<string, unknown> {
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
		addEventListener: listen,
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
		const type = /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i
			.exec(match[1])?.[1]
			.toLowerCase();
		// A browser ignores the body of a `src=` script.
		if (match[2].trim() === "" || /(?:^|\s)src\s*=/i.test(match[1])) {
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

	// Asked of a real parser before anything runs, because `vm` parses lazily
	// under Bun and would report a broken file as a clean one -- the same
	// false pass this whole check exists to close. Modules included: they
	// cannot be run here, but they can be parsed, and one that does not parse
	// is not unchecked, it is broken (B7/P9).
	const syntaxError = findScriptSyntaxError(filePath, source);
	if (syntaxError) {
		return { ok: false, error: syntaxError, framesRun: 0, started: false };
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

	// Animation frames and live intervals are the frame loop; timeouts run in
	// order between frames but are not frames. Counted as one, a page that set
	// a single timeout and stopped "ran 1 frame" and passed (B8/P6).
	let frameQueue: Array<(time: number) => void> = [];
	let timeoutQueue: Array<() => void> = [];
	let framesRun = 0;
	let timeoutsRun = 0;
	let usedFrameApi = false;
	// A `setInterval` loop is a game loop as much as `requestAnimationFrame`:
	// stubbed to nothing, a page driven by one was failed for never scheduling
	// a frame. Each live interval runs once per pumped frame.
	const intervals = new Map<number, (time: number) => void>();
	let nextInterval = 1;
	// Every listener a page registers, by event, on any target. Load events
	// fire once the scripts have run; input events are how a page that waits
	// for a key or a click is started (B7/P10). Swallowed, neither happened.
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	const listen = (event: unknown, callback: unknown) => {
		if (typeof callback !== "function") {
			return;
		}
		const name = String(event);
		const list = listeners.get(name) ?? [];
		list.push(callback as (event: unknown) => void);
		listeners.set(name, list);
	};
	// What the page logged as an error. A browser shows it in red, and a game
	// that catches its own exception and logs it every frame is broken however
	// cleanly it keeps running (B8/P4).
	const loggedErrors: string[] = [];
	const logError = (...args: unknown[]) => {
		loggedErrors.push(
			args
				.map((arg) =>
					arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg),
				)
				.join(" "),
		);
	};

	const elements = new Map<string, Record<string, unknown>>();
	const getElementById = (id: string) => {
		const existing = elements.get(id);
		if (existing) {
			return existing;
		}
		const created = element(id, listen);
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
			createElement: (tag: string) => element(tag, listen),
			addEventListener: listen,
			removeEventListener() {},
			readyState: "loading",
			body: element("body", listen),
			documentElement: element("html", listen),
		},
		console: { log() {}, warn() {}, error: logError, info() {}, debug() {} },
		requestAnimationFrame: (callback: (time: number) => void) => {
			usedFrameApi = true;
			return frameQueue.push(callback);
		},
		cancelAnimationFrame() {},
		setTimeout: (callback: unknown) => {
			if (typeof callback === "function") {
				timeoutQueue.push(callback as () => void);
			}
			return 0;
		},
		clearTimeout() {},
		setInterval: (callback: unknown) => {
			if (typeof callback !== "function") {
				return 0;
			}
			usedFrameApi = true;
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
			return element("img", listen);
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

	if (loggedErrors.length > 0) {
		return {
			ok: false,
			error: `console.error while loading: ${loggedErrors[0]}`,
			framesRun: 0,
			started: false,
		};
	}

	// What a browser does next, driven from inside the page's context so the
	// timeout bounds it: the document is parsed, the page loaded, a page that
	// waits to be told is told, and the frames are pumped.
	const fire = (name: string, event: Record<string, unknown> = {}) => {
		for (const callback of listeners.get(name) ?? []) {
			callback({
				type: name,
				target: sandbox.document,
				preventDefault() {},
				stopPropagation() {},
				...event,
			});
		}
	};
	let phase = "load";
	let started = false;
	const host = {
		load: () => {
			(sandbox.document as Record<string, unknown>).readyState = "complete";
			fire("DOMContentLoaded");
			fire("load");
			if (typeof sandbox.onload === "function") {
				(sandbox.onload as () => void)();
			}
		},
		idle: () =>
			frameQueue.length === 0 &&
			timeoutQueue.length === 0 &&
			intervals.size === 0,
		// Some pages start themselves; one that waits to be told is told the
		// ways a player would: a start function, then a key, then a click.
		start: () => {
			phase = "start";
			const start = sandbox.startGame ?? sandbox.start ?? sandbox.init;
			if (typeof start === "function") {
				(start as () => void)();
				started = true;
			}
			for (const [name, event] of [
				["keydown", { key: " ", code: "Space", keyCode: 32, which: 32 }],
				["keyup", { key: " ", code: "Space", keyCode: 32, which: 32 }],
				["keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 }],
				["keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13 }],
				["mousedown", { button: 0, clientX: 320, clientY: 240 }],
				["pointerdown", { button: 0, clientX: 320, clientY: 240 }],
				["click", { button: 0, clientX: 320, clientY: 240 }],
				["touchstart", { touches: [{ clientX: 320, clientY: 240 }] }],
			] as const) {
				if (!host.idle()) {
					break;
				}
				if ((listeners.get(name) ?? []).length > 0) {
					fire(name, { ...event });
					started = true;
				}
			}
		},
		// One frame: the timeouts that are due, then every frame callback.
		step: () => {
			phase = `frame ${framesRun}`;
			const timeouts = timeoutQueue;
			timeoutQueue = [];
			for (const callback of timeouts) {
				callback();
				timeoutsRun += 1;
			}
			const due = [...frameQueue, ...intervals.values()];
			frameQueue = [];
			for (const callback of due) {
				callback(framesRun * 16.7);
			}
			if (due.length > 0) {
				framesRun += 1;
			}
			return due.length > 0 || timeoutQueue.length > 0 || intervals.size > 0;
		},
		frames,
		framesRun: () => framesRun,
		errors: () => loggedErrors.length,
	};
	sandbox.__pageCheckHost = host;
	try {
		vm.runInContext(
			`(function (h) {
				h.load();
				if (h.idle()) h.start();
				var guard = 0;
				while (h.framesRun() < h.frames && guard++ < h.frames * 4) {
					if (!h.step() || h.errors() > 0) break;
				}
			})(__pageCheckHost);`,
			sandbox,
			{ timeout: PUMP_TIMEOUT_MS },
		);
	} catch (error) {
		return {
			ok: false,
			error: describe(error, phase),
			framesRun,
			started,
		};
	} finally {
		delete sandbox.__pageCheckHost;
	}

	if (loggedErrors.length > 0) {
		return {
			ok: false,
			error: `console.error in ${phase}: ${loggedErrors[0]}`,
			framesRun,
			started,
		};
	}

	// A page that never schedules a frame is not running, however cleanly it
	// loaded — which is the whole complaint in "it's not working". Only asked
	// of a page: a plain script that runs to the end and stops is finished, not
	// stalled. A page run on timeouts alone has to keep scheduling them.
	if (isPage && framesRun === 0 && (usedFrameApi || timeoutsRun < 2)) {
		return {
			ok: false,
			error:
				timeoutsRun === 1
					? "no animation frame was ever scheduled: one setTimeout ran, and nothing was scheduled after it"
					: "no animation frame was ever scheduled",
			framesRun: 0,
			started,
		};
	}
	return { ok: true, framesRun, timeoutsRun, started };
}
