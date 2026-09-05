import { fstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { CheckApprover, ToolPolicy } from "@cline/core";
import { resolveAgentSlotLimit } from "@cline/llms";

import { registerDisposable } from "@cline/shared";
import type { Command } from "commander";
import { registerHistoryCommand } from "./commands/history-command";
import {
	CommanderError,
	commanderToParsedArgs,
	createProgram,
} from "./commands/program";
import {
	autoUpdateOnStartup,
	getPreferredKanbanInstaller,
} from "./commands/update";
import { CLI_DEFAULT_CHECKPOINT_CONFIG } from "./runtime/defaults";

import type { TuiStartupTarget } from "./tui/types";
import { filterChatModels } from "./utils/chat-models";
import { getCliBuildInfo } from "./utils/common";
import {
	buildCliCompactionConfig,
	CLI_COMPACTION_MODE_EXPECTED_TEXT,
} from "./utils/compaction-mode";
import {
	refreshCliFeatureFlagsInBackground,
	setCliFeatureFlagsAccountContext,
} from "./utils/feature-flags";
import {
	configureSandboxEnvironment,
	normalizeAutoApproveArgs,
	resolveWorkspaceRoot,
} from "./utils/helpers";
import {
	c,
	installStreamErrorGuards,
	setCurrentOutputMode,
	writeErr,
	writeln,
} from "./utils/output";
import {
	ensureOAuthProviderApiKey,
	getPersistedProviderApiKey,
	isOAuthProvider,
	normalizeProviderId,
} from "./utils/provider-auth";
import { resolveCliReasoning } from "./utils/reasoning";
import {
	resolveStartupCompactionMode,
	resolveStartupMode,
	resolveStartupToolAutoApprove,
} from "./utils/startup-settings";
import { rewriteTeamPrompt, TEAM_COMMAND_USAGE } from "./utils/team-command";
import {
	captureCliExtensionActivated,
	getCliTelemetryService,
	identifyTelemetryAccount,
} from "./utils/telemetry";
import type { Config } from "./utils/types";
import { runConnectWizard } from "./wizards/connect";
import { runMcpWizard } from "./wizards/mcp";
import { runScheduleWizard } from "./wizards/schedule";

/**
 * Approves whatever check the model proposed, without asking.
 *
 * The extension puts the proposal to the user because there is one. Here there
 * is not, so the choice is between no verdict at all and one nobody vetted --
 * and for an unattended batch the second is the point, which is why it is a
 * flag and not the default. The proposal has already been validated by then:
 * it must be mechanical, and a path it names must stay inside the workspace.
 */
const approveAnyProposedCheck: CheckApprover = async () => ({
	approved: true,
});

export function stdinHasPipedInput(): boolean {
	if (process.stdin.isTTY) return false;
	try {
		const stats = fstatSync(0);
		return stats.isFIFO() || stats.isFile();
	} catch {
		return false;
	}
}

async function createProviderSettingsManager() {
	const { ProviderSettingsManager } = await import("@cline/core");
	return new ProviderSettingsManager();
}

async function loadCliRuntimeModules() {
	const [coreServer, prompt, promptTemplate, hostTools, runAgentModule] =
		await Promise.all([
			import("@cline/core"),
			import("./runtime/prompt"),
			import("./runtime/prompt-template"),
			import("./runtime/host-tools"),
			import("./runtime/run-agent"),
		]);
	return {
		coreServer,
		resolveSystemPrompt: prompt.resolveSystemPrompt,
		ideName: prompt.CLI_IDE_NAME,
		resolveCliPromptTemplate: promptTemplate.resolveCliPromptTemplate,
		createCliHostTools: hostTools.createCliHostTools,
		runAgent: runAgentModule.runAgent,
	};
}

async function loadInteractiveRuntimeModule() {
	const { runInteractive } = await import("./runtime/run-interactive");
	return runInteractive;
}

/**
 * Two-pass approach for --config: a quick scan of process.argv extracts the
 * config directory before commander parses, because setClineDir() must run
 * before any code that reads the home/config directory.
 *
 * Recognizes both Commander spellings:
 *   --config <dir>
 *   --config=<dir>
 *
 * Exported for unit testing; callers in this file should use this rather
 * than reimplementing the scan.
 */
export function resolveConfigDirArg(argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") {
			const value = argv[i + 1]?.trim();
			return value ? value : undefined;
		}
		if (arg?.startsWith("--config=")) {
			const value = arg.slice("--config=".length).trim();
			return value ? value : undefined;
		}
	}
	return undefined;
}

