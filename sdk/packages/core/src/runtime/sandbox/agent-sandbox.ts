/**
 * A delegated agent's sandbox: one private overlay of the workspace, shared by
 * the agent's in-process file tools ({@link AgentOverlay}) and its shell
 * commands (rooted at the native launcher through {@link AgentSandbox.wrapSpawn}).
 *
 * Both halves read and write the same overlay directory in the same on-disk
 * format, so a change the agent makes with a tool and one it makes with a
 * command are the same change, and neither touches the lead's tree. When the
 * agent finishes, {@link AgentSandbox.changedFiles} is what the lead is handed.
 *
 * Commands are sandboxed only where the native launcher exists (Windows today).
 * When it does not, `wrapSpawn` is undefined and the caller withholds
 * `run_commands` rather than letting a command escape to the workspace.
 */
import * as fs from "node:fs/promises";
import { AgentOverlay, type OverlayChange } from "./overlay-fs";

/** The native command-sandbox binary and its hook library. */
export interface SandboxBinaries {
	/** Absolute path to the `cerebriline-sandbox` launcher (`.exe` on Windows). */
	launcher: string;
	/**
	 * Absolute path to the hook library the launcher injects (Windows `hook.dll`);
	 * on Linux/macOS there is none, so this points back at the launcher, which
	 * ignores it — keeping `wrapSpawn`'s `[hook, log, cmd, ...]` shape uniform.
	 */
	hook: string;
	/** Platforms the binaries support. */
	platforms?: NodeJS.Platform[];
}

type SpawnSpec = {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
};

export interface AgentSandbox {
	readonly overlay: AgentOverlay;
	readonly overlayRoot: string;
	/**
	 * Wrap a shell spawn so the command tree runs under the sandbox, or
	 * undefined when this platform has no launcher (the caller then withholds
	 * `run_commands`). Shape matches `ShellExecutorOptions.wrapSpawn`.
	 */
	readonly wrapSpawn?: (spec: SpawnSpec) => SpawnSpec;
	/** The agent's change set, for the hand-back to the lead. */
	changedFiles(): Promise<OverlayChange[]>;
	/** Remove the overlay and its log once the hand-back has been read. */
	dispose(): Promise<void>;
}

export interface CreateAgentSandboxOptions {
	/** The lead's workspace, read-only to the agent. */
	workspaceRoot: string;
	/** The agent's private overlay directory (in extension storage). */
	overlayRoot: string;
	/** The native binaries; absent means tools-only isolation, no sandboxed commands. */
	binaries?: SandboxBinaries;
}

export async function createAgentSandbox(
	options: CreateAgentSandboxOptions,
): Promise<AgentSandbox> {
	const { workspaceRoot, overlayRoot, binaries } = options;
	await fs.mkdir(overlayRoot, { recursive: true });
	const overlay = new AgentOverlay(workspaceRoot, overlayRoot);
	// A sibling of the overlay root, never inside it: the overlay is the mirror
	// of the workspace, and a log written into it would surface in the agent's
	// own `list_files` of the workspace root and be handed back to the lead as a
	// phantom "created" file. Kept just outside, `readdir`/`changedFiles` (both
	// rooted at overlayRoot) and the native enumerator can none of them see it.
	const logPath = `${overlayRoot}.sandbox.log`;

	const platforms = binaries?.platforms ?? ["win32"];
	const commandsSupported =
		binaries != null && platforms.includes(process.platform);

	const wrapSpawn = commandsSupported
		? (spec: SpawnSpec): SpawnSpec => ({
				// Root the tree at the launcher, which starts the real shell with
				// the hook library loaded and re-injects into everything it spawns.
				executable: (binaries as SandboxBinaries).launcher,
				args: [
					(binaries as SandboxBinaries).hook,
					logPath,
					spec.executable,
					...spec.args,
				],
				// The shell's cwd stays the workspace, so the model's relative paths
				// resolve there; the hook maps them into the overlay.
				cwd: workspaceRoot,
				env: {
					...spec.env,
					CEREBRILINE_WS_ROOT: workspaceRoot,
					CEREBRILINE_OVERLAY_ROOT: overlayRoot,
					CEREBRILINE_SANDBOX_LOG: logPath,
				},
			})
		: undefined;

	return {
		overlay,
		overlayRoot,
		wrapSpawn,
		changedFiles: () => overlay.changedFiles(),
		dispose: async () => {
			await fs.rm(overlayRoot, { recursive: true, force: true });
			// The sibling log too, or it outlives the overlay it belongs to.
			await fs.rm(logPath, { force: true }).catch(() => {});
		},
	};
}
