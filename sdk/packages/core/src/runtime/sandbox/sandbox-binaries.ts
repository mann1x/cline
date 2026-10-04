/**
 * Where the native command-sandbox binaries are, per platform. Shared by the
 * delegated agents' sandbox and the lead's optional command confinement.
 */
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SandboxBinaries } from "./agent-sandbox";

/**
 * The native command-sandbox launcher under `dir`, or undefined when there is
 * none for this platform. Windows is the Detours launcher + hook DLL; Linux is
 * the `cerebriline-sandbox` binary (user namespace + overlayfs, no injected
 * library — the `hook` field is unused there and points at the launcher itself
 * so the shared `wrapSpawn` shape holds). A platform with no launcher gets file
 * isolation without a shell rather than an unsandboxed one.
 */
export function resolveSandboxBinaries(
	dir?: string,
): SandboxBinaries | undefined {
	if (!dir) {
		return undefined;
	}
	if (process.platform === "win32") {
		// The W1 launcher folded into the one Rust binary; the injected C++
		// `hook.dll` (which does the redirect) ships beside it.
		const launcher = join(dir, "cerebriline-sandbox.exe");
		const hook = join(dir, "hook.dll");
		if (!existsSync(launcher) || !existsSync(hook)) {
			return undefined;
		}
		return { launcher, hook, platforms: ["win32"] };
	}
	if (process.platform === "linux") {
		// L1/L2: `cerebriline-sandbox-x64` / `-arm64`.
		return resolveArchSuffixedLauncher(dir, "", "linux");
	}
	if (process.platform === "darwin") {
		// M1: `cerebriline-sandbox-darwin-x64` / `-darwin-arm64`.
		return resolveArchSuffixedLauncher(dir, "darwin-", "darwin");
	}
	return undefined;
}

/**
 * The Unix backends (Linux L1/L2, macOS M1) ship an arch-suffixed launcher and
 * need no injected library, so they resolve identically bar the name infix:
 * `cerebriline-sandbox-<infix><arch>`, with a flat `cerebriline-sandbox` accepted
 * as a single-arch fallback.
 */
function resolveArchSuffixedLauncher(
	dir: string,
	infix: string,
	platform: "linux" | "darwin",
): SandboxBinaries | undefined {
	const suffix = (
		{ x64: "x64", arm64: "arm64" } as Record<string, string | undefined>
	)[process.arch];
	const names = suffix
		? [`cerebriline-sandbox-${infix}${suffix}`, "cerebriline-sandbox"]
		: ["cerebriline-sandbox"];
	const launcher = names.map((n) => join(dir, n)).find(existsSync);
	if (!launcher) {
		return undefined;
	}
	// A vsix is a zip and may drop the executable bit on extraction; restore it
	// best-effort so the launcher can run.
	try {
		chmodSync(launcher, 0o755);
	} catch {
		// Read-only install or already executable; the spawn will report if it
		// truly cannot run.
	}
	// No injected library here; the launcher ignores argv[1]. Point it at the
	// launcher so wrapSpawn's `[hook, log, cmd, ...]` shape is uniform.
	return { launcher, hook: launcher, platforms: [platform] };
}
