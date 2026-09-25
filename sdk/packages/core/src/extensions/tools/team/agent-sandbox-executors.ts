/**
 * Set up a delegated agent's private sandbox and the executor options that bind
 * every one of its file tools to the overlay.
 *
 * A delegated agent must not reuse the lead's executors: its file tools have to
 * resolve through the agent's overlay, and its shell has to run rooted at the
 * native launcher. `createBuiltinTools` builds its file executors from
 * `executorOptions`, so setting `overlay` there is what makes read, editor,
 * apply_patch, grep, sed and awk overlay-backed in one place — no per-executor
 * wiring to forget, and none of the lead's disk-backed overrides slipping
 * through to re-point a tool at the real workspace.
 *
 * The shell is the escape-prone part. It is bound to the launcher through
 * `bash.wrapSpawn`, and where the platform has no launcher there is no wrapper —
 * so `commandsEnabled` is false and the caller passes `enableBash: false`. An
 * un-wrapped command runs against the real workspace, so "no launcher" always
 * means "no run_commands", never "run it unsandboxed".
 */

import {
	type AgentSandbox,
	createAgentSandbox,
	createAgentSandboxSync,
	type SandboxBinaries,
} from "../../../runtime/sandbox/agent-sandbox";
import type { DefaultExecutorsOptions } from "../executors";

/**
 * The host's per-session capability to sandbox delegated agents. Supplied only
 * when isolation is turned on and the workspace/storage are known; absent means
 * delegated agents run exactly as before, sharing the lead's executors.
 *
 * The host owns the two things core cannot know: where the agent's overlay may
 * be written (persistent storage, never tmpfs), and where the native launcher
 * binaries live (shipped in the extension). `binaries` absent — or not built for
 * this platform — yields file isolation without a shell.
 */
export interface DelegatedSandboxProvider {
	/** The lead's workspace, read-only to every delegated agent. */
	workspaceRoot: string;
	/** The native command-sandbox binaries, when present for this platform. */
	binaries?: SandboxBinaries;
	/**
	 * A private overlay directory for the agent behind this spawning tool call.
	 * Distinct per call, and in persistent storage — copy-ups can be large, and
	 * tmpfs would lose them and pressure RAM.
	 */
	overlayRootFor(toolCallId: string): string;
}

export interface DelegatedSandboxOptions {
	/** The lead's workspace, read-only to the agent. */
	workspaceRoot: string;
	/** This agent's private overlay directory, in persistent host storage. */
	overlayRoot: string;
	/**
	 * The native command-sandbox binaries. Absent — or present but not built for
	 * this platform — means the agent gets file isolation but no shell.
	 */
	binaries?: SandboxBinaries;
	/**
	 * Executor tuning to carry over from the lead (timeouts, limits, shell). The
	 * overlay and the shell wrapper are set on top and win over anything here.
	 */
	base?: DefaultExecutorsOptions;
}

export interface DelegatedSandboxSetup {
	/** The sandbox, for the hand-back to the lead and for disposal. */
	sandbox: AgentSandbox;
	/** Pass straight to `createBuiltinTools({ executorOptions })`. */
	executorOptions: DefaultExecutorsOptions;
	/**
	 * Whether the agent has a shell. When false the caller passes
	 * `enableBash: false` so `run_commands` is left off the agent's tool list.
	 */
	commandsEnabled: boolean;
}

export async function setUpDelegatedSandbox(
	options: DelegatedSandboxOptions,
): Promise<DelegatedSandboxSetup> {
	return bindSandbox(
		await createAgentSandbox({
			workspaceRoot: options.workspaceRoot,
			overlayRoot: options.overlayRoot,
			binaries: options.binaries,
		}),
		options.base,
	);
}

/** {@link setUpDelegatedSandbox} for a caller that cannot await. */
export function setUpDelegatedSandboxSync(
	options: DelegatedSandboxOptions,
): DelegatedSandboxSetup {
	return bindSandbox(
		createAgentSandboxSync({
			workspaceRoot: options.workspaceRoot,
			overlayRoot: options.overlayRoot,
			binaries: options.binaries,
		}),
		options.base,
	);
}

function bindSandbox(
	sandbox: AgentSandbox,
	base: DefaultExecutorsOptions | undefined,
): DelegatedSandboxSetup {
	const commandsEnabled = sandbox.wrapSpawn != null;

	const executorOptions: DefaultExecutorsOptions = {
		...base,
		overlay: sandbox.overlay,
		bash: {
			...base?.bash,
			...(sandbox.wrapSpawn ? { wrapSpawn: sandbox.wrapSpawn } : {}),
		},
	};

	return { sandbox, executorOptions, commandsEnabled };
}
