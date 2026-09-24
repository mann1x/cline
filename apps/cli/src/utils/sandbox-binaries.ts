import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory holding the delegated-agent command-sandbox binaries
 * (`cerebriline-sandbox-<arch>` on Linux, `sandbox-launch.exe` + `hook.dll` on
 * Windows). The core host reads a platform binary from here to sandbox a
 * delegated agent's `run_commands`; when none is found it withholds the shell
 * and the agent still gets file-isolation.
 *
 * apps/vscode ships these under `assets/sandbox`. The CLI resolves the same set,
 * whether it is a published build (the binaries are bundled next to it) or a
 * source run inside the monorepo (they live in `apps/vscode/assets/sandbox`).
 * Returns undefined when no such directory exists, which simply means no command
 * sandbox on this install.
 */
export function resolveSandboxBinariesDir(): string | undefined {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const execDir = dirname(process.execPath);
	const candidates = [
		join(moduleDir, "assets", "sandbox"),
		join(execDir, "assets", "sandbox"),
		join(execDir, "..", "assets", "sandbox"),
	];
	// Monorepo / source run: walk up for apps/vscode/assets/sandbox.
	let dir = moduleDir;
	for (let i = 0; i < 8; i++) {
		candidates.push(join(dir, "apps", "vscode", "assets", "sandbox"));
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return candidates.find((candidate) => existsSync(candidate));
}