function collectOption(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

// Shells strip quote characters before argv reaches us, so a prompt that was
// typed in quotes is only observable when it remains one argv token with spaces.
function promptArgLooksQuoted(arg: string | undefined): boolean {
	return !!arg && /\s/.test(arg);
}

function writePromptArgError(args: string[]): void {
	const renderedArgs = args.join(" ");
	writeErr(
		`Unknown command or unquoted prompt: ${renderedArgs}\nPrompt text must be passed as a single quoted argument, for example: cline "fix the tests". Use "cline --help" to see available commands and flags.`,
	);
}

function startupTargetTakesPrecedenceOverMigrationNotice(
	target: TuiStartupTarget | undefined,
): boolean {
	return target === "config" || target === "history";
}

export async function runCli(): Promise<void> {
	installStreamErrorGuards();
	autoUpdateOnStartup();

	const cliArgs = process.argv.slice(2);
	const isFullTTY =
		process.stdin.isTTY === true && process.stdout.isTTY === true;
	const configDir = resolveConfigDirArg(cliArgs);
	const { setClineDir, setHomeDir } = await import("@cline/shared/storage");
	if (configDir) {
		setClineDir(configDir);
	}
	setHomeDir(homedir());

	// Capture activation telemetry only after config/home directory selection
	// has been applied, so the telemetry singleton's persisted distinct-id
	// (and any other storage it touches) lands under the user-selected
	// `--config <dir>` rather than the default home/config location.
	captureCliExtensionActivated();

	const normalizedArgs = normalizeAutoApproveArgs(cliArgs);

	// Subcommand routing via Commander
	const ctx: {
		exitCode?: number;
		startupTarget?: TuiStartupTarget;
	} = {};
	const io = { writeln, writeErr };
	const program = createProgram();
	// Re-enable built-in help/version output for the routing program
	program.configureOutput({
		writeOut: (str: string) => process.stdout.write(str),
		writeErr: () => {},
	});
	// Default action handles non-subcommand args (e.g. prompt text)
	program.action(() => {});

	// Auth subcommand: defines its own options so commander parses them
	// directly. The short flags -p/-m intentionally shadow the root's -p (plan)
	// and -m (model); commander scopes options per-command so there is no
	// conflict.
	const authCmd = program
		.command("auth")
		.description("Authenticate a provider and configure what model is used")
		.argument("[provider]", "Provider id (positional shorthand for -p)")
		.option("-p, --provider <id>", "Provider ID")
		.option("-k, --apikey <key>", "API key")
		.option("-m, --modelid <id>", "Model ID")
		.option("-b, --baseurl <url>", "Base URL")
		.option("--azure-api-version <version>", "Azure API version")
		.option("--config <dir>", "configuration directory")
		.option("-c, --cwd <path>", "Working directory")
		.option(
			"--data-dir <dir>",
			"Use isolated local state at <dir> instead of ~/.cline (enables sandbox mode)",
		)
		.option("-v, --verbose", "Show verbose output")
		.action(async (positionalProvider: string | undefined) => {
			const opts = authCmd.opts<{
				provider?: string;
				apikey?: string;
				modelid?: string;
				baseurl?: string;
				azureApiVersion?: string;
				config?: string;
				cwd?: string;
				dataDir?: string;
				verbose?: boolean;
			}>();
			// Honor --config inside the action as a defense-in-depth measure.
			// The early pre-pass in runCli() also calls setClineDir(), but only
			// for argv tokens it can spot before commander runs. Reapplying
			// here ensures opts.config (parsed by commander, including the
			// --config=<dir> form) is always respected before any provider
			// settings manager is constructed against ~/.cline.
			if (opts.config?.trim()) {
				const { setClineDir } = await import("@cline/shared/storage");
				setClineDir(opts.config.trim());
			}
			// Honor --data-dir before constructing the provider settings manager
			// so writes land under the chosen data dir instead of ~/.cline.
			configureSandboxEnvironment({
				enabled: !!opts.dataDir || process.env.CLINE_SANDBOX?.trim() === "1",
				cwd: opts.cwd ?? process.cwd(),
				explicitDir: opts.dataDir,
			});
			const { runAuthCommand } = await import("./commands/auth");
			const providerSettingsManager = await createProviderSettingsManager();
			ctx.exitCode = await runAuthCommand({
				providerSettingsManager,
				explicitProvider: opts.provider ?? positionalProvider,
				apikey: opts.apikey,
				modelid: opts.modelid,
				baseurl: opts.baseurl,
				azureApiVersion: opts.azureApiVersion,
				io,
			});
		});

	const createConfigRuntimeCommand = async () => {
		const { createConfigCommand } = await import("./commands/config");
		let configCmd: Command;
		configCmd = createConfigCommand(
			() => resolveWorkspaceRoot(program.opts().cwd ?? process.cwd()),
			() => {
				const outputMode =
					program.opts().json || configCmd.opts().json
						? ("json" as const)
						: ("text" as const);
				setCurrentOutputMode(outputMode);
				return outputMode;
			},
			io,
			(code) => {
				ctx.exitCode = code;
			},
			() => {
				ctx.startupTarget = "config";
			},
		);
		return configCmd;
	};

	program
		.command("config")
		.description("Show current configuration")
		.option("--json", "Output as JSON")
		.option("--config <dir>", "configuration directory")
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.action(async (_opts: unknown, cmd: Command) => {
			const realCmd = await createConfigRuntimeCommand();
			await realCmd.parseAsync(cmd.args, { from: "user" });
		});

	const pluginCmd = program
		.command("plugin")
		.description("Manage Cline Plugins")
		.action(() => {
			pluginCmd.help();
		});
	const pluginInstallCmd = pluginCmd
		.command("install")
		.alias("i")
		.description(
			"Install a Cline Plugin from an official keyword, npm, git, URL, or a local path",
		)
		.argument(
			"<source>",
			"official keyword, npm package, git URL, plugin file URL, or local plugin path",
		)
		.option("--npm", "Treat source as an npm package")
		.option("--git", "Treat source as a git repository")
		.option("--force", "Replace an existing install for the same source")
		.option("--json", "Output as JSON")
		.option("--cwd <path>", "Install to <path>/.cline/plugins")
		.action(async (source: string) => {
			const opts = pluginInstallCmd.opts<{
				npm?: boolean;
				git?: boolean;
				force?: boolean;
				json?: boolean;
				cwd?: string;
			}>();
			const sourceTypes = [
				opts.npm ? ("npm" as const) : undefined,
				opts.git ? ("git" as const) : undefined,
			].filter((sourceType) => sourceType !== undefined);
			if (sourceTypes.length > 1) {
				writeErr("plugin install accepts only one source type flag");
				ctx.exitCode = 1;
				return;
			}
			const { runPluginInstallCommand } = await import("./commands/plugin");
			ctx.exitCode = await runPluginInstallCommand({
				source,
				sourceType: sourceTypes[0],
				cwd: opts.cwd,
				force: opts.force === true,
				json: opts.json === true || program.opts().json === true,
				io,
			});
		});
	const pluginUninstallCmd = pluginCmd
		.command("uninstall")
		.alias("remove")
		.alias("rm")
		.description("Uninstall a Cline Plugin by name or path")
		.argument("<name>", "plugin package name, installed slug, or plugin path")
		.option("--json", "Output as JSON")
		.option(
			"--cwd <path>",
			"Search <path>/.cline/plugins before global plugins",
		)
		.action(async (name: string) => {
			const opts = pluginUninstallCmd.opts<{
				json?: boolean;
				cwd?: string;
			}>();
			const { runPluginUninstallCommand } = await import("./commands/plugin");
			ctx.exitCode = await runPluginUninstallCommand({
				name,
				cwd: opts.cwd,
				json: opts.json === true || program.opts().json === true,
				io,
			});
		});
	const skillCmd = program
		.command("skill")
		.description("Manage Cline Skills via the open skills CLI (npx skills)")
		.allowUnknownOption()
		.passThroughOptions()
		.argument("[args...]", "arguments forwarded to the skills CLI")
		.addHelpText(
			"after",
			"\nForwards to the open skills CLI via npx. Examples:\n" +
				"  cline skill add <owner/repo>       Add a skill into Cline\n" +
				"  cline skill install <owner/repo>   Alias for add\n" +
				"  cline skill list                   List installed skills\n" +
				"  cline skill remove                 Remove installed skills\n" +
				"  cline skill uninstall              Alias for remove\n" +
				"\nadd/install and remove/uninstall default to '--agent cline' unless you pass your own --agent.\n" +
				"Run 'npx skills --help' for the full command reference.",
		)
		.action(async () => {
			const { runSkillCommand } = await import("./commands/skill");
			ctx.exitCode = await runSkillCommand(skillCmd.args, io);
		});

	const connectCmd = program
		.command("connect")
		.description("Connect to an external channel")
		.argument("[channel]", "Channel to connect Cline CLI to")
		.option("--stop", "Kill all current channel connections")
		.option("--restart", "Restart a channel connection")
		.option(
			"--restart-instance <id>",
			"Restart one connector instance (used by daemon recovery)",
		)
		.option(
			"--cleanup-instance <id>",
			"Reap one dead connector instance, preserving autostart (used by hub supervision)",
		)
		.allowUnknownOption()
		.passThroughOptions()
		.addHelpText(
			"after",
			"\nRun 'connect <channel> --help' for channel-specific options.",
		)
		.action(async (adapter: string | undefined) => {
			const {
				formatAdapterList,
				runCleanupConnectorInstance,
				runConnectAdapter,
				runRestartConnector,
				runStopAllConnectors,
				runStopConnector,
			} = await import("./commands/connect");
			const opts = connectCmd.opts();
			const exclusiveModes = [
				opts.stop,
				opts.restart || opts.restartInstance,
				opts.cleanupInstance,
			].filter(Boolean).length;
			if (exclusiveModes > 1) {
				io.writeErr(
					"connect accepts only one of --stop, --restart or --cleanup-instance",
				);
				ctx.exitCode = 1;
			} else if (opts.cleanupInstance) {
				if (!adapter) {
					io.writeErr("connect --cleanup-instance requires a channel");
					ctx.exitCode = 1;
				} else {
					ctx.exitCode = await runCleanupConnectorInstance(
						adapter,
						opts.cleanupInstance,
						io,
					);
				}
			} else if (opts.stop) {
				if (adapter) {
					ctx.exitCode = await runStopConnector(adapter, io);
				} else {
					ctx.exitCode = await runStopAllConnectors(io);
				}
			} else if (opts.restart || opts.restartInstance) {
				if (!adapter) {
					io.writeErr("connect --restart requires a channel");
					ctx.exitCode = 1;
				} else {
					ctx.exitCode = await runRestartConnector(
						adapter,
						connectCmd.args.slice(1),
						io,
						opts.restartInstance,
					);
				}
			} else if (adapter) {
				// connectCmd.args = [adapter, ...passthroughFlags]. Pass only the
				// connector-specific flags (everything after the adapter name).
				ctx.exitCode = await runConnectAdapter(
					adapter,
					connectCmd.args.slice(1),
					io,
				);
			} else if (isFullTTY) {
				ctx.exitCode = await runConnectWizard();
			} else {
				writeln(`\nAdapters:\n${formatAdapterList()}`);
				connectCmd.help();
			}
		});

	const mcpCmd = program
		.command("mcp")
		.description("Manage MCP servers")
		.action(async () => {
			if (isFullTTY) {
				ctx.exitCode = await runMcpWizard();
			} else {
				writeln(
					"MCP wizard requires a TTY. Use cline config mcp to list servers.",
				);
			}
		});
	const mcpInstallCmd = mcpCmd
		.command("install")
		.alias("add")
		.description("Open the MCP add wizard with server fields prefilled")
		.argument("<name>", "MCP server name")
		.argument(
			"[targetArgs...]",
			"URL for remote transports, or command and args after -- for stdio",
		)
		.option(
			"--transport <transport>",
			"stdio, sse, http, streamable-http, or streamableHttp (default: stdio)",
		)
		.option("--header <header>", "Remote MCP request header", collectOption, [])
		.option("--yes", "Install noninteractively without opening the wizard")
		.option("--json", "Output as JSON")
		.action(async (name: string, targetArgs: string[]) => {
			const opts = mcpInstallCmd.opts<{
				header?: string[];
				json?: boolean;
				transport?: string;
				yes?: boolean;
			}>();
			const { runMcpInstallCommand } = await import("./commands/mcp");
			ctx.exitCode = await runMcpInstallCommand({
				name,
				headers: opts.header,
				targetArgs,
				transport: opts.transport,
				json: opts.json === true || program.opts().json === true,
				yes: opts.yes === true,
				io,
			});
		});
	const mcpUninstallCmd = mcpCmd
		.command("uninstall")
		.alias("remove")
		.alias("rm")
		.description("Uninstall an MCP server by name")
		.argument("<name>", "MCP server name")
		.option("--json", "Output as JSON")
		.action(async (name: string) => {
			const opts = mcpUninstallCmd.opts<{
				json?: boolean;
			}>();
			const { runMcpUninstallCommand } = await import("./commands/mcp");
			ctx.exitCode = await runMcpUninstallCommand({
				name,
				json: opts.json === true || program.opts().json === true,
				io,
			});
		});

	const createDoctorRuntimeCommand = async () => {
		const { createDoctorCommand } = await import("./commands/doctor");
		return createDoctorCommand(io, (code) => {
			ctx.exitCode = code;
		});
	};

	program
		.command("doctor")
		.description("Diagnose and fix configuration issues")
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.addHelpText(
			"after",
			"\nCommands:\n  fix  Kill all running processes\n  log  Open the CLI log file\n",
		)
		.action(async (_opts: unknown, cmd: Command) => {
			const doctorCmd = await createDoctorRuntimeCommand();
			await doctorCmd.parseAsync(cmd.args, { from: "user" });
		});

	registerHistoryCommand({
		program,
		io,
		setExitCode: (code) => {
			ctx.exitCode = code;
		},
		setStartupTarget: (target) => {
			ctx.startupTarget = target;
		},
		isInteractiveTTY: () => isFullTTY,
	});

	program
		.command("hook")
		.description("Handle a hook payload from stdin")
		.allowUnknownOption()
		.allowExcessArguments()
		.action(async () => {
			const { runHookCommand } = await import("./commands/hook");
			ctx.exitCode = await runHookCommand(io);
		});

	const createScheduleRuntimeCommand = async () => {
		const { createScheduleCommand } = await import("./commands/schedule");
		return createScheduleCommand(io, (code) => {
			ctx.exitCode = code;
		});
	};
	const createHubRuntimeCommand = async () => {
		const { createHubCommand } = await import("./commands/hub");
		return createHubCommand(io, (code) => {
			ctx.exitCode = code;
		});
	};

	program
		.command("schedule")
		.description("Manage scheduled tasks")
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.action(async (_opts: unknown, cmd: Command) => {
			if (cmd.args.length === 0 && isFullTTY) {
				ctx.exitCode = await runScheduleWizard();
				return;
			}
			const scheduleCmd = await createScheduleRuntimeCommand();
			await scheduleCmd.parseAsync(cmd.args, { from: "user" });
		});
	program
		.command("hub")
		.description("Manage the local hub daemon")
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.action(async (_opts: unknown, cmd: Command) => {
			const hubCmd = await createHubRuntimeCommand();
			await hubCmd.parseAsync(cmd.args, { from: "user" });
		});

	const dashboardCmd = program
		.command("dashboard")
		.description("Start the Cline Hub dashboard and open it in a browser")
		.option("--config <dir>", "configuration directory")
		.option("-c, --cwd <path>", "Workspace root", process.cwd())
		.option(
			"--data-dir <dir>",
			"Use isolated local state at <dir> instead of ~/.cline (enables sandbox mode)",
		)
		.option("--host <host>", "Dashboard bind host")
		.option("--port <port>", "Dashboard HTTP/WebSocket port")
		.option("--public-url <url>", "Public dashboard URL")
		.option("--room-secret <secret>", "Invite secret for browser access")
		.option("--no-open", "Start the dashboard without opening a browser")
		.action(async () => {
			const opts = dashboardCmd.opts<{
				config?: string;
				cwd?: string;
				dataDir?: string;
				host?: string;
				port?: string;
				publicUrl?: string;
				roomSecret?: string;
				open?: boolean;
			}>();
			const { runDashboardCommand } = await import("./commands/dashboard");
			ctx.exitCode = await runDashboardCommand({
				configDir: opts.config,
				cwd: opts.cwd,
				dataDir: opts.dataDir,
				host: opts.host,
				port: opts.port,
				publicUrl: opts.publicUrl,
				roomSecret: opts.roomSecret,
				openBrowser: opts.open !== false,
				io,
			});
		});

	const updateCmd = program
		.command("update")
		.description("Check for updates and install if available")
		.allowUnknownOption()
		.allowExcessArguments()
		.option("-v, --verbose", "Show verbose output")
		.option("--config <dir>", "configuration directory")
		.action(async () => {
			const { checkForUpdates } = await import("./commands/update");
			ctx.exitCode = await checkForUpdates({
				verbose: updateCmd.opts().verbose === true,
			});
		});

	program
		.command("version")
		.description("Show Cline CLI version number")
		.action(async () => {
			const { showVersion } = await import("./commands/help");
			showVersion();
			ctx.exitCode = 0;
		});

	program
		.command("kanban")
		.description("Run the kanban app")
		.action(async () => {
			const { launchKanban } = await import("./commands/kanban");
			ctx.exitCode = await launchKanban({
				preferredInstaller: getPreferredKanbanInstaller(),
			});
		});

	try {
		await program.parseAsync(normalizedArgs, { from: "user" });
	} catch (err: unknown) {
		if (err instanceof CommanderError) {
			if (err.exitCode !== 0) {
				writeErr(err.message);
				process.exitCode = err.exitCode;
				return;
			}
			return;
		}
		throw err;
	}

	if (ctx.exitCode !== undefined) {
		process.exitCode = ctx.exitCode;
		return;
	}

	const rootOpts = program.opts<{
		kanban?: boolean;
		tui?: boolean;
		update?: boolean;
		verbose?: boolean;
	}>();
	if (rootOpts.update) {
		if (rootOpts.kanban || rootOpts.tui || program.args.length > 0) {
			writeErr("Use --update without a prompt or task flags.");
			process.exitCode = 1;
			return;
		}
		const { checkForUpdates } = await import("./commands/update");
		process.exitCode = await checkForUpdates({
			verbose: rootOpts.verbose === true,
		});
		return;
	}
	if (rootOpts.kanban) {
		if (rootOpts.tui) {
			writeErr("Use either --kanban or --tui, not both.");
			process.exitCode = 1;
			return;
		}
		if (program.args.length > 0) {
			writeErr("Use --kanban without a prompt.");
			process.exitCode = 1;
			return;
		}
		const { launchKanban } = await import("./commands/kanban");
		process.exitCode = await launchKanban({
			preferredInstaller: getPreferredKanbanInstaller(),
		});
		return;
	}

	// Default flow: no subcommand matched, or fall-through from config/history.
	let args = commanderToParsedArgs(program);

	let startupTarget = ctx.startupTarget;
	let resumeSessionId: string | undefined;
	if (args.id !== undefined) {
		const sessionId = args.id.trim();
		if (!sessionId) {
			writeErr("--id requires <session-id>");
			process.exitCode = 1;
			return;
		}
		resumeSessionId = sessionId;
		startupTarget = "chat";
		process.env.CLINE_HOOK_AGENT_RESUME = "1";
	} else {
		delete process.env.CLINE_HOOK_AGENT_RESUME;
	}
	if (startupTarget) {
		args = {
			...args,
			interactive: true,
			prompt: undefined,
		};
	}

	if (args.invalidThinkingLevel) {
		writeErr(
			`invalid thinking level "${args.invalidThinkingLevel}" (expected "none", "low", "medium", "high", or "xhigh")`,
		);
		process.exitCode = 1;
		return;
	}
	if (args.invalidCompactionMode) {
		writeErr(
			`invalid compaction mode "${args.invalidCompactionMode}" (expected ${CLI_COMPACTION_MODE_EXPECTED_TEXT})`,
		);
		process.exitCode = 1;
		return;
	}
	if (args.invalidAutoApprove) {
		writeErr(
			`invalid auto-approve value "${args.invalidAutoApprove}" (expected "true" or "false")`,
		);
		process.exitCode = 1;
		return;
	}
	if (args.invalidTimeoutSeconds) {
		writeErr(
			`invalid timeout "${args.invalidTimeoutSeconds}" (expected integer >= 1)`,
		);
		process.exitCode = 1;
		return;
	}
	// Fails the run rather than warning, unlike --retries above. The mode decides
	// whether the model may finish without checking an edit, so a typo that fell
	// back to the default would produce a run that looks like the mode was in
	// force and is not -- and in an unattended loop nobody reads the warning.
	if (args.invalidEditVerification) {
		writeln(
			`invalid --edit-verification "${args.invalidEditVerification}" (expected off, nudge or require)`,
		);
		process.exitCode = 1;
		return;
	}
	// Fails hardest of these. A run the user believes is transactional and is
	// not leaves a failed attempt's edits on disk under a report that says they
	// were put back, which is worse than either doing it or not doing it.
	if (args.invalidAtomic) {
		writeln(
			`invalid --atomic "${args.invalidAtomic}" (expected off, auto or always)`,
		);
		process.exitCode = 1;
		return;
	}
	// A pattern that will not compile fails every check it is given, so the run
	// would do all of its work and then throw it away.
	if (args.invalidOracleExpect) {
		writeln(
			`invalid --oracle-expect "${args.invalidOracleExpect}" (not a regular expression)`,
		);
		process.exitCode = 1;
		return;
	}
	// Fails for the same reason as `--atomic`: the two verdicts this chooses
	// between are not close, and a run that silently used the other one is a
	// measurement of the wrong thing that reads exactly like the right one.
	if (args.invalidProposeCheck) {
		writeln(
			`invalid --propose-check "${args.invalidProposeCheck}" (expected off or auto)`,
		);
		process.exitCode = 1;
		return;
	}
	for (const [flag, value] of [
		["--max-changes", args.invalidMaxChanges],
		["--max-transactions", args.invalidMaxTransactions],
	] as const) {
		if (value) {
			writeln(
				`invalid ${flag} "${value}" (expected a whole number, 1 or more)`,
			);
			process.exitCode = 1;
			return;
		}
	}
	// Fails for the same reason: a run that keeps no checklist because the switch
	// was misspelled is indistinguishable from one that keeps none because it was
	// asked not to.
	if (args.invalidTaskProgress) {
		writeln(
			`invalid --task-progress "${args.invalidTaskProgress}" (expected on or off)`,
		);
		process.exitCode = 1;
		return;
	}
	if (args.invalidTaskProgressInterval) {
		writeln(
			`invalid --task-progress-interval "${args.invalidTaskProgressInterval}" (expected integer >= 0)`,
		);
		process.exitCode = 1;
		return;
	}
	if (args.invalidRetries) {
		writeln(
			`${c.dim}[warn] ignoring invalid --retries value "${args.invalidRetries}" (expected integer >= 1)${c.reset}`,
		);
	}
	if (args.hooksDir?.trim()) {
		process.env.CLINE_HOOKS_DIR = args.hooksDir.trim();
	}
	if (args.prompt && !args.interactive) {
		if (program.args.length > 1 || !promptArgLooksQuoted(program.args[0])) {
			writePromptArgError(program.args);
			process.exitCode = 1;
			return;
		}
	}
	setCurrentOutputMode(args.outputMode);

	if (args.outputMode === "json" && (args.interactive || !args.prompt)) {
		writeErr(
			"JSON output mode requires a prompt argument or piped stdin (interactive mode is unsupported)",
		);
		process.exitCode = 1;
		return;
	}

	// ACP mode: mutually exclusive with interactive/piped modes.
	// Enters the Agent Client Protocol stdio transport and never falls through.
	if (args.acpMode) {
		const { runAcpMode } = await import("./acp/index");
		// Only an explicit `--auto-approve true` (or `--yolo`) enables
		// auto-approval in ACP mode; We do not respect the default to
		// avoid accidental auto-approval in ACP mode.
		await runAcpMode({ autoApproveTools: args.autoApproveOverride === true });
		return;
	}

	if (args.worktree) {
		if (
			!args.prompt &&
			!resumeSessionId &&
			!stdinHasPipedInput() &&
			!isFullTTY
		) {
			writeErr("--worktree without a prompt requires an interactive terminal.");
			process.exitCode = 1;
			return;
		}
		if (resumeSessionId) {
			const { getSessionRow } = await import("./session/session");
			const session = await getSessionRow(resumeSessionId);
			if (!session) {
				writeErr(`Session not found: ${resumeSessionId}`);
				process.exitCode = 1;
				return;
			}
		}
		const { createTaskWorktree } = await import("./utils/worktree");
		const sourceCwd = args.cwd ?? process.cwd();
		const result = await createTaskWorktree({ cwd: sourceCwd });
		if (!result.success || !result.path) {
			writeErr(`--worktree failed: ${result.message}`);
			process.exitCode = 1;
			return;
		}
		writeln(`Created worktree at ${result.path}`);
		args = {
			...args,
			cwd: result.path,
		};
	}

	const cwd = args.cwd ?? process.cwd();
	const workspaceRoot = resolveWorkspaceRoot(cwd);
	// Sandbox mode is enabled implicitly whenever --data-dir is provided, or
	// when CLINE_SANDBOX=1 is set in the environment (in which case the data
	// dir falls back to $CLINE_SANDBOX_DATA_DIR or /tmp/cline-sandbox).
	const sandboxEnabled =
		!!args.dataDir || process.env.CLINE_SANDBOX?.trim() === "1";
	const sandboxDataDir = configureSandboxEnvironment({
		enabled: sandboxEnabled,
		cwd,
		explicitDir: args.dataDir,
	});

	// Keep command-style subcommands on a narrow path. Runtime-only imports pull
	// in provider resolution, config services, and session startup wiring that
	// should only load when the CLI is actually starting an agent session.
	const providerSettingsManager = await createProviderSettingsManager();
	const {
		coreServer,
		coreServer: {
			createUserInstructionConfigService,
			createPromptTemplateHooks,
		},
		resolveSystemPrompt,
		ideName,
		resolveCliPromptTemplate,
		createCliHostTools,
		runAgent,
	} = await loadCliRuntimeModules();

	// General settings toggled in the TUI /settings panel persist to the
	// global settings file; explicit CLI flags take precedence over the
	// persisted values, which in turn override the built-in defaults.
	const persistedGlobalSettings = coreServer.readGlobalSettings();
	const defaultToolAutoApprove = true;
	const effectiveToolAutoApprove = resolveStartupToolAutoApprove(
		args,
		persistedGlobalSettings,
		defaultToolAutoApprove,
	);
	const toolPolicies: Record<string, ToolPolicy> = {
		"*": {
			autoApprove: effectiveToolAutoApprove,
		},
	};
	const effectiveMode = resolveStartupMode(args, persistedGlobalSettings);
	const effectiveCompactionMode = resolveStartupCompactionMode(
		args,
		persistedGlobalSettings,
	);

	// Register the SDK early logger as early as possible — before any
	// provider settings reads — so the full startup sequence is captured.
	// These components operate before/outside ClineCore sessions, so the
	// session-scoped logger can't reach them.
	const { createCliLoggerAdapter } = await import("./logging/adapter");
	const loggerAdapter = createCliLoggerAdapter({
		runtime: "cli",
		component: "main",
	});
	coreServer.setSdkLogger(loggerAdapter.core);

	const userInstructionService = createUserInstructionConfigService({
		skills: {
			workspacePath: workspaceRoot,
			includePluginSkills: true,
			cwd,
		},
		rules: { workspacePath: workspaceRoot },
		workflows: { workspacePath: workspaceRoot },
	});
	await userInstructionService.start().catch(() => {});
	let userInstructionServiceDisposed = false;
	const stopUserInstructionService = () => {
		if (userInstructionServiceDisposed) {
			return;
		}
		userInstructionServiceDisposed = true;
		userInstructionService.stop();
	};
	registerDisposable(stopUserInstructionService);
	try {
		const persistedClineAccountId = providerSettingsManager
			.getProviderSettings("cline")
			?.auth?.accountId?.trim();
		if (persistedClineAccountId) {
			setCliFeatureFlagsAccountContext({ id: persistedClineAccountId });
		}
		refreshCliFeatureFlagsInBackground();
		const lastUsedProviderSettings =
			providerSettingsManager.getLastUsedProviderSettings({
				isClinePassEnabled: true,
			});
		const provider = normalizeProviderId(
			args.provider?.trim() || lastUsedProviderSettings?.provider || "cline",
		);
		let selectedProviderSettings =
			providerSettingsManager.getProviderSettings(provider);

		// Apply locally persisted Cline account identity so subsequent events
		// (task.*, workspace.initialized) carry user_id when available.
		// Note: user.extension_activated fires anonymously earlier in startup
		// and cannot be retroactively updated; this is by design for
		// lightweight subcommand and pre-auth CLI flows. See CLINE-2406.
		if (provider === "cline") {
			const savedAuth = selectedProviderSettings?.auth;
			if (savedAuth?.accountId) {
				identifyTelemetryAccount({
					id: savedAuth.accountId,
					provider: "cline",
					organizationId: savedAuth.organizationId,
					organizationName: savedAuth.organizationName,
					memberId: savedAuth.memberId,
				});
			}
		}

		const persistedApiKey = getPersistedProviderApiKey(
			provider,
			selectedProviderSettings,
		);
		const providedApiKey = args.key?.trim() || undefined;
		let apiKey = providedApiKey || persistedApiKey || undefined;

		const isYoloMode = args.mode === "yolo";
		const isZenMode = args.mode === "zen";

		// In headless mode (yolo / json / piped stdin without --tui),
		// don't attempt browser-based OAuth. Authentication may still resolve at
		// runtime from environment-based provider auth or persisted OAuth tokens.
		const isHeadless =
			isYoloMode ||
			isZenMode ||
			args.outputMode === "json" ||
			(!process.stdin.isTTY && !args.interactive);
		const isInteractive = (args.interactive || !args.prompt) && !isHeadless;

		if (!apiKey && isOAuthProvider(provider) && !isHeadless && !isInteractive) {
			const oauthResult = await ensureOAuthProviderApiKey({
				providerId: provider,
				currentApiKey: apiKey,
				existingSettings: selectedProviderSettings,
				providerSettingsManager,
				io: { writeln, writeErr },
			});
			selectedProviderSettings =
				oauthResult?.selectedProviderSettings ?? selectedProviderSettings;
			apiKey = oauthResult?.apiKey ?? apiKey;
		}

		let knownModels: Config["knownModels"];
		try {
			const persistedProviderConfig = providerSettingsManager.getProviderConfig(
				provider,
				{
					includeKnownModels: false,
				},
			);
			const catalogOptions = isInteractive
				? {
						loadLatestOnInit: true,
						loadPrivateOnAuth: true,
						failOnError: false,
					}
				: undefined;
			const resolvedProviderConfig = await coreServer.resolveProviderConfig(
				provider,
				catalogOptions,
				persistedProviderConfig,
			);
			knownModels = resolvedProviderConfig?.knownModels;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeln(
				`${c.dim}[model-catalog] catalog resolution failed (${message})${c.reset}`,
			);
		}
		const knownModelIds = knownModels
			? Object.keys(filterChatModels(knownModels))
			: [];
		const resolvedModelId =
			args.model ??
			selectedProviderSettings?.model ??
			knownModelIds[0] ??
			"anthropic/claude-sonnet-4.6";
		// Give the session the window the model was actually built with.
		//
		// A local Ollama model is discovered from `/api/tags`, which reports
		// names only, so it has no catalog entry and `model.info` is undefined
		// for it. Everything downstream then falls back to its own default —
		// compaction to `DEFAULT_MAX_INPUT_TOKENS` (128k), and the preserve-recent
		// ladder to the window it scales against. Measured before this: the
		// server was sent `num_ctx=32768` while compaction sized itself to
		// 128,000, so it never triggered and Ollama silently truncated the
		// prompt instead — turns pinned at 32,674 of a 32,768 window with not one
		// compaction logged.
		//
		// The two numbers have to be the same number. This is the same fix as the
		// one in the Ollama vendor, applied to the other consumer.
		let declaredOllamaWindow: number | undefined;
		if (provider === "ollama") {
			const ollamaBaseUrl = selectedProviderSettings?.baseUrl as
				| string
				| undefined;
			const { primeDeclaredNumCtx, readDeclaredNumCtx } = await import(
				"@cline/core"
			);
			await primeDeclaredNumCtx(ollamaBaseUrl, resolvedModelId, fetch);
			const declared = readDeclaredNumCtx(ollamaBaseUrl, resolvedModelId);
			declaredOllamaWindow = declared;
			if (declared !== undefined) {
				knownModels = {
					...knownModels,
					[resolvedModelId]: {
						...(knownModels?.[resolvedModelId] ?? {}),
						id: resolvedModelId,
						contextWindow: declared,
						// Cleared, not set. `resolveEffectiveMaxInputTokens` takes
						// `min(maxInputTokens, contextWindow)` when it has both, so a
						// stale catalog figure would quietly cap the window the model
						// just declared. With only the window it derives the input
						// budget as `window * 0.9`, which is the intended share —
						// setting this to the window instead would overstate it.
						maxInputTokens: undefined,
					},
				};
			}
		}
		const resolvedReasoning = resolveCliReasoning({
			thinking: args.thinking,
			thinkingExplicitlySet: args.thinkingExplicitlySet,
			reasoningEffort: args.reasoningEffort,
			persistedReasoning: selectedProviderSettings?.reasoning,
		});
		const cliBuildInfo = getCliBuildInfo();
		const { createCliLoggerAdapter } = await import("./logging/adapter");
		const loggerAdapter = createCliLoggerAdapter({
			runtime: "cli",
			component: "main",
		});
		loggerAdapter.core.log("CLI run started", {
			interactive: args.interactive === true,
			hasPrompt: !!args.prompt?.trim(),
			cwd,
		});
		if (declaredOllamaWindow !== undefined) {
			// Stated because it is otherwise invisible: nothing else reports which
			// window compaction is sizing itself against, and a wrong one shows up
			// only as a prompt the server quietly truncated.
			loggerAdapter.core.log(
				`Using the context window ${resolvedModelId} declares: ${declaredOllamaWindow}`,
				{ modelId: resolvedModelId, contextWindow: declaredOllamaWindow },
			);
		}

		// The prompt template this session runs on, resolved once and applied
		// twice: its `# system` section becomes the base prompt, and its tool
		// sections replace the descriptions the tools carry in code. The extension
		// has done both since templates existed and this host did neither, so the
		// same model read a different prompt, and a different description of every
		// tool, depending on which host started it.
		const renderedTemplate = resolveCliPromptTemplate({
			providerId: provider,
			modelId: resolvedModelId,
			workspaceRoot,
			baseUrl: selectedProviderSettings?.baseUrl as string | undefined,
			log: (message) => loggerAdapter.core.log(message),
			// `BasicLogger` folds non-error warnings into `log` by design, and a
			// template that could not be read is operational rather than fatal: the
			// session continues on the built-in prompt. The message says which.
			warn: (message) => loggerAdapter.core.log(message),
		});

		const config: Config = {
			providerId: provider,
			modelId: resolvedModelId,
			apiKey: apiKey ?? "",
			knownModels,
			systemPrompt: await resolveSystemPrompt({
				cwd,
				explicitSystemPrompt: args.systemPrompt,
				providerId: provider,
				mode: effectiveMode,
				basePrompt: renderedTemplate?.system,
			}),
			execution: {
				// 6, which is what `--retries` has always documented. The code said
				// 3, so every run that did not pass the flag got half the budget the
				// help text promised.
				maxConsecutiveMistakes: args.retries ?? 6,
			},
			// Mode only, and only when asked for. The host adds its own checker and
			// already defaults `checkTools` to it, so naming the tool here would
			// duplicate a default that can drift out from under this file.
			...(args.editVerification
				? { editVerification: { mode: args.editVerification } }
				: {}),
			// Sent whenever any of it was asked for, not only on `--atomic`: an
			// oracle named without a mode is a user who wants the check and has
			// not said how hard, and `auto` is the answer to that. Naming one and
			// getting nothing would be the quiet failure again.
			...(args.atomic || args.oracle || args.proposeCheck
				? {
						atomicProtocol: {
							mode: args.atomic ?? "auto",
							...(args.oracle ? { oracleCommand: args.oracle } : {}),
							...(args.oracleExpect ? { oracleExpect: args.oracleExpect } : {}),
							...(args.maxChanges ? { maxChanges: args.maxChanges } : {}),
							...(args.maxTransactions
								? { maxTransactions: args.maxTransactions }
								: {}),
							// There is nobody here to ask, so the default is the
							// verdict a host without a user has always had: the
							// model's own account of its work. `auto` is the other
							// one, and it says so -- an approved check is run
							// repeatedly and unattended, and this approves it
							// sight unseen, which only an operator running a
							// batch can reasonably ask for.
							proposeCheck: args.proposeCheck === "auto",
							...(args.proposeCheck === "auto"
								? { approveCheck: approveAnyProposedCheck }
								: {}),
						},
					}
				: {}),
			// On unless asked otherwise, which is what the extension does. Left
			// unset until now, and unset is not "off with the same effect": the
			// host reads `enabled` to decide whether to build the tracker at
			// all, so the CLI shipped without the `task_progress` tool, without
			// the parameter it adds to every other tool, without the reminder
			// and without the close-out guard -- while the prompt still told the
			// model to keep a checklist.
			taskProgress: {
				enabled: args.taskProgress !== "off",
				...(args.taskProgressInterval !== undefined
					? { reminderInterval: args.taskProgressInterval }
					: {}),
			},
			// What the extension gets from the editor's language servers and this
			// host has no way to ask for. Named, `check_file` runs it and says it
			// is the linter; unnamed, it stays the syntax check it honestly is.
			...(args.lintCommand?.trim()
				? { checkFile: { lintCommand: args.lintCommand.trim() } }
				: {}),
			// The other half of the template: `# tool:` sections replace the
			// description each tool carries in code. Without this the model is told
			// what `editor` does by the SDK's own wording while the plugin tells it
			// the family-tuned one, so the two hosts describe the same tool
			// differently to the same model.
			// `ideName` is what `{{IDE_NAME}}` resolves to in a `# tool:`
			// section, so a description that names the host names this one
			// rather than an IDE that is not here.
			hooks: createPromptTemplateHooks({
				rendered: renderedTemplate,
				ideName,
			}),
			// Kept so every later rebuild of the system prompt -- a plan/act
			// switch, the connector path -- starts from the same template.
			promptTemplateSystem: renderedTemplate?.system,
			// The two tools this host had no answer for, and the last of the gap
			// with the extension. `browser` says whether a page actually runs;
			// `code_intel` asks the language servers what a symbol means. Both
			// take their host half as an injected interface, and neither starts
			// anything until the model calls it: Chrome is launched on the first
			// `open`, a language server on the first question about a file it
			// serves.
			extraTools: createCliHostTools({
				cwd,
				onError: (message, error) =>
					loggerAdapter.core.log(
						`${message}: ${error instanceof Error ? error.message : String(error)}`,
					),
			}),
			checkpoint: CLI_DEFAULT_CHECKPOINT_CONFIG,
			compaction: buildCliCompactionConfig(effectiveCompactionMode),
			timeoutSeconds: args.timeoutSeconds,
			sandbox: sandboxEnabled,
			sandboxDataDir,
			verbose: args.verbose,
			thinking: resolvedReasoning.thinking,
			reasoningEffort: resolvedReasoning.reasoningEffort,
			outputMode: args.outputMode,
			mode: effectiveMode,
			logger: loggerAdapter.core,
			loggerConfig: loggerAdapter.runtimeConfig,
			telemetry: getCliTelemetryService(loggerAdapter.core),
			defaultToolAutoApprove,
			toolPolicies,
			enableSpawnAgent: !isYoloMode,
			enableAgentTeams: !isYoloMode,
			enableTools: true,
			cwd,
			workspaceRoot,
			extensionContext: {
				client: {
					name: "cline-cli",
					version: cliBuildInfo.version,
					platform: "cli",
					platformVersion: cliBuildInfo.version,
					isMultiRoot: false,
				},
				workspace: {
					rootPath: workspaceRoot,
					cwd,
					workspaceName: basename(cwd),
					ide: "Terminal Shell",
					platform: process.platform,
				},
				logger: loggerAdapter.core,
			},
			teamName: !isYoloMode ? args.teamName?.trim() || undefined : undefined,
		};
		// A vision model means the session's model is not meant to see the image at
		// all, whether or not it could have — the same rule the extension applies.
		// Installed after `config` is built because the describer is made from the
		// session's own provider settings with the model id swapped.
		const visionModelId = args.visionModel?.trim();
		if (visionModelId) {
			const { createCliImageDescriber } = await import("./runtime/vision");
			config.describeImages = createCliImageDescriber(
				config,
				visionModelId,
				loggerAdapter.core,
			);
			config.alwaysDescribeImages = true;
			loggerAdapter.core.log(
				`[Vision] Describer installed: provider=${provider} model=${visionModelId}`,
			);
		}
		// Delegated agents on a model of their own. The same shape the extension's
		// Agents tab produces, read at the same place in core: only the fields
		// named here replace the session's, so an agents model given without a
		// window keeps the session's sampler and takes whatever window that model
		// declares for itself.
		const agentsModelId = args.agentsModel?.trim();
		if (agentsModelId) {
			const requested = Number(args.agentsNumCtx);
			const contextWindow =
				Number.isFinite(requested) && requested > 0
					? Math.floor(requested)
					: undefined;
			config.delegatedAgentConnection = {
				providerId: config.providerId,
				modelId: agentsModelId,
				...(config.apiKey ? { apiKey: config.apiKey } : {}),
				...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
				providerConfig: {
					...((config.providerConfig as Record<string, unknown> | undefined) ??
						{}),
					modelId: agentsModelId,
					...(contextWindow ? { contextWindow } : {}),
				},
			} as NonNullable<(typeof config)["delegatedAgentConnection"]>;
			loggerAdapter.core.log(
				`[Agents] Delegated agents configured: provider=${provider} model=${agentsModelId}` +
					(contextWindow ? ` contextWindow=${contextWindow}` : ""),
			);
		}
		// A configured subagent may name a provider of its own. Core refuses one
		// it cannot resolve rather than running it on the session's connection,
		// so this is what makes a second provider work at all.
		const { createAgentProviderConnectionResolver } = await import(
			"./runtime/agent-provider-connection"
		);
		config.resolveProviderConnection = createAgentProviderConnectionResolver(
			providerSettingsManager,
		);
		// How many agents this endpoint will actually serve at once. A server with
		// no free slot queues the request rather than refusing it, so spawning
		// more agents than there are slots makes a run slower, not faster — and
		// nothing reports the queueing. Asked of the endpoint the agents call.
		const agentSlots = await resolveAgentSlotLimit({
			providerId:
				config.delegatedAgentConnection?.providerId ?? config.providerId,
			baseUrl: config.delegatedAgentConnection?.baseUrl ?? config.baseUrl,
			parallelSessions: args.parallelSessions,
		});
		config.maxConcurrentAgents = agentSlots.limit;
		// QA credentials named on the command line, read from this process's
		// environment. Names only in the log — the values exist in exactly two
		// places, this environment and the child of a command that asked.
		const { resolveQaCredentialsFromEnv } = await import(
			"./runtime/qa-credentials"
		);
		const qaCredentials = resolveQaCredentialsFromEnv(args.qaCredential);
		if (qaCredentials.credentials.length > 0) {
			config.qaCredentials = qaCredentials.credentials;
		}
		for (const note of qaCredentials.notes) {
			loggerAdapter.core.log(`[QaCredentials] ${note}`);
		}
		loggerAdapter.core.log(
			`[Agents] Concurrency: ${
				agentSlots.limit === 0 ? "uncapped" : agentSlots.limit
			} — ${agentSlots.reason}`,
		);
		try {
			// For OAuth providers, don't write the resolved key into apiKey;
			// the token lives in auth.accessToken and apiKey is reserved for
			// migrated/manual keys.
			const persistApiKey =
				// Persist explicit `-k/--key` even for OAuth-capable providers.
				providedApiKey
					? { apiKey: providedApiKey }
					: apiKey && !isOAuthProvider(provider)
						? { apiKey }
						: {};
			providerSettingsManager.saveProviderSettings({
				...(selectedProviderSettings ?? {}),
				provider,
				model: config.modelId,
				...persistApiKey,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeln(
				`${c.dim}[provider-settings] failed to persist selection (${message})${c.reset}`,
			);
		}
		// Check for piped input (skip when stdin is not a real pipe/file, e.g. headless CI).
		// Guard `isTTY` first so we never block on fd 0 when stdin is a terminal (and avoid
		// redundant fstat work). `stdinHasPipedInput` also checks `isTTY`, but callers may hit
		// inconsistent state in tests or embedded hosts.
		if (!process.stdin.isTTY && stdinHasPipedInput() && !args.interactive) {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(chunk as Buffer);
			}
			const pipedInput = Buffer.concat(chunks).toString("utf-8").trim();

			if (pipedInput) {
				const prompt = args.prompt
					? `${args.prompt}\n\n${pipedInput}`
					: pipedInput;
				const rewrittenTeamPrompt = rewriteTeamPrompt(prompt);
				if (rewrittenTeamPrompt.kind === "usage") {
					writeln(TEAM_COMMAND_USAGE);
					return;
				}
				const pipedEffectivePrompt =
					rewrittenTeamPrompt.kind === "rewritten"
						? rewrittenTeamPrompt.prompt
						: prompt;
				if (isZenMode) {
					const { runZen } = await import("./runtime/run-zen");
					await runZen(pipedEffectivePrompt, config, userInstructionService);
					return;
				}
				await runAgent(pipedEffectivePrompt, config, userInstructionService);
				return;
			}
		}

		// Interactive mode: zen is incompatible because there is no terminal UI
		// to surface results and nothing waits for the background task.
		if (args.interactive || !args.prompt) {
			if (isZenMode) {
				writeErr(
					args.interactive
						? "--zen is not compatible with interactive mode."
						: "--zen requires a prompt.",
				);
				process.exitCode = 1;
				return;
			}
			const runInteractive = await loadInteractiveRuntimeModule();
			const initialClineProviderSettings =
				provider === "cline" ? selectedProviderSettings : undefined;
			let initialNotice:
				| import("./kanban-migration/notice").CliMigrationNotice
				| undefined;
			let markInitialNoticeShown:
				| ((
						notice: import("./kanban-migration/notice").CliMigrationNotice,
				  ) => void)
				| undefined;
			if (
				!startupTargetTakesPrecedenceOverMigrationNotice(startupTarget) &&
				isFullTTY
			) {
				const { getClineCliMigrationNotice, markClineCliMigrationNoticeShown } =
					await import("./kanban-migration/notice");
				initialNotice = getClineCliMigrationNotice(undefined, process.env, {
					activeProviderId: provider,
				});
				if (initialNotice) {
					markInitialNoticeShown = () => {
						markClineCliMigrationNoticeShown();
					};
				}
			}
			await runInteractive(config, userInstructionService, resumeSessionId, {
				initialPrompt: args.prompt,
				clineApiBaseUrl: initialClineProviderSettings?.baseUrl,
				clineProviderSettings: initialClineProviderSettings,
				startupTarget,
				initialNotice,
				onInitialNoticeShown: markInitialNoticeShown,
			});
			return;
		}

		// Single prompt mode
		const rewrittenTeamPrompt = rewriteTeamPrompt(args.prompt);
		if (rewrittenTeamPrompt.kind === "usage") {
			writeln(TEAM_COMMAND_USAGE);
			return;
		}
		const effectivePrompt =
			rewrittenTeamPrompt.kind === "rewritten"
				? rewrittenTeamPrompt.prompt
				: args.prompt;

		// Zen mode: dispatch the task to the background hub and exit. The CLI
		// does not stay connected to stream output; completion is delivered via
		// the hub's existing ui.notify broadcast (picked up by the menubar app
		// when installed).
		if (isZenMode) {
			const { runZen } = await import("./runtime/run-zen");
			await runZen(effectivePrompt, config, userInstructionService);
			return;
		}

		await runAgent(effectivePrompt, config, userInstructionService);
		// Exit once agent is done in non-interactive mode
		return;
	} finally {
		stopUserInstructionService();
	}
}
