// Does the page actually run?
//
// `node --check` only says the file parses, and the test source parses fine --
// it is missing two dozen functions, not a bracket. So the question "is it
// fixed" has to be answered by running it: build a stub DOM and canvas, execute
// every <script> block, start the game and pump a few animation frames. A
// ReferenceError for a function the model never wrote surfaces here and nowhere
// else.
//
//   node smoke.js <file.html> [frames]
//
// Prints one JSON object:
//   { ok, error, frames_run, started, state, player_frames, reached_playing }
//
// FRAMES DEFAULT IS 400, AND THAT IS THE WHOLE POINT.
//
// The game opens in a COUNTDOWN state and `update()` returns early for every
// frame of it. performance.now() here is framesRun * 16.7, the countdown steps
// once per 1000ms, and it starts at 3 -- so gameState flips to 'PLAYING' at
// frame 180 and the physics path first executes at frame 181. The old default
// of 30 frames never left the countdown. Nothing downstream of it ever ran:
// not collide(), not the enemy or item sweeps, not the camera.
//
// That made the oracle blind to the campaign's own injected fault. On
// 2026-09-11 run 0208 restored two of the three deleted functions, left
// `collide` called-but-undefined, and scored {"ok":true} -- a file that throws
// ReferenceError the instant the game actually starts. Its verdict was FIXED.
//
// So: pump past the countdown, and require that the physics actually ran.
// `player.frameCount` increments only on the physics path, which makes it the
// one unforgeable witness that the game is playing rather than merely loading.

const fs = require("node:fs");
const vm = require("node:vm");

const file = process.argv[2];
const FRAMES = Number(process.argv[3] || 400);

/** Everything a canvas context is asked to do, swallowed. */
function canvasContext() {
	return new Proxy(
		{},
		{
			get(target, prop) {
				if (prop in target) {
					return target[prop];
				}
				if (prop === "canvas") {
					return { width: 640, height: 480 };
				}
				// Property reads that game code does arithmetic on.
				if (
					prop === "globalAlpha" ||
					prop === "lineWidth" ||
					prop === "shadowBlur"
				) {
					return 1;
				}
				return (...args) => {
					// measureText is the one whose return value gets used.
					if (prop === "measureText") {
						return { width: (String(args[0] ?? "").length || 1) * 6 };
					}
					if (prop === "createLinearGradient" || prop === "createRadialGradient") {
						return { addColorStop() {} };
					}
					return undefined;
				};
			},
			set(target, prop, value) {
				target[prop] = value;
				return true;
			},
		},
	);
}

function element(id) {
	const el = {
		id,
		width: 640,
		height: 480,
		style: {},
		dataset: {},
		children: [],
		textContent: "",
		innerHTML: "",
		className: "",
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		getContext: () => canvasContext(),
		addEventListener() {},
		removeEventListener() {},
		appendChild(child) {
			el.children.push(child);
			return child;
		},
		removeChild() {},
		setAttribute() {},
		getAttribute: () => null,
		focus() {},
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			width: 640,
			height: 480,
			right: 640,
			bottom: 480,
		}),
	};
	return el;
}

