/**
 * The skills that ship with the product.
 *
 * They live in core's `assets/skills/`, one folder per skill, and are found
 * beside the bundle first, where the extension's build copies them as
 * `bundled-skills/`; then beside the executable, which is where the CLI's
 * build puts them, since a compiled binary's modules have no folder on disk;
 * and then in core's own `assets/`, by walking up from this module, which is
 * the case for tests and for core used from `node_modules`.
 *
 * A bundled skill is replaced by every update, so nothing is ever written to
 * its file. Whether it is on is a setting (`bundledSkills` in the global
 * settings); the `disabled` field in its frontmatter is only the default.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readGlobalSettings,
	writeGlobalSettings,
} from "../../services/global-settings";

/** The folder name beside a bundle. */
export const BUNDLED_SKILLS_DIRECTORY_NAME = "bundled-skills";

function moduleDirectory(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return ".";
	}
}

let cached: { from: string; directory: string | undefined } | undefined;

export function resolveBundledSkillsDirectory(
	besideDir: string = moduleDirectory(),
): string | undefined {
	if (cached?.from === besideDir) {
		return cached.directory;
	}
	let directory: string | undefined;
	const beside = [
		join(besideDir, BUNDLED_SKILLS_DIRECTORY_NAME),
		join(dirname(process.execPath), BUNDLED_SKILLS_DIRECTORY_NAME),
	].find((candidate) => existsSync(candidate));
	if (beside) {
		directory = beside;
	} else {
		let dir = besideDir;
		for (let depth = 0; depth < 7; depth++) {
			const candidate = join(dir, "assets", "skills");
			// `package.json` beside `assets/` keeps this to a package's own
			// folder, so an unrelated `assets/skills` further up is not taken.
			if (existsSync(candidate) && existsSync(join(dir, "package.json"))) {
				directory = candidate;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	cached = { from: besideDir, directory };
	return directory;
}

export function isBundledSkillPath(
	filePath: string,
	bundledDirectory: string | undefined = resolveBundledSkillsDirectory(),
): boolean {
	if (!bundledDirectory) {
		return false;
	}
	const relativePath = relative(resolve(bundledDirectory), resolve(filePath));
	return (
		relativePath !== "" &&
		!relativePath.startsWith("..") &&
		!isAbsolute(relativePath)
	);
}

function settingKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Whether a bundled skill is on: the user's choice if they made one, and
 * otherwise what the skill's own frontmatter says.
 */
export function isBundledSkillEnabled(
	name: string,
	enabledByDefault: boolean,
): boolean {
	return (
		readGlobalSettings().bundledSkills?.[settingKey(name)]?.enabled ??
		enabledByDefault
	);
}

export function setBundledSkillEnabled(name: string, enabled: boolean): void {
	const settings = readGlobalSettings();
	writeGlobalSettings({
		...settings,
		bundledSkills: {
			...settings.bundledSkills,
			[settingKey(name)]: { enabled },
		},
	});
}
