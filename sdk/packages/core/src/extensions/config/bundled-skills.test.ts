import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoreSettingsService } from "../../settings/settings-service";
import {
	isBundledSkillPath,
	resolveBundledSkillsDirectory,
} from "./bundled-skills";
import {
	parseSkillConfigFromMarkdown,
	type SkillConfig,
} from "./user-instruction-config-loader";
import { createUserInstructionConfigService } from "./user-instruction-service";

const skillFile = (name: string, extra = "") =>
	`---\nname: ${name}\ndescription: What ${name} is for.\n${extra}---\nDo the ${name} thing.\n`;

describe("bundled skills", () => {
	let root: string;
	let bundled: string;
	let workspace: string;
	const env = {
		HOME: process.env.HOME,
		CLINE_GLOBAL_SETTINGS_PATH: process.env.CLINE_GLOBAL_SETTINGS_PATH,
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bundled-skills-"));
		bundled = join(root, "bundled-skills");
		workspace = join(root, "workspace");
		process.env.HOME = join(root, "home");
		setHomeDir(process.env.HOME);
		process.env.CLINE_GLOBAL_SETTINGS_PATH = join(root, "settings.json");
		await mkdir(join(bundled, "on-by-default"), { recursive: true });
		await mkdir(join(bundled, "off-by-default"), { recursive: true });
		await mkdir(workspace, { recursive: true });
		await writeFile(
			join(bundled, "on-by-default", "SKILL.md"),
			skillFile("on-by-default"),
		);
		await writeFile(
			join(bundled, "off-by-default", "SKILL.md"),
			skillFile("off-by-default", "disabled: true\n"),
		);
		await writeFile(join(bundled, "README.md"), "# not a skill\n");
	});

	afterEach(async () => {
		process.env.HOME = env.HOME;
		setHomeDir(env.HOME ?? "~");
		if (env.CLINE_GLOBAL_SETTINGS_PATH === undefined) {
			delete process.env.CLINE_GLOBAL_SETTINGS_PATH;
		} else {
			process.env.CLINE_GLOBAL_SETTINGS_PATH = env.CLINE_GLOBAL_SETTINGS_PATH;
		}
		await rm(root, { recursive: true, force: true });
	});

	const start = async () => {
		const service = createUserInstructionConfigService({
			skills: { workspacePath: workspace, bundledSkillsDirectory: bundled },
			rules: { directories: [] },
			workflows: { directories: [] },
		});
		await service.start();
		return service;
	};
	const byName = (
		service: Awaited<ReturnType<typeof start>>,
	): Record<string, SkillConfig> =>
		Object.fromEntries(
			service
				.listRecords<SkillConfig>("skill")
				.map((record) => [record.item.name, record.item]),
		);

	it("lists them, with the frontmatter deciding the default", async () => {
		const service = await start();
		try {
			const skills = byName(service);
			expect(Object.keys(skills).sort()).toEqual([
				"off-by-default",
				"on-by-default",
			]);
			expect(skills["on-by-default"].bundled).toBe(true);
			expect(skills["on-by-default"].disabled).toBeUndefined();
			expect(skills["off-by-default"].disabled).toBe(true);
		} finally {
			service.stop();
		}
	});

	it("leaves them out when explicit directories are given, or on request", async () => {
		for (const skills of [
			{ directories: [] },
			{ workspacePath: workspace, bundledSkillsDirectory: false as const },
		]) {
			const service = createUserInstructionConfigService({
				skills,
				rules: { directories: [] },
				workflows: { directories: [] },
			});
			await service.start();
			try {
				expect(
					service
						.listRecords<SkillConfig>("skill")
						.filter((record) => record.item.bundled),
				).toEqual([]);
			} finally {
				service.stop();
			}
		}
	});

	it("lets the workspace's skill of the same name replace the bundled one", async () => {
		const own = join(workspace, ".cline", "skills", "on-by-default");
		await mkdir(own, { recursive: true });
		await writeFile(
			join(own, "SKILL.md"),
			"---\nname: on-by-default\n---\nMine.\n",
		);
		const service = await start();
		try {
			const skill = byName(service)["on-by-default"];
			expect(skill.instructions).toBe("Mine.");
			expect(skill.bundled).toBeUndefined();
		} finally {
			service.stop();
		}
	});

	it("turns one on and off in the settings, without writing its file", async () => {
		const service = await start();
		try {
			const settings = new CoreSettingsService();
			const filePath = join(bundled, "off-by-default", "SKILL.md");
			const before = await readFile(filePath, "utf8");
			const listed = async () =>
				(
					await settings.list({
						workspaceRoot: workspace,
						userInstructionService: service,
					})
				).skills.find((skill) => skill.name === "off-by-default");

			expect(await listed()).toMatchObject({
				source: "builtin",
				enabled: false,
			});

			await settings.toggle({
				type: "skills",
				path: filePath,
				enabled: true,
				workspaceRoot: workspace,
				userInstructionService: service,
			});
			expect((await listed())?.enabled).toBe(true);
			expect(await readFile(filePath, "utf8")).toBe(before);
			expect(
				JSON.parse(
					await readFile(process.env.CLINE_GLOBAL_SETTINGS_PATH ?? "", "utf8"),
				).bundledSkills,
			).toEqual({ "off-by-default": { enabled: true } });

			await settings.toggle({
				type: "skills",
				path: filePath,
				enabled: false,
				workspaceRoot: workspace,
				userInstructionService: service,
			});
			expect((await listed())?.enabled).toBe(false);
		} finally {
			service.stop();
		}
	});

	it("shows a change made elsewhere to a service that is already running", async () => {
		// The file does not change, so no watcher event tells this service to
		// parse again: the record it already holds has to answer correctly.
		const service = await start();
		try {
			const held = byName(service)["on-by-default"];
			expect(held.disabled).toBeUndefined();
			await writeFile(
				process.env.CLINE_GLOBAL_SETTINGS_PATH ?? "",
				JSON.stringify({
					bundledSkills: { "on-by-default": { enabled: false } },
				}),
			);
			expect(held.disabled).toBe(true);
			expect({ ...held }.disabled).toBe(true);
		} finally {
			service.stop();
		}
	});

	it("knows a bundled path from any other", () => {
		expect(
			isBundledSkillPath(join(bundled, "on-by-default", "SKILL.md"), bundled),
		).toBe(true);
		expect(isBundledSkillPath(bundled, bundled)).toBe(false);
		expect(isBundledSkillPath(join(workspace, "SKILL.md"), bundled)).toBe(
			false,
		);
		expect(isBundledSkillPath(join(bundled, "x"), undefined)).toBe(false);
	});
});

describe("the skills core ships", () => {
	it("are found from the source tree, and each one can be offered", async () => {
		const directory = resolveBundledSkillsDirectory();
		expect(directory).toMatch(/assets[\\/]skills$/);
		const { readdirSync, statSync, readFileSync } = await import("node:fs");
		const folders = readdirSync(directory ?? "").filter((entry) =>
			statSync(join(directory ?? "", entry)).isDirectory(),
		);
		expect(folders.length).toBeGreaterThan(0);
		for (const folder of folders) {
			const skill = parseSkillConfigFromMarkdown(
				readFileSync(join(directory ?? "", folder, "SKILL.md"), "utf8"),
				folder,
			);
			// The description is all the model sees before loading a skill.
			expect(skill.frontmatter.name, folder).toBe(folder);
			expect(skill.description?.length ?? 0, folder).toBeGreaterThan(40);
		}
	});
});