function run() {
	const html = fs.readFileSync(file, "utf8");
	const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
		.map((m) => m[1])
		.filter((b) => b.trim());
	if (blocks.length === 0) {
		// Two very different failures used to share one message, and both have
		// happened: a file truncated above the script (14,127 bytes down to 572,
		// nothing left but head and style) and a file whose script is present but
		// never closed, so the pair this regex needs does not exist. The first is
		// the file being destroyed; the second is an edit that dropped the
		// trailing tags. Reading "no script blocks" as the first cost two
		// investigations, so the verdict now says which one it is.
		const opened = (html.match(/<script\b[^>]*>/gi) || []).length;
		const closed = (html.match(/<\/script>/gi) || []).length;
		const error =
			opened > closed
				? `unclosed <script> (${opened} opened, ${closed} closed)`
				: "no script blocks";
		return {
			ok: false,
			error,
			frames_run: 0,
			started: false,
			state: null,
			player_frames: 0,
			reached_playing: false,
		};
	}

	const elements = new Map();
	const getElementById = (id) => {
		if (!elements.has(id)) {
			elements.set(id, element(id));
		}
		return elements.get(id);
	};

	// Frames are pumped by hand rather than by a timer so the run is bounded and
	// deterministic: whatever the game schedules, we call it FRAMES times.
	let pending = [];
	let framesRun = 0;
	const requestAnimationFrame = (cb) => {
		pending.push(cb);
		return pending.length;
	};

	const audioNode = () =>
		new Proxy(
			{},
			{
				get(target, prop) {
					if (prop === "value") return 0;
					if (prop === "frequency" || prop === "gain" || prop === "detune") {
						return {
							value: 0,
							setValueAtTime() {},
							linearRampToValueAtTime() {},
							exponentialRampToValueAtTime() {},
							setTargetAtTime() {},
						};
					}
					if (prop in target) return target[prop];
					return () => audioNode();
				},
				set(target, prop, value) {
					target[prop] = value;
					return true;
				},
			},
		);

	const AudioContextStub = function () {
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

	const document = {
		getElementById,
		querySelector: (sel) => getElementById(String(sel).replace(/^[#.]/, "")),
		querySelectorAll: () => [],
		createElement: (tag) => element(tag),
		addEventListener() {},
		removeEventListener() {},
		body: element("body"),
		documentElement: element("html"),
	};

	const sandbox = {
		document,
		console: { log() {}, warn() {}, error() {}, info() {} },
		requestAnimationFrame,
		cancelAnimationFrame() {},
		setTimeout: (cb) => {
			if (typeof cb === "function") pending.push(cb);
			return 0;
		},
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		performance: { now: () => framesRun * 16.7 },
		Date,
		Math,
		JSON,
		AudioContext: AudioContextStub,
		webkitAudioContext: AudioContextStub,
		Image: function () {
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
			vm.runInContext(block, sandbox, { timeout: 10000 });
		}
	} catch (error) {
		return {
			ok: false,
			error: `${error.name}: ${error.message}`,
			frames_run: 0,
			started: false,
			state: null,
			player_frames: 0,
			reached_playing: false,
		};
	}

	// Some pages start themselves; if this one waits to be told, tell it.
	let started = false;
	try {
		if (typeof sandbox.startGame === "function" && pending.length === 0) {
			sandbox.startGame();
			started = true;
		}
	} catch (error) {
		return {
			ok: false,
			error: `startGame: ${error.name}: ${error.message}`,
			frames_run: 0,
			started: false,
			state: null,
			player_frames: 0,
			reached_playing: false,
		};
	}

	try {
		while (framesRun < FRAMES) {
			const due = pending;
			pending = [];
			if (due.length === 0) {
				break;
			}
			for (const cb of due) {
				cb(framesRun * 16.7);
			}
			framesRun += 1;
		}
	} catch (error) {
		return {
			ok: false,
			error: `frame ${framesRun}: ${error.name}: ${error.message}`,
			frames_run: framesRun,
			started,
			state: null,
			player_frames: null,
			reached_playing: false,
		};
	}

	// A game that never schedules a frame is not running, however cleanly it
	// loaded -- that is the whole complaint in "it's not working".
	if (framesRun === 0) {
		return {
			ok: false,
			error: "no animation frame was ever scheduled",
			frames_run: 0,
			started,
			state: null,
			player_frames: 0,
			reached_playing: false,
		};
	}

	// The game's top-level `let`/`const` bindings are not properties of the
	// sandbox object, but they ARE in the context's global lexical scope, so a
	// second script in the same context can read them.
	const probe = (expr) => {
		try {
			return vm.runInContext(expr, sandbox, { timeout: 2000 });
		} catch {
			return null;
		}
	};
	const state = probe("typeof gameState === 'string' ? gameState : null");
	const playerFrames = probe(
		"(typeof player === 'object' && player && typeof player.frameCount === 'number') ? player.frameCount : null",
	);
	const reachedPlaying = playerFrames !== null && playerFrames > 0;

	// Loading without throwing is not the bar. The complaint was "it's not
	// working", and a game stuck in its countdown forever is not working.
	if (!reachedPlaying) {
		return {
			ok: false,
			error:
				state === null
					? `physics never ran: player.frameCount unreadable after ${framesRun} frames`
					: `physics never ran: still in ${state} after ${framesRun} frames (countdown ends at frame 180)`,
			frames_run: framesRun,
			started,
			state,
			player_frames: playerFrames,
			reached_playing: false,
		};
	}

	return {
		ok: true,
		error: null,
		frames_run: framesRun,
		started,
		state,
		player_frames: playerFrames,
		reached_playing: true,
	};
}

try {
	console.log(JSON.stringify(run()));
} catch (error) {
	console.log(
		JSON.stringify({
			ok: false,
			error: `harness: ${error.message}`,
			frames_run: 0,
			started: false,
			state: null,
			player_frames: 0,
			reached_playing: false,
		}),
	);
}
