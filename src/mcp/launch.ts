import { execFile, spawn } from "child_process";
import type { ChildLike } from "./stdioTransport";
import { type LaunchRequest, fallbackPathDirs, parseMarkedValue } from "./spawnPlan";

/**
 * The only file in the plugin that imports child_process, and it does so by the bare name "child_process". Desktop only: McpService
 * never calls anything here unless Platform.isDesktopApp is true. Everything that decides what to run lives in spawnPlan.ts.
 */

const MARKER = "__ASKMATE_PATH__";
/** Constant script, no user input. A GUI-launched Obsidian does not inherit the PATH from the user's shell profile. */
const PRINT_PATH = `printf '%s' '${MARKER}'"$PATH"'${MARKER}'`;
const KNOWN_SHELL = /^\/(?:bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)\/(?:zsh|bash)$/;
const LOGIN_SHELL_TIMEOUT_MS = 5000;

/** Runs a login shell and returns its stdout, or an empty string when it fails. Injected in tests. */
export type ShellRunner = (shell: string, args: readonly string[]) => Promise<string>;

export const runLoginShell: ShellRunner = (shell, args) =>
	new Promise<string>((resolve) => {
		execFile(shell, [...args], { timeout: LOGIN_SHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
			resolve(error ? "" : stdout);
		});
	});

/**
 * The PATH a terminal would have, plus well-known install folders, so `npx`, `uvx` and `bun` are found when Obsidian was started
 * from the Dock or the Start menu. Only a shell in a known system folder is run, with a fixed script.
 */
export async function resolveLoginPath(
	platform: NodeJS.Platform,
	processEnv: Readonly<Record<string, string | undefined>>,
	run: ShellRunner = runLoginShell
): Promise<string | null> {
	const home = processEnv.HOME ?? "";
	const fallback = fallbackPathDirs(platform, home).join(":");
	const shell = processEnv.SHELL ?? "";
	if (platform === "win32" || !KNOWN_SHELL.test(shell)) {
		return fallback || null;
	}
	const fromShell = parseMarkedValue(await run(shell, ["-ilc", PRINT_PATH]), MARKER);
	return [fromShell, fallback].filter((part): part is string => Boolean(part)).join(":") || null;
}

/** Starts the server process: no shell, an argument array, and only the environment McpService built. */
export function spawnChild(request: LaunchRequest): ChildLike {
	const child = spawn(request.plan.file, [...request.plan.args], {
		env: { ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
		windowsHide: true,
		windowsVerbatimArguments: request.plan.windowsVerbatimArguments
	});
	// Decode as UTF-8 across chunk boundaries. Without this a multi-byte character split between two reads is corrupted.
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	return child;
}
