import { McpClientError } from "./protocol";

/** Pure launch planning for stdio servers. The only place that decides how a user-supplied command line becomes a process. */

export interface StdioServerConfig {
	readonly command: string;
	readonly args: readonly string[];
	/** Extra variables for this server only. Secret values are resolved by the caller just before spawning. */
	readonly env: Readonly<Record<string, string>>;
}

export interface SpawnPlan {
	readonly file: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments: boolean;
}

/** What the process launcher receives. The plan says what to run and `env` is the complete environment. Nothing is inherited. */
export interface LaunchRequest {
	readonly plan: SpawnPlan;
	readonly env: Readonly<Record<string, string>>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** cmd.exe re-parses these even inside a verbatim command line, so they are refused rather than escaped. */
const CMD_METACHARACTERS = /[&|<>^%!"\r\n]/;
/** Package runners that Windows ships as .cmd shims. A bare name does not spawn without a shell since CVE-2024-27980. */
const WINDOWS_SHIMS = new Set(["npx", "npm", "pnpm", "yarn", "uvx", "bunx"]);

export function validateStdioConfig(config: StdioServerConfig): void {
	if (!config.command.trim() || /[\0\r\n]/.test(config.command)) {
		throw new McpClientError("unsupported", "The server command is empty or contains a control character.");
	}
	if (config.args.some((arg) => arg.includes("\0"))) {
		throw new McpClientError("unsupported", "A server argument contains a NUL character.");
	}
	const badName = Object.keys(config.env).find((name) => !ENV_NAME.test(name));
	if (badName !== undefined) {
		throw new McpClientError("unsupported", `"${badName}" is not a valid environment variable name.`);
	}
	if (Object.values(config.env).some((value) => value.includes("\0"))) {
		throw new McpClientError("unsupported", "An environment value contains a NUL character.");
	}
}

function isWindowsShim(command: string): boolean {
	return /\.(cmd|bat)$/i.test(command) || WINDOWS_SHIMS.has(command.toLowerCase());
}

export function planSpawn(config: StdioServerConfig, platform: NodeJS.Platform): SpawnPlan {
	validateStdioConfig(config);
	if (platform !== "win32" || !isWindowsShim(config.command)) {
		return { file: config.command, args: config.args, windowsVerbatimArguments: false };
	}
	const parts = [config.command, ...config.args];
	if (parts.some((part) => CMD_METACHARACTERS.test(part))) {
		throw new McpClientError(
			"unsupported",
			"On Windows this command runs through cmd.exe, which cannot safely take & | < > ^ % ! or quotes. Point the command at node.exe and the script path instead."
		);
	}
	// cmd resolves a bare "npx" or "uvx" through PATHEXT (npx.cmd, uvx.exe), so no extension is guessed here.
	const quoted = parts.map((part) => (/\s/.test(part) ? `"${part}"` : part));
	return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${quoted.join(" ")}"`], windowsVerbatimArguments: true };
}

/** A small allow-list instead of the whole process environment, so a launched server never inherits unrelated secrets. */
const BASE_ENV_NAMES: readonly string[] = [
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
	"SystemRoot", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"
];

export function buildChildEnv(
	processEnv: Readonly<Record<string, string | undefined>>,
	loginPath: string | null,
	serverEnv: Readonly<Record<string, string>>
): Record<string, string> {
	// Windows spells it "Path", and a plain copy of process.env keeps that spelling, so fall back to a case-insensitive match.
	const keys = Object.keys(processEnv);
	const base = Object.fromEntries(
		BASE_ENV_NAMES.flatMap((name) => {
			const key = processEnv[name] !== undefined ? name : keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
			const value = key === undefined ? undefined : processEnv[key];
			return key === undefined || value === undefined ? [] : [[key, value] as const];
		})
	);
	return { ...base, ...(loginPath ? { PATH: loginPath } : {}), ...serverEnv };
}

/** Extracts PATH from `$SHELL -ilc` output wrapped in markers, so rc-file noise on stdout cannot corrupt it. */
export function parseMarkedValue(stdout: string, marker: string): string | null {
	const start = stdout.indexOf(marker);
	const end = stdout.lastIndexOf(marker);
	if (start === -1 || end <= start) {
		return null;
	}
	const value = stdout.slice(start + marker.length, end).trim();
	return value.length > 0 ? value : null;
}

export function fallbackPathDirs(platform: NodeJS.Platform, home: string): string[] {
	if (platform === "win32") {
		return [];
	}
	return [
		"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
		`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`, `${home}/.volta/bin`
	];
}

function basename(command: string): string {
	return (command.split(/[\\/]/).pop() ?? command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "powershell", "pwsh"]);
const SHELL_COMMAND_FLAGS = /^(?:-[a-z]*c[a-z]*|\/c|\/k|-command|-encodedcommand|-e|-ec)$/i;
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl", "php"]);
const EVAL_FLAGS = new Set(["-e", "-c", "--eval", "--print", "-p", "eval"]);
const DANGEROUS_COMMANDS = new Set(["sudo", "su", "doas", "rm", "rmdir", "dd", "mkfs", "curl", "wget", "nc", "ncat", "scp", "ssh"]);
const LOADER_ENV = /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|BASH_ENV|ENV)$/;

/**
 * True when npx is told to run a command string (`-c`, `--call`). Only options before the package matter: after it, a flag such as
 * `-c config.json` belongs to the server being started. `-p` and `--package` take a value, which must not end the scan early.
 */
function npxRunsCommand(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-c" || arg === "--call" || arg.startsWith("--call=")) {
			return true;
		}
		if (arg === "-p" || arg === "--package") {
			index += 1;
		} else if (!arg.startsWith("-")) {
			return false;
		}
	}
	return false;
}

/**
 * Advisory warnings for the trust dialog. This is a hint for the person reading it and not a security boundary: argument
 * injection forms such as `npx -c` cannot be enumerated, which is why every launch needs explicit device-local trust.
 */
export function findCommandRisks(config: { readonly command: string; readonly args: readonly string[]; readonly envNames: readonly string[] }): string[] {
	const name = basename(config.command);
	const risks: string[] = [];
	if (DANGEROUS_COMMANDS.has(name)) {
		risks.push(`runs "${name}", which can change files or send data off this computer`);
	}
	if (SHELLS.has(name) && config.args.some((arg) => SHELL_COMMAND_FLAGS.test(arg))) {
		risks.push("runs a shell command string");
	}
	if (INTERPRETERS.has(name) && config.args.some((arg) => EVAL_FLAGS.has(arg))) {
		risks.push("runs code given directly on the command line");
	}
	if ((name === "npx" || name === "pnpx") && npxRunsCommand(config.args)) {
		risks.push("npx -c runs an arbitrary command");
	}
	const loaderVariable = config.envNames.find((envName) => LOADER_ENV.test(envName));
	if (loaderVariable !== undefined) {
		risks.push(`sets ${loaderVariable}, which changes how programs load code`);
	}
	return risks;
}

/** The exact command as the person will see it: display only, never passed to a shell. */
export function formatCommandLine(command: string, args: readonly string[]): string {
	const quote = (part: string): string => (part === "" || /[\s"'\\$`]/.test(part) ? `"${part.replace(/(["\\$`])/g, "\\$1")}"` : part);
	return [command, ...args].map(quote).join(" ");
}
